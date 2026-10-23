import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
spec = importlib.util.spec_from_file_location('verify_images', Path(__file__).with_name('verify-loaded-images.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
revision = 'a' * 40


def document(value):
    raw = json.dumps(value, separators=(',', ':')).encode()
    return 'sha256:' + hashlib.sha256(raw).hexdigest(), raw


class ImageIdentityTests(unittest.TestCase):
    def setUp(self):
        self.config = {'os':'linux', 'architecture':'amd64', 'rootfs':{'type':'layers','diff_ids':['sha256:'+'b'*64]},'config':{'Labels':{'org.opencontainers.image.revision':revision}}}
        self.config_id, config_raw = document(self.config)
        self.manifest_id, manifest_raw = document({'config':{'digest':self.config_id}})
        self.content = {self.config_id:config_raw,self.manifest_id:manifest_raw}
        self.expected = {'role':'web','imageId':self.config_id,'size':123,'os':'linux','architecture':'amd64','revision':revision}
        self.actual = {'Id':self.manifest_id,'Size':150,'Os':'linux','Architecture':'amd64','Config':self.config['config'],'RootFS':{'Layers':self.config['rootfs']['diff_ids']},'Descriptor':{'digest':self.manifest_id,'mediaType':'application/vnd.oci.image.manifest.v1+json'}}

    def verify(self):
        return module.verify_image(self.actual,self.expected,revision,self.content.__getitem__)

    def test_classic_same_digest_does_not_need_containerd(self):
        self.actual['Id']=self.config_id
        self.assertEqual(self.verify()['strategy'],'same-content-addressed-image-id')

    def test_containerd_verifies_manifest_config_and_layers_despite_size_overhead(self):
        self.assertEqual(self.verify()['strategy'],'containerd-manifest-to-ci-config-and-rootfs-digests')
        self.assertEqual(self.verify()['loadedSize'],150)

    def test_unrelated_config_is_rejected(self):
        self.expected['imageId']='sha256:'+'f'*64
        with self.assertRaisesRegex(ValueError,'CI config digest'):self.verify()

    def test_corrupted_content_is_rejected(self):
        self.content[self.config_id] += b' '
        with self.assertRaisesRegex(ValueError,'Content digest'):self.verify()

    def test_different_layers_are_rejected(self):
        self.actual['RootFS']['Layers']=[]
        with self.assertRaisesRegex(ValueError,'layer digests'):self.verify()

    def test_platform_revision_and_unlinked_descriptor_are_rejected(self):
        self.actual['Architecture']='arm64'
        with self.assertRaises(ValueError):self.verify()
        self.actual['Architecture']='amd64'
        self.actual['Descriptor']['digest']=self.config_id
        with self.assertRaises(ValueError):self.verify()


if __name__ == '__main__':unittest.main()
