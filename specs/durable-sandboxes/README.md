# Durable sandboxes

Turn Localbox from one VM per Mac into durable sandboxes on an account of Macs:
email-code sign-in, many sandboxes per Mac that sleep (hibernate) when idle, a
direct Convex subscription per Mac, local-first placement with explicit remote
placement, and an agent-first CLI that acts and then reports what it did.

- Product message and use cases: [positioning](../../positioning.md).
- Every decision this plan rests on: [unknowns map](map.md) (ledger Q1–Q17,
  S1–S3, L1–L11, P1). They are givens; this plan adds the decisions in
  [Plan decisions](#plan-decisions) below.
- Out of scope: snapshots ([placeholder](../sandbox-snapshots/README.md)),
  audited shared folders ([placeholder](../shared-folders/README.md)), macOS
  guests (no spec).

## Next Agent Prompt

*Status 2026-10-15: slice 00 done (`npm run proof -- 00 --tier u,l` passes). In progress: 01, 04, 05 (Codex, separate worktrees).*

You are building durable sandboxes. Read this README, then the slice you are
picking up. Work on this Mac mini; the second machine is simulated (slice 03).

1. Run `npm ci`. Slice 00 is done; `npm run proof -- 00 --tier u,l` must stay green.
2. Then run the two lanes, in either order or interleaved:
   - **Lane V (real VMs):** 01 → 02. Slice 02 is the go/no-go for hibernate: if
     save/restore fails for every channel option, stop and report; Q5b goes
     back to the user.
   - **Lane L (local stack):** 03, 04, 05 → 06 → 07 → 08, 09.
   Then 10 → 11 → 12 → 14 → 13.
3. After each slice run `npm run proof -- --through <NN> --tier u,l` and keep
   the evidence path in your report. Commit each slice separately.
4. Before ending your pass, update this section: status, next slice, blockers,
   and any plan decision you overturned (record it in the slice file and in
   [Plan decisions](#plan-decisions)).

**Blockers to watch:** the Resend account, API key and DNS for
`mail.localbox.sh` (user-owned; only real email delivery waits on it). Debian
kernel and image pins for slice 01 (use the dev pins file).

**TODO**

- [x] [00 proof harness](slices/00-proof-harness.md)
- [ ] [01 boot artifacts](slices/01-boot-artifacts.md)
- [ ] [02 hibernate spike](slices/02-hibernate-spike.md) — go/no-go
- [ ] [03 fixture machine](slices/03-fixture-machine.md)
- [ ] [04 output cap and jobs](slices/04-output-cap-and-jobs.md)
- [ ] [05 Convex auth boundary](slices/05-convex-auth-boundary.md)
- [ ] [06 email identity](slices/06-email-identity.md)
- [ ] [07 relay mailbox and connector](slices/07-relay-connector.md)
- [ ] [08 MCP sign-in](slices/08-mcp-signin.md)
- [ ] [09 sandbox catalog and CLI](slices/09-sandbox-catalog.md)
- [ ] [10 multi-sandbox daemon](slices/10-multi-sandbox-daemon.md)
- [ ] [11 placement and capacity](slices/11-placement-capacity.md)
- [ ] [12 sleep lifecycle](slices/12-sleep-lifecycle.md)
- [ ] [14 agent setup: skill and CLI kept current](slices/14-agent-setup.md)
- [ ] [13 proof, agent docs and cutover](slices/13-proof-docs-cutover.md)

## Slice graph

```text
00 proof-harness ─┬─ 01 boot-artifacts ─ 02 hibernate-spike ───────────────┐
                  ├─ 03 fixture-machine ───────────────────┐               │
                  ├─ 04 output-cap-and-jobs ───────┐       │               │
                  └─ 05 convex-auth ─ 06 email-identity ─ 07 relay-connector
                                                   │       ├─ 08 mcp-signin
                                                   └───────┴─ 09 sandbox-catalog
                                    02 + 09 ─ 10 multi-sandbox-daemon
                                         09 + 10 ─ 11 placement-capacity
                                         10 + 11 ─ 12 sleep-lifecycle
                                          09 + 12 ─ 14 agent-setup
                                      everything ─ 13 proof-docs-cutover
```

Lane V (01, 02, then 10's real part) is slow and needs real VMs; lane L never
waits for an image build. 07 needs 03 (a daemon to forward to), 04 (results fit
one Convex document) and 06 (machine credential).

## Review map

| Slice | Human/agent sees | Verdict |
| --- | --- | --- |
| 00 | `npm run proof -- 00` | stack up/down twice, IP overwrite |
| 01 | `vmlab boot` reaches `ready` in a real VM | boots, `uname -m` = aarch64 |
| 02 | `evidence/02-hibernate.json` | Node PID survives sleep; channel chosen |
| 03 | two machines' CLIs on one Mac | distinct roots, tokens not interchangeable |
| 04 | 2 MiB read trimmed and paged; background job | sha256 reconstructs |
| 05 | unauthenticated calls refused | every public function guarded |
| 06 | `localbox login` with a dev-log code | machine count 2, removal works |
| 07 | `shell exec --machine b` | idle Macs make no calls; offline in < 5 s |
| 08 | sign-in pages (screenshots) | token flow end to end; screenshot-critique |
| 09 | `localbox sandbox …` | fun names, omission rule, text/JSON parity |
| 10 | two real sandboxes | distinct identity, internet, thin clones |
| 11 | `--placement auto`, full machine | lands right; LRU slept and reported |
| 12 | idle sleep, wake, power events | woke/cold-boot reported |
| 14 | install, update, maintenance off, MCP parity | skill always matches the release |
| 13 | `npm run proof -- all`; docs command check | everything green; runbook |

## Proof tiers

Every slice is judged by `npm run proof -- <slice> [--tier …]`: one JSON
verdict, exit 0 pass, 1 fail, 2 blocked (names the missing external input).

| Tier | What runs | Budget |
| --- | --- | --- |
| u | `node:test` + `convex-test`, in process | < 30 s |
| s | `swift test --package-path apps/macos/HostDaemon` | < 60 s |
| l | local Convex, `dev:local`, fixture machines A and B | < 2 min |
| v | real Apple Virtualization on this Mac | < 6 min |
| x | Resend, deployed stack, real second Mac | manual/opt-in |

A fixture can never be the evidence for a real-VM claim: hibernate, NAT, MAC,
clone and guest identity are proven only in tier v.

## Single-owner invariants (end state)

The end state must read as designed today. Each concept has exactly one owner:

| Concept | Owner | Never owned by |
| --- | --- | --- |
| Operation catalog, limits, output cap (`capResult`, 900 KiB), result facts (P1) | `packages/contract` | adapters |
| Account identity and name | Convex `accounts` | CLI, credential file (cache only) |
| Email codes and rate limits | Convex `signin` | Vercel routes (transport only) |
| Email delivery | `packages/mail` (`Mailer`) | — |
| Machine credential authority | Convex `machines` (hash, `revokedAt`, `lastSeenAt`) | — |
| Machine credential on disk | `packages/credentials` (`credentials.json`, 0600) | Keychain, `auth.json` (deleted) |
| On-disk layout | `packages/config` `machinePaths()`; Swift receives explicit paths | Swift defaults |
| JWT minting | `packages/tokens`, Vercel routes only | connector, Convex |
| Convex caller identity | `convex/lib/identity.ts` `requireIdentity` | ad-hoc checks |
| Sandbox identity (id, name, machine, requested size, policies) | Convex `sandboxes` | daemon (read-only mirror) |
| Sandbox runtime (disk, MAC, machine identifier, lifecycle, last activity, save file) | Swift `SandboxHost` | Convex (reported projection) |
| Placement policy | `packages/placement` `place()`, called only by the create route | CLI, daemon |
| Admission (75% rule, LRU sleep), sizing, idle policy, host power | `SandboxHost` | Convex, connector |
| Relay mailbox | Convex `relay` (`requests`, `responses`) | Vercel memory |
| Agent API (every catalog operation from CLI-remote and MCP) | one route, `POST /api/v1/ops` | per-resource REST routes |
| Convex speaker on a Mac | `apps/connector` | daemon, CLI |
| Guest dispatch, jobs, activity | `packages/guest-gateway` | guest service (framing only) |
| Name generation and label rule | `packages/names` | — |
| Keeping the skill and CLI link matched to the release | one reconcile function (slice 14) run at install, daemon start and on request | updater, ad-hoc scripts |
| CLI rendering (text and `--json` from one result) | `apps/cli` `render()` | per-command printing |

## Transitional seams

Only these may exist, and each dies in a named slice. A slice that needs any
other bridge must reslice instead.

| Seam | Removal condition | Removed in |
| --- | --- | --- |
| T1 Single-VM `HostDaemon` (with process-fixture backend) | `SandboxHost` holds many runtimes | 10 |
| T2 Public `relay:write`/`read`, `channels`, `/host/*`, `poller.ts`, `RelayServer` | Connector claims via authenticated subscription | 07 |
| T3 `LOCALBOX_OWNER_SUBJECT`, owner-subject OAuth, fixture OAuth server | Account-based OAuth | 08 |
| T4 Vercel Blob (`packages/blob`, `BLOB_*`) | 900 KiB cap everywhere | 04 |
| T5 Keychain, `auth.json`, CLI PKCE login | `credentials.json` login | 06 |
| T6 `vm_id`, `vm.*`, `vm` CLI, VMProbe, `packages/registry`, `HostStatus` | Sandbox catalog | 09 |
| T7 `packages/recovery`, `recovery probe` | Swift idle and power handling | 12 |

## Plan decisions

Made while synthesizing four independent drafts (fewest-slices, risk-first,
seam-quality, proof-harness). They follow from the map and P1; overturn one by
editing it here and in its slice.

| # | Decision | Why |
| --- | --- | --- |
| D1 | Build boot artifacts (kernel, initrd, ext4 template, systemd unit on the virtio port) before the hibernate spike. | `npm run image:build` only makes a Docker image; nothing can boot (L10 understated). |
| D2 | Hostname and guest epoch travel in an in-band `hello` frame, never on the kernel command line; the MAC and `machineIdentifier` are persisted per sandbox. | Restore needs an identical configuration, so rename must not change it; the guest epoch is fixed at boot today. |
| D3 | Convex functions are authenticated: ES256 custom JWT (data-URI JWKS); service JWTs for Vercel, 24 h machine JWTs for connectors; revocation checked on every call. Typed functions replace the `write`/`read` switch; caller-supplied `now` is removed. | Q15 ships the Convex URL to every Mac; today every function is public. |
| D4 | Real background jobs (`shell.exec` with `background`, `job.*` with paging) and `guest.activity`. | Q5's idle rule and "long jobs" need jobs; today they are stubs. |
| D5 | The agent side waits server-side: the submit route waits on a Convex subscription up to `min(deadline, 50 s)` and returns inline; no client polling. | `RelayHttpTransport` polls every 50 ms, the client-side twin of L2. |
| D6 | Unclaimed requests are atomically abandoned after 3 s and answered `machine_offline`; a late Mac skips abandoned rows. | Lazy offline (Q15) without a reported-offline mutation ever running later. |
| D7 | MCP clients use dynamic client registration with exact redirect matching; the code screen names client and redirect host. MCP calls the agent API in-process; no bearer passthrough. | MCP authorization spec; Q10 needs a client name. |
| D8 | Every create goes through Convex (the single placement owner), including local ones; signing in is required to create sandboxes. Per-sandbox operations on a local sandbox go straight to the daemon socket. | One placement path; the account owns names. |
| D9 | The local socket keeps its own `ipc-token` (no account meaning); `credentials.json` is the one account credential, used by CLI and connector. | Q8 ambiguity resolved toward the smaller change; local calls work without the network. |
| D10 | `vm.*` catalog operation IDs become `sandbox.*` (not just CLI commands); `vm.pause` becomes `sandbox.sleep`; `vm.reset` is removed (delete + create). | CLI help and MCP tools are generated from the catalog (S1). |
| D11 | The daemon hibernates on SIGTERM (updates, `kickstart -k`) instead of stopping VMs. | Today every update ends all guest processes (L6 gap). |
| D12 | Screenshots are re-encoded or scaled to fit the cap, and the result says so. | Trimming a PNG corrupts it. |
| D13 | Per-account daily relay limits are 500 requests and 25 MB of results (knobs). **Answered by the agent on the user's behalf**, replacing L7's 10,000 / 5 GB. | L7 let one account spend the whole deployment's free monthly budget in a day. |
| D14 | A process-fixture backend (the guest agent as a child process, `SIGSTOP` for sleep) simulates the second machine; it is refused without an explicit dev opt-in and in signed releases. | Two real daemons on one Mac double-count RAM. |
| D15 | The release (`full`) image uses exactly the package set of Duet's VMs (`~/dev/duet/packages/vm-image/Dockerfile` at `8f3cb100e`), ported to ARM64 with recorded substitutions (Chromium for Chrome, ARM64 builds of x86_64 downloads, Duet-only services removed), and a parity check guards drift. | User requirement: Localbox sandboxes carry the same toolchain as Duet VMs. |
| D16 | The release owns the global skill and CLI link while "agent setup" is on (default): reconcile at install and every daemon start (each update relaunches it); skill and CLI lifecycle are catalog operations; `llms.txt` sells and installs, the skill is the only usage reference. | User requirement, modelled on Yap's "Set up my agents". |

## Sharp edges (no decision needed; know them)

- **Resend free tier:** 100 emails/day, 3,000/month. Sign-ins beyond that need a
  paid Resend plan (user-owned, like the Convex plan).
- **Saved state is big and local:** a hibernated sandbox writes roughly its RAM
  to disk; save files are encrypted per Mac and user and can't move machines.
- **A sleeping Mac is offline.** Fleet Macs that should serve remote agents need
  sleep disabled; the docs say so, nothing enforces it.
- **Vercel Hobby is for non-commercial use.** A free service is arguably fine; a
  grey area the user owns, like moving Convex to Starter when usage nears the cap
  (map Q15b; no alerting is built).
- **One request at a time per guest channel** on the console port; a long command
  blocks cancel. Prefer the virtio socket if slice 02 shows it restores.
- **Restore may require an unlocked Mac** for saved-state decryption; slice 02
  records the behaviour.

## Research sources

- Apple Virtualization: [saveMachineStateTo](https://developer.apple.com/documentation/virtualization/vzvirtualmachine/savemachinestateto(url:completionhandler:)), [restoreMachineStateFrom](https://developer.apple.com/documentation/virtualization/vzvirtualmachine/restoremachinestatefrom(url:completionhandler:)), [validateSaveRestoreSupport](https://developer.apple.com/documentation/virtualization/vzvirtualmachineconfiguration/validatesaverestoresupport()), [VZNATNetworkDeviceAttachment](https://developer.apple.com/documentation/virtualization/vznatnetworkdeviceattachment), [VZMACAddress](https://developer.apple.com/documentation/virtualization/vzmacaddress), [VZVirtioSocketDevice](https://developer.apple.com/documentation/virtualization/vzvirtiosocketdevice), [VZLinuxBootLoader](https://developer.apple.com/documentation/virtualization/vzlinuxbootloader), [WWDC23 session 10007](https://developer.apple.com/videos/play/wwdc2023/10007/), [Tart suspend/resume](https://github.com/openai/tart/pull/1297), [clonefile(2)](https://keith.github.io/xcode-man-pages/clonefile.2.html)
- Convex: [limits](https://docs.convex.dev/production/state/limits), [custom JWT](https://docs.convex.dev/auth/advanced/custom-jwt), [cron jobs](https://docs.convex.dev/scheduling/cron-jobs), [ConvexClient](https://docs.convex.dev/api/classes/browser.ConvexClient)
- Vercel: [function limits](https://vercel.com/docs/functions/limitations), [request headers](https://vercel.com/docs/headers/request-headers), [pricing](https://vercel.com/pricing)
- Resend: [send email](https://resend.com/docs/api-reference/emails/send-email), [quotas](https://resend.com/docs/knowledge-base/account-quotas-and-limits)
- MCP: [authorization 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization), [2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)

## Standing gates

Every slice keeps green: `npm run build`, `npm test`,
`swift test --package-path apps/macos/HostDaemon`, `npm run generate:snapshots`
with no diff after regeneration, `npm run site:build && npm run site:test`, and
`npm run proof -- --through <previous> --tier u,l`. Any slice that produces a
visual shot runs [screenshot-critique](../../.agents/skills/screenshot-critique/SKILL.md)
as its last check; there are no prior looks to compare against, so
compare-screenshots does not apply. Human review checkpoints are non-blocking:
open shots with preview-shots, wait about five minutes, then decide on the
evidence, record it in the slice file and continue.
