export function writeExtensionBuildMetadata(
  directory: string,
  target: { origin: string; mode: string; environment: string },
  workspace: string,
): Promise<void>;
