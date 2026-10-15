/** Chrome accepts numeric update versions; the release label belongs in version_name.
 * Keep archives and service versions on the application SemVer, including RC labels.
 * https://developer.chrome.com/docs/extensions/reference/manifest/version
 */
export function releaseVersion(release) {
  const match =
    typeof release === 'string' &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.([1-9]\d*))?$/.exec(release);
  if (
    !match ||
    match.slice(1).some((part) => part !== undefined && Number(part) > 65535) ||
    match.slice(1, 4).every((part) => Number(part) === 0)
  )
    throw new Error(
      'Release version must be a Chrome-compatible nonzero SemVer or -rc.N candidate',
    );
  return {
    version: release,
    // rc.1 was already distributed as a three-part Chrome version. Preserve that
    // frozen mapping, then use the fourth numeric part for candidate updates.
    extensionVersion: [...match.slice(1, 4), ...(Number(match[4]) > 1 ? [match[4]] : [])].join('.'),
    ...(match[4] ? { extensionVersionName: release } : {}),
  };
}

export function validateExtensionRelease(manifest, release) {
  const expected = releaseVersion(release);
  if (manifest?.manifest_version !== 3 || manifest.version !== expected.extensionVersion)
    throw new Error('Extension numeric version does not match the application release');
  if (
    expected.extensionVersionName
      ? manifest.version_name !== release
      : manifest.version_name !== undefined && manifest.version_name !== release
  )
    throw new Error('Extension display version does not match the application release');
  return expected;
}
