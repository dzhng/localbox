# Guest agent

The Linux image runs `apps/guest-agent/src/index.ts` as its guest service. The
process reads and writes the length-prefixed JSON protocol on standard streams;
the production image connects those streams to a virtio-serial channel. A
standard-stream entrypoint keeps the same service probeable without booting a
VM.

Configuration comes from environment variables:

- `LOCALBOX_ROOT` — guest filesystem root (defaults to `/`).
- `LOCALBOX_CHANNEL_EPOCH` — host-issued channel epoch (defaults to `1`).
- `LOCALBOX_READINESS_MARKER` — marker written before the `ready` frame.
- `LOCALBOX_INVENTORY` — comma-separated inventory names. The default is
  the Duet-compatible inventory contract.
- `LOCALBOX_DESKTOP_BACKEND=production` — opt into the Chromium CDP and
  X11 desktop backend. Chromium must expose loopback CDP (default
  `http://127.0.0.1:9222`); `LOCALBOX_CDP_URL` overrides that endpoint,
  and `DISPLAY` selects the X11 display. Without this variable the deterministic
  fixture desktop remains active for probes and local tests. The production
  ARM64 image sets this automatically after starting its loopback Xvfb, XFCE,
  VNC, and Chromium services.

The first output frame is `ready`, containing the channel epoch,
inventory digest, and readiness marker. Requests with a stale epoch
are rejected. Work is bounded by the gateway's shell/filesystem limits and the
service's pending-request and input-buffer limits. `cancel` frames abort the
matching request through its `AbortSignal`.

For a local protocol smoke test after building:

```sh
printf '' | LOCALBOX_ROOT="$PWD" LOCALBOX_READINESS_MARKER="$PWD/.localbox-ready" \
  npx tsx apps/guest-agent/src/index.ts
```
