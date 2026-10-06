// Hackathon builds fingerprint every image URL; web builds keep plain paths.
export const assetVersions: Record<string, string> | null = typeof __HL_ASSET_VERSIONS__ === 'undefined' ? null : __HL_ASSET_VERSIONS__;

/** Adds the content fingerprint to an image path built at runtime. */
export function versionedAsset(path: string): string {
  const base = path.split('?')[0];
  const version = assetVersions?.[base];
  return version ? `${base}?v=${version}` : path;
}
