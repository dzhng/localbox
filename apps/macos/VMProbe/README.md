# VMProbe

`VMProbeCore` owns the host probe report and a swappable `VMProbeBackend` seam.
The default backend selects Apple Virtualization on macOS and the deterministic
fake backend elsewhere, so CI can exercise persistence and lifecycle evidence
without pretending that a native VM boot succeeded.

```sh
swift test
swift run vm-probe --backend fake --json --disk /tmp/localbox-vm-disk
```

Run the command twice with the same `--disk` path to observe the warm marker
and `diskMarkerPersistence` result. The fake report is a fixture for adapter
tests; its reserved IPs and egress are intentionally deterministic.

On macOS, `AppleVirtualizationBackend` validates a pinned ARM64 kernel,
initrd, rootfs, persistent disk attachment, virtio NAT, entropy, and no host
directory shares. It deliberately throws after configuration validation until
the host daemon owns the asynchronous VM lifecycle and guest channel. This
keeps a native failure visible rather than silently substituting the fake.
