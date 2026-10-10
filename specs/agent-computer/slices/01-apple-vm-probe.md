# Slice 01 — Apple silicon VM probe

## Contract unlocked

The intended local virtualization backend is proven before desktop, relay, or
app work depends on it.

## API seam and ownership

Add a small native probe under `apps/macos/VMProbe` plus a swappable host adapter
interface. It boots a pinned ARM64 Linux kernel/initrd/rootfs with a persistent
raw or qcow disk, serial output, NAT networking, and a virtio/guest channel.

## Runnable artifact

`agent-computer vm probe --json` emits host architecture/macOS version, backend,
boot and ready timings, guest identity, guest/egress IP, disk-marker persistence,
pause/resume, and clean-stop results. Run it twice against the same disk.

## Verification and stop condition

- Cold and warm boot both reach a guest readiness marker.
- A marker survives stop/start and pause/resume.
- Guest outbound HTTPS works and reports the observed egress.
- The guest cannot read arbitrary host paths.
- Sleep/wake or an injected channel drop can reconnect without disk corruption.
- No leaked VM process, socket, or disk lock remains after stop.

If any load-bearing result fails, record the measured reason and reslice around a
proven backend. Do not hide a failed native probe behind a fake abstraction.

## Delegated decisions

Linux image format and minimum macOS floor may follow the probe evidence.

## Human review

Review the JSON report and resource measurements; no visual gate yet.
