"""Verify authenticated CI image identities across classic and containerd stores.

No build/pull/load/mutation is performed. The caller must authenticate/decrypt the
archive and verify its approved source head/tree before loading it.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys


def check(condition, message):
    if not condition:
        raise ValueError(message)


def digest_document(raw, expected):
    check(len(raw) <= 1024 * 1024, 'Identity document exceeds limit.')
    check('sha256:' + hashlib.sha256(raw).hexdigest() == expected, 'Content digest mismatch.')
    return json.loads(raw)


def verify_image(actual, expected, revision, read_content):
    check(actual['Os'] == expected['os'] == 'linux', 'Image OS mismatch.')
    check(actual['Architecture'] == expected['architecture'] == 'amd64', 'Image architecture mismatch.')
    check(actual['Config']['Labels']['org.opencontainers.image.revision'] == expected['revision'] == revision, 'Image revision mismatch.')
    if actual['Id'] == expected['imageId']:
        strategy = 'same-content-addressed-image-id'
    else:
        descriptor = actual.get('Descriptor', {})
        check(descriptor.get('digest') == actual['Id'], 'Loaded descriptor identity mismatch.')
        check(descriptor.get('mediaType') in ('application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'), 'Unsupported containerd descriptor.')
        manifest = digest_document(read_content(actual['Id']), actual['Id'])
        config_id = manifest.get('config', {}).get('digest')
        check(config_id == expected['imageId'], 'Loaded manifest does not reference the CI config digest.')
        config = digest_document(read_content(config_id), config_id)
        check(config.get('os') == 'linux' and config.get('architecture') == 'amd64', 'Config platform mismatch.')
        check(config.get('rootfs', {}).get('type') == 'layers', 'Unsupported root filesystem.')
        check(config['rootfs'].get('diff_ids') == actual.get('RootFS', {}).get('Layers'), 'Loaded filesystem layer digests differ.')
        check(config.get('config', {}).get('Labels', {}).get('org.opencontainers.image.revision') == revision, 'Config revision mismatch.')
        strategy = 'containerd-manifest-to-ci-config-and-rootfs-digests'
    # Size includes different storage overhead in Docker's two image stores. It is
    # diagnostic information, never the image's cryptographic identity.
    return {'role': expected['role'], 'strategy': strategy, 'ciImageId': expected['imageId'], 'loadedImageId': actual['Id'], 'ciSize': expected['size'], 'loadedSize': actual['Size']}


def command(args):
    return subprocess.check_output(args, timeout=30, stderr=subprocess.DEVNULL)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--source-head', required=True)
    parser.add_argument('--tree', required=True)
    args = parser.parse_args()
    check(sys.platform.startswith('linux'), 'Linux local Docker required.')
    check(all(not os.environ.get(key) for key in ('DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH')), 'Docker endpoint overrides forbidden.')
    check(all(re.fullmatch('[a-f0-9]{40}', value) for value in (args.source_head, args.tree)), 'Explicit source head and tree required.')
    path = Path(args.manifest)
    check(path.is_file() and path.stat().st_size <= 1024 * 1024, 'Invalid manifest file.')
    receipt = json.loads(path.read_bytes())
    check(receipt['schemaVersion'] == 1 and receipt['kind'] == 'ProductSpy-deployment-images' and receipt['publication'] == 'encrypted-ci-artifact', 'Invalid receipt type.')
    check(receipt['source']['headSha'] == args.source_head and receipt['checkout']['tree'] == args.tree, 'Unapproved source/tree.')
    revision = receipt['checkout']['sha']
    check(re.fullmatch('[a-f0-9]{40}', revision), 'Invalid checkout revision.')
    check(receipt['platform'] == {'os': 'linux', 'architecture': 'amd64'}, 'Platform mismatch.')
    images = receipt['images']
    check(len(images) == 2 and [i['role'] for i in images] == ['web', 'worker'], 'Both ordered business images required.')
    for image in images:
        check(image['tag'] == 'productspy-' + image['role'] + ':' + revision, 'Unexpected image tag.')
        check(re.fullmatch('sha256:[a-f0-9]{64}', image['imageId']), 'Invalid CI digest.')
    context = json.loads(command(['docker', 'context', 'inspect', 'default']))[0]
    check(context['Endpoints']['docker']['Host'] == 'unix:///var/run/docker.sock', 'Local default Docker socket required.')
    actual = json.loads(command(['docker', '--context', 'default', 'image', 'inspect'] + [i['tag'] for i in images]))
    check(len(actual) == 2, 'Loaded images missing.')

    def read_content(digest):
        check(re.fullmatch('sha256:[a-f0-9]{64}', digest), 'Invalid content digest.')
        return command(['ctr', '--address', '/run/containerd/containerd.sock', '--namespace', 'moby', 'content', 'get', digest])

    results = [verify_image(a, e, revision, read_content) for a, e in zip(actual, images)]
    print(json.dumps({'status': 'PASS', 'checkout': revision, 'images': results}))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Loaded image identity verification failed; no runtime configuration is printed.', file=sys.stderr)
        sys.exit(1)
