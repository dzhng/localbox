/**
 * The kernel the linux image boots, pinned so a rebuild is reproducible. It lives on the image's own disk (GRUB loads
 * it through EFI), so it is part of the image, never of the host. Ubuntu drops a superseded version from its indexes,
 * so a stale pin fails the build rather than drifting; bump it deliberately.
 */
export const LINUX_IMAGE_GENERIC_VERSION = "6.8.0-151.151";

/** The `uname -r` a guest booted on the pinned kernel reports: `6.8.0-151.151` is `6.8.0-151-generic`. */
export function pinnedKernelRelease(version = LINUX_IMAGE_GENERIC_VERSION): string {
  return `${version.slice(0, version.lastIndexOf("."))}-generic`;
}
