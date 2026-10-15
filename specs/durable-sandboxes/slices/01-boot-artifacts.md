# 01 Boot artifacts

**Unlocks:** a Linux sandbox boots on this Mac and reports ready on the guest
channel. Today `npm run image:build` only produces a Docker image (no kernel,
initrd, disk, init or virtio binding), so nothing can boot (plan decision D1).

## Seam

- `packages/vm-image/scripts/build-boot-artifacts.ts --profile minimal|full`
  (`npm run image:boot`): builds the existing Dockerfile plus a boot layer
  (`linux-image-arm64`, `systemd-sysv`, initramfs with virtio modules), a
  `localbox-guest.service` unit that runs the guest agent bound to
  `/dev/virtio-ports/org.localbox.guest`, and an empty `/etc/machine-id`.
  Exports the filesystem and runs `mke2fs -t ext4 -d` inside a container (the
  host has no `mkfs.ext4`; the harness starts colima). Extracts the kernel
  (decompressed to a raw arm64 `Image` if gzip) and initrd. Writes
  `dist/vm-image/<profile>/{kernel,initrd,template.img,manifest.json}`; the
  manifest carries `artifactDigests` (type exists in `packages/vm-image/src/index.ts`).
- `minimal` (systemd, Node, guest agent, curl) for fast probes; `full` is the
  release image. One pipeline; only the package set differs.
- **`full` uses exactly the package set of Duet's VMs** (plan decision D15):
  `~/dev/duet/packages/vm-image/Dockerfile` at Duet commit `8f3cb100e`. That means
  the same apt list (build tools, LibreOffice headless, ffmpeg, pandoc,
  tesseract, ImageMagick, fonts, XFCE desktop and the rest), Node 24 from
  NodeSource, the same pip packages, the same global npm tools, KasmVNC and the
  XFCE desktop configuration, and Bun. Pin versions and checksums the same way
  Duet does. Port it to ARM64 with only these substitutions, each recorded in
  the image manifest:
  - Google Chrome (no Linux ARM64 build) → Chromium for ARM64, pinned.
  - x86_64 downloads (Bun, KasmVNC `.deb`, static-web-server) → their ARM64
    builds at the same versions, or the nearest ARM64 release if one is missing.
  - Duet-only services (Duet gateway, Syncthing, Duet runtime, Duet systemd
    units, branding) are left out; Localbox's guest agent and units replace them.
  - Base image: Duet's `boldsoftware/exeuntu` if it publishes an ARM64 variant,
    else Ubuntu 24.04 ARM64; pinned by digest either way.
  Replace the drifted Debian package list in `packages/vm-image/Dockerfile.arm64`
  rather than adding a second list.
- **Package parity check:** `packages/vm-image/scripts/duet-parity.ts` parses the
  apt, pip and npm lists from Duet's Dockerfile at the pinned commit (vendored
  as `packages/vm-image/duet-reference/Dockerfile`) and fails when the `full`
  profile differs except for the listed substitutions. Updating to a newer Duet
  image is a deliberate re-vendor plus parity run.
- Dev pins in `packages/vm-image/image-pins.dev.json` (gitignored, checked-in
  example). A missing pin exits 2 naming the variable.
- Fix the boot command line: the guest port is created with `isConsole = false`
  (`AppleVirtualizationBackend.swift:44`), so `console=hvc0` is not it.
- `localbox-vmlab`: new executable target in `apps/macos/HostDaemon/Package.swift`
  driving the same `AppleVirtualizationBackend` as the daemon:
  `vmlab boot|hibernate|clone|net --artifacts <dir> --json`. Signed by
  `scripts/proof/lib/sign-dev.sh`.

## See it

`npm run proof -- 01 --tier v`: builds `minimal` (cached by input digest), then
`vmlab boot`: configuration validates, ready frame within 60 s,
`shell.exec uname -m` returns `aarch64`.

## Gates

The probe; a tier-u test that the manifest binds artifact digests;
`tests/vm-image-guest-protocol.test.ts` and `npm run image:verify` stay green.

## Delegated

Kernel package for the chosen base (`linux-image-generic` on Ubuntu or the
Debian equivalent), default template size, how the ext4 build runs in Docker.
Not delegated: the `full` package set, which is Duet's (D15).

## Firewall

If `VZLinuxBootLoader` cannot boot the Debian kernel even decompressed, the
fallback is `VZEFIBootLoader` with a GRUB disk. That is a new seam: reslice, do
not patch it in.

## Feedback that would change it

A different base distro; dropping the desktop from `full`.
