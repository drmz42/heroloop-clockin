import { buildVersionLabel } from '@/platform/buildInfo';

/** Small version line pinned to the bottom of the start and loading screens. */
export function BuildVersion() {
  return <p className="hl-build-version" aria-label={`Version: ${buildVersionLabel}`}>{buildVersionLabel}</p>;
}
