# 35 macOS sandboxes

**Outcome 2026-11-21: built; probe 35 green at tiers s and m.** Evidence:
[35-macos-sandboxes.json](../evidence/35-macos-sandboxes.json), [the desktop](../evidence/35-desktop.jpg),
[with the Apple menu open](../evidence/35-menu-open.jpg), [the browser](../evidence/35-browser.jpg).

- A real daemon on this Mac built macOS 27.2.1 to `ready` in 286 s (IPSW cached), then ran every operation on a
  sandbox from it: `sw_vers`, desktop screenshots (real frames, no window-picker prompt, also with a menu open:
  slice 33's one-frame `SCStream`), `browser.open` + a screenshot of the page, sleep (hibernate) and wake with a PID
  surviving, `image create --from` (sync-only freeze, stall 25–71 ms across runs, 30 GB image by clone), a second
  sandbox from it with a new `VZMacMachineIdentifier` and a different platform UUID in the guest, and a third macOS
  sandbox: with two idle it sleeps the least recently used (`made_room`); with both busy, waking it answers
  `machine_full` "… already runs 2 macOS sandboxes, the most macOS allows" and never a Virtualization error. Once one
  is idle again, the wake sleeps it and restores the slept one from its state. A sandbox answers 17–28 s after create.
  The probe deletes everything it made.
- Tier s: `AdmissionMacCapTests` is `testThirdMacOSSandboxSleepsOneOrIsRefused` and
  `testResizeOnDarwinReportsOnlyUserProcesses` in `HostDaemonCoreTests` (choice 35).
- **The real run found two bugs the fakes couldn't:**
  1. A wake after sleep cold-booted every macOS sandbox ("could not restore its saved state: guest channel is
     unavailable"), losing every process. A restored macOS guest closes the first vsock connection at once; a dial a
     second later attaches. Opening the request lane now dials again when it closes before the ready frame, within
     the same 120 s (`GuestLane.open`, `testGuestLaneDialsAgainWhenTheGuestClosesBeforeReady`).
  2. The first screenshot of a fresh sandbox could show macOS's window-picker prompt: macOS draws it over the
     session's first captured frame, before the guard (once a second) presses Allow. The desktop role now makes that
     first capture itself at start and screenshots wait for it (`settle-capture-prompt`, `tests/capture-prompt.test.ts`).
     macOS records the approval for 30 days (`ScreenCaptureApprovals.plist`), so the build's `tcc` step waits for
     the record and every image carries it; each sandbox's settle covers it after that.
  Also found: `nohup` exits at once under the darwin agent (no console session), so `(cmd &)` starts a process
  that survives; not a product change.
- **Human review (non-blocking): accepted, with follow-ups.** The three shots were opened in Preview; nobody answered,
  and the decision was made on the evidence. An unprimed critique judged all three real, complete captures (sharp,
  1440x900, menu fully captured, example.com loaded, no prompt). Its two crop findings were the reviewer's crop
  offsets, not the captures. Left for the base image (slice 34) to tidy, none blocking: macOS "App Background
  Activity" banners (localbox-agent, GoogleUpdater) and two "Google Chrome Notifications" banners cover the top right,
  over Chrome's toolbar end in the browser shot; Chrome opens on a stray `about:blank` tab with its "Sign in to Chrome?"
  first-run button; the screen-recording indicator dot shows beside the clock.
- Not done here: the margin on the first-boot wait (delegated) stays at 120 s; measured boots answer in 17–28 s.

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
