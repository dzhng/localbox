# Slice 03 — Linux desktop and browser image

## Contract unlocked

The durable VM exposes one usable graphical desktop and one headed browser while
keeping both upstream services loopback-only.

## API seam and ownership

`packages/vm-image` owns the reproducible ARM64 image, desktop, browser pin,
systemd wiring, and image verifier. The guest gateway owns desktop lifecycle,
VNC relay, browser target ownership, screenshots, and input operations.

Use the Duet-proven shape: fixed 1440×900 display, one X display, one Chrome
default profile, random per-VM local desktop credential, exact target IDs, and
demand-driven desktop startup/reap. Keep the browser profile inside the VM disk.

## Runnable artifact

`agent-computer desktop screenshot --output shot.png` captures the guest desktop;
`agent-computer browser open https://example.com` opens a target and returns its
exact target ID. A local fixture page demonstrates click/type/navigation.

## Verification

- Image verifier proves expected binaries, geometry, image digest, and loopback
  bindings for VNC and CDP.
- Browser target IDs are required for target-specific operations and reject stale
  generation IDs.
- Cookies and a file survive VM restart; reset discards them only explicitly.
- Desktop startup/reap follows demand and has a bounded slow-viewer policy.
- Capture startup, RSS, and CPU evidence; do not promise Duet’s timings on Mac.

For every desktop screenshot, run `screenshot-critique` last. When comparing
against a pinned Duet/reference capture, run `compare-screenshots` on the fixed
desktop crop only; wallpaper, app styling, and performance are out of scope for
this slice. Open shots with `preview-shots` for a non-blocking five-minute human
review, then record the verdict and close the preview.
