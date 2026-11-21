# 25 The built-in linux image ships as an image

**Unlocks:** L1 in the release. Kernel and initrd leave the app bundle, the
per-Mac template and its three launchd variables disappear, and every Mac installs
`images/linux` like any other image (P1).

## Seam

- `packages/vm-image/scripts/build-boot-artifacts.ts` writes an image directory
  (`image.json`, `disk.img`, `boot/efi-vars`) from the EFI layout proven in slice 15.
  The `--boot efi` spike flag becomes the only path. Pin `linux-image-generic` to the
  exact version in `image-pins` so a rebuild is reproducible
  (`Dockerfile.arm64:34` today is unpinned).
- The image carries the agent binary from slice 31 once it exists; until then the
  current Node agent unit.
- `scripts/release.sh` stops copying `vmlinuz` and `initrd` into
  `Contents/Resources/vm/` (`release.sh:161-162`) and ships the image directory's
  disk as the zstd parts it ships today, plus the boot store.
- `scripts/release.ts` `ReleaseTemplate` becomes `ReleaseImage { sha256, size, parts,
  bootStore }`; `expandTemplate` becomes `expandImage` into `images/linux/`.
- `scripts/install-release.sh` deletes `LOCALBOX_KERNEL`, `LOCALBOX_INITRD` and
  `LOCALBOX_TEMPLATE_DISK` (`:167-169`) and the plist defaults
  (`com.localbox.hostd.plist:16-18`), which the daemon stopped reading in slice 24.
- Probes 01, 02 and 10 are rewritten for the image layout. No compat path.

## See it

Build a local release (`scripts/release.sh`), install it into a temp HOME
(`HOME=$(mktemp -d)`, per the hostd test-isolation rule), `ls` shows no kernel in
the app and an `images/linux` directory; `localbox sandbox create` boots from it.

## Gates

`tests/release.test.ts` (manifest shape, expansion leaves holes),
`tests/vm-image-guest-protocol.test.ts`, `npm run proof -- 01,02,10 --tier v`.

## Fork

Under the slice 15 fallback the image directory also holds `boot/kernel` and
`boot/initrd`, and the app still carries no kernel.

## Delegated

Part naming, where the boot store sits in the parts.

## Stays green

`npm run proof -- --through 14 --tier u,l` with the rewritten probes; the updater
test (`tests/updater.test.ts`).
