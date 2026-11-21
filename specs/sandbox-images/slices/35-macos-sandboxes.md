# 35 macOS sandboxes

**Unlocks:** Q2 and Q12 end to end. `localbox sandbox create --image macos` gives a
sandbox where every operation works, it sleeps and wakes, saving it as an image
works, and a third running macOS VM is handled by admission (E9–E12).

## Seam

- `AppleSandboxFactory.provision` for an `os: macos` image: a new
  `VZMacMachineIdentifier` per sandbox and a copy of the image's `aux.img` (E10),
  through `ImageStore.cloneForSandbox`.
- `SandboxRuntime`: the first-boot wait for the guest's vsock connection is
  per-OS; macOS uses the measured first-boot time from slice 16 plus margin
  (today a fixed 120 s, `AppleVirtualizationBackend.swift:194`).
- `SandboxHost.admit` (`SandboxHost.swift:552-583`) counts running macOS VMs; a
  third sleeps the least recently used macOS sandbox if it can (and reports it),
  else answers `machine_full` with "this Mac already runs 2 macOS sandboxes, the
  most macOS allows". Never a raw `virtualMachineLimitExceeded`.
- Capture (slice 28) on macOS uses `sync` only (slice 27's darwin branch).
- `sandbox.resize`'s process-listing script (`SandboxRuntime.swift:402-418`) runs
  on darwin's `ps` without the `/proc` fallback.

## See it

`localbox sandbox create --image macos`, then `desktop screenshot`,
`browser open https://example.com`, `shell exec -- sw_vers`, `sandbox sleep`,
`sandbox wake`, `image create --from <it>`.

## Gates

- Tier `s`: `AdmissionMacCapTests` (third macOS VM sleeps LRU or refuses with the
  reason).
- Tier `m`, probe 35: every op above; the screenshot is a real frame (not blank);
  a PID survives sleep and wake; a sandbox from the captured image boots with a
  different machine identifier.

## Delegated

The margin added to the first-boot wait.

## Stays green

Linux probes 10, 12, 28.

## Human review (non-blocking)

Open the macOS desktop screenshot and the browser screenshot for the user with
[preview-shots](../../../.agents/skills/preview-shots/SKILL.md). Run
[screenshot-critique](../../../.agents/skills/screenshot-critique/SKILL.md) on both as
the last check. Wait about 5 minutes for a response; if none, decide on the
evidence, record it here, close the shots and continue.
