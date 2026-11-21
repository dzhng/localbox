# 32 Guest agent self-update

**Unlocks:** Q11 and L4's second half. A guest that connects with an older agent
gets the host's current binary and restarts it without the sandbox stopping.

## Seam

- Ready frame gains `agent_version` (`packages/guest-gateway/src/protocol.ts:8`;
  today the host reads only `channel_epoch`, `FramedGuestChannel.swift:72`).
- Host `HostDaemonCore/GuestAgentUpdater.swift` (new): on a ready frame whose
  version differs from `agent-version.json` for the guest's OS, it checks
  `guest.activity`; with running jobs it defers (P5) and retries on the next
  connect or idle tick. Otherwise it sends `agent.update` on the control lane
  (slice 27): a header `{ version, sha256, size }` then chunks under the 8 MiB frame
  limit.
- Guest `control.ts`: write chunks to a temp file beside the binary, verify sha256,
  rename over `/usr/local/localbox/localbox-agent`, answer `updated`, exit. systemd
  (`Restart=always`) or launchd (`KeepAlive`) restarts it. On darwin, after the
  swap, rewrite the agent's TCC rows if slice 18 recorded that grants don't survive
  a replace (P6).
- `SandboxRuntime`: an `updated` answer marks the next request-lane close as
  expected; the runtime re-dials instead of calling `guestLost`
  (`SandboxRuntime.swift:164-170` today stops the VM on any close).

## See it

Tier `v`: boot an image carrying an older agent build, the host pushes, `system.info`
shows the new version, the sandbox's uptime never reset.

## Gates

- Tier `u`: `tests/guest-self-update.test.ts` (chunk integrity, sha mismatch
  refused, swap atomic, deferral while a job runs).
- Tier `s`: `AgentUpdaterTests` (expected close re-dials, unexpected close still
  stops).
- Tier `v`, probe 32: the scenario above, plus a deferred update that lands after
  the job finishes.

## Delegated

Chunk size; how long to wait for the restarted agent's ready frame.

## Stays green

Probe 12; `tests/guest-agent-persistent.test.ts`.
