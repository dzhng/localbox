# Durable sandboxes: unknowns map

The completed explore-unknowns walk for email sign-in, the Mac-to-relay
connection and the durable-sandbox launch scope. It is the input to the spec in
this folder; decisions here are givens the spec carries verbatim.

Scope: everything in [positioning](../../positioning.md) except snapshots
([placeholder](../sandbox-snapshots/README.md)) and audited shared folders
([placeholder](../shared-folders/README.md)). macOS guests are out of scope with
no spec.

## 1. Known knowns (settled ground)

- One owner per deployment, from the required `LOCALBOX_OWNER_SUBJECT`
  (`apps/mcp/api/[...path].ts:13`); the OAuth server creates or fetches it on
  every authorize/token call (`apps/relay/src/repository-oauth.ts:60,77`).
- `GET /oauth/authorize` issues a code without authenticating anyone
  (`apps/mcp/api/[...path].ts:48-52`). Not exploitable against a real Mac yet,
  because no Mac can connect (below).
- Tokens are `{ownerId, vmId, scope: "vm"}` (`repository-oauth.ts:83,101`); relay
  submits are checked against the token's VM (`apps/relay/src/http.ts:51`).
- Schema: `owners(subject, displayName)`, with `vms`, `channels`, `requests`,
  `responses`, `authCodes`, `oauthTokens`, `audit`, `quotas` keyed by `ownerId`
  (`packages/state/convex/schema.ts`). Nothing ever deletes rows.
- No Mac can reach the relay: channel grants are only issued by the state layer
  (`packages/state/src/index.ts:99`, `convex/relay.ts:70`) and only tests call
  it; the TypeScript poller (`apps/relay/src/poller.ts`) is not started by the
  Swift daemon.
- The daemon has a real Apple Virtualization backend for exactly one VM with a
  fixed disk path, plus start/stop/pause/resume and reset-from-template
  (`apps/macos/HostDaemon/Sources/HostDaemonCore/AppleVirtualizationBackend.swift`).
- CLI login is a browser PKCE flow; credentials go to the Keychain with
  `~/.config/localbox/auth.json` as fallback (`apps/cli/src/index.ts:76-108`).
- Operation outputs are capped at 4 MiB (`packages/contract/src/index.ts:61`);
  larger relay results go to Vercel Blob (`apps/relay/src/http.ts:121`).
- Free-plan limits (checked 2026-10-14): Convex Free has 1M function calls,
  1 GB database I/O, 0.5 GB storage, 1,000 concurrent sessions and 1 MiB per
  document, all hard caps. Vercel Hobby has 1M invocations, a 300 s max duration
  and is for non-commercial use.
- Test host: this Mac mini (Mac18,5, macOS 27.0.1, 24 GB). The daemon is signed
  with `com.apple.security.virtualization`.

## 2. Known unknowns (decision ledger)

Closed by **U** (user), **T** (territory) or **A** (agent on the user's behalf,
under the delegation below).

| # | Decision | By |
| --- | --- | --- |
| Q1 | End to end: email login, Mac-to-relay connection, and every positioning use case except the two placeholders. | U |
| Q2 | Agent tokens grant the whole account. The token shape carries a list of scopes, an optional set of sandbox constraints and an expiry so narrower tokens can be added later; v1 issues one full-account scope. | U |
| Q3 | Sandboxes get generated fun names (`quiet-otter`), unique per account, overridable with `--name`. `--sandbox` may be omitted only when the account has exactly one sandbox; otherwise the command fails listing them. | U |
| Q4 | Placement is local only by default. Remote needs `--machine <name>` or `--placement auto` (local and remote, most free memory) or `--placement remote` (remote only). With no local machine and no option, create fails listing machines and their room. | U |
| Q5 | Auto-sleep when idle (on, 30 min) and auto-delete when idle (off, opt-in per sandbox via `--delete-after`). Idle means no agent requests and no Localbox jobs running. | U |
| Q5b | Sleep is hibernate: save VM state to disk, free RAM, resume every process on wake. Minimum macOS becomes 14 in installer, README and site. | U |
| Q6 | Default size: half the host's cores and a quarter of its RAM, minimum 2 CPUs and 2 GB, overridable with `--cpus`/`--memory`; results report the chosen size. `sandbox resize` restarts the sandbox and says so. | U |
| P1 | Reversible requests act, then report exactly what was done (now in `DEVELOPMENT.md`). | U |
| Q7 | macOS guest sandboxes: not now, no spec. | U |
| Q8 | One machine credential in `~/.config/localbox/credentials.json` (mode 600), shared by daemon, relay connector and CLI. `logout` deletes and revokes it; `machines remove` revokes it remotely. Keychain storage is removed. | U |
| Q9 | 6-digit code, 10 min, one active per email (a new request replaces it), 5 guesses per code. Limits: 5 sends/email/hour, 20 sends/IP/hour, 50 verifies/IP/hour. "Code sent" is always the reply. | U |
| Q10 | MCP sign-in page: email, then code, no separate consent step; the code screen states what signing in grants, naming the client. `localbox login` is terminal-only; the CLI's browser PKCE login is removed. | U |
| Q11 | Resend, from `Localbox <login@mail.localbox.sh>`; plain code email, no links. `RESEND_API_KEY` is required in production; locally codes print to the dev log only with `LOCALBOX_DEV_PRINT_CODES=1`. | U |
| Q12 | Accounts get a generated name (`brave-walrus-482`), shown in status and login output, never used for auth. `account rename`, `sandbox rename` and `machines rename` exist; account names are labels (3–40 chars of lowercase letters, digits and hyphens), not unique; machines start as the hostname. | U |
| Q13 | Machine credential never expires; "last seen" is recorded. MCP tokens: 15 min access, 30-day refresh renewed on use, existing replay-revocation kept. | U |
| Q14 | Wipe and redeploy: schema first, then functions; delete `LOCALBOX_OWNER_SUBJECT`. Existing Convex data is test data. | U |
| Q15 | Macs wait on a direct Convex subscription (the longest possible long-poll); idle Macs cost about zero calls. Capacity is reported only when it changes; offline is detected lazily (a targeted Mac that doesn't claim within a few seconds is reported offline). Target: about 200 concurrent Macs on Convex Free; database I/O is the binding budget. | U |
| Q15b | Run on the free plan; the user moves to Starter when needed. No usage alerting is built. | U |
| Q16 | The relay connector is a TypeScript process on the bundled Node runtime, its own launchd job, using the official `convex` client. It forwards each remote request to the daemon over the same authenticated local socket the CLI uses. | U |
| Q17 | Every operation's output is capped at 900 KiB everywhere; oversize is trimmed and reported (`truncated`, original and returned size). `fs.read` and `job.output` gain offset and length. Relay rows are kept 24 hours and removed by a daily Convex cleanup. Vercel Blob is removed entirely. | U |
| S1 | CLI `vm` commands become `sandbox`, no alias. | U |
| S2 | Output: login shows machine count; create explains its chosen size; "made room" and "woke first" appear in the main output. | U |
| S3 | Text output by default; `--json` returns the same facts as fields on every command. Preference: the agent is the reader, short text is cheapest, `--json` matches existing CLI convention. | A |
| L7 | Per-account daily limits: 10,000 relayed requests and 5 GB relayed results; exceeding returns an error naming the limit and reset time. Preference: open free service needs a ceiling; values are knobs. | A |
| L9 | A machine is full when running sandboxes would reserve more than 75% of its RAM; start or wake then sleeps least-recently-used sandboxes and reports them. Preference: P1 act-then-report, leave room for the host. | A |

**Delegation.** Scope: agent-facing CLI ergonomics and operational defaults that
follow from P1. The user said the CLI's customer is an agent and the agent is
better placed to decide; product and architecture direction stays with the user.

**OPEN**

- **Resend account, API key and DNS for `mail.localbox.sh`.** Owner: user.
  Blocks only real email delivery, not the build.
- **Hibernate compatibility (L5).** Unblocked by the first build spike.

## 3. Unknown knowns (extracted)

- The CLI's customer is an agent, not a person. Output shape, verbosity and
  defaults are judged by what an agent needs to act next. Reshaped S3, L7, L9.
- Infrastructure cost is the user's job: no alerting, no billing machinery.
  Reshaped Q15b.
- Prefer less infrastructure over cleverness: no blob storage, no recovery
  phrase, no Keychain, no wormhole codes. Reshaped Q8, Q17 and the identity
  design.
- Prove it on this Mac mini; simulate the second machine with a second daemon
  and connector using their own state directory and credential, against local
  Convex and the local relay. The user runs the real two-Mac test later.
- Marketing may lead the build; agent-facing instructions may not.

## 4. Unknown unknowns (landmines)

| # | Finding | Evidence | Status |
| --- | --- | --- | --- |
| L1 | The VM's network device has no attachment, so sandboxes have no internet. Fix: NAT attachment and a random, persisted MAC per sandbox. | `AppleVirtualizationBackend.swift:36` | Decided |
| L2 | The poller checks the relay every 250 ms forever (~345k calls/day per Mac). | `apps/relay/src/poller.ts:39` | Decided by Q15 |
| L3 | Nothing runs the relay connection on the Mac. | `HostDaemon.swift` only reports `relayConnected` | Decided by Q16 |
| L4 | Template clones share machine ID, SSH host keys and hostname. Fix: guest regenerates identity on first boot after clone; hostname is the sandbox name. | Single-VM design | Decided |
| L5 | Hibernate needs `validateSaveRestoreSupport` to pass; the file-handle console port used as the guest channel is unverified. Fallback: move the guest channel to the virtio socket device. | `AppleVirtualizationBackend.swift:43-46` | OPEN until spike |
| L6 | Host sleep freezes VMs; reboot or power loss ends them. Daemon hibernates running sandboxes on macOS sleep and shutdown notices and restores on start; after power loss a sandbox cold-boots and the next result says so. | — | Decided |
| L7 | A free service is an open relay. | `quotas` table unused (`packages/state/src/index.ts:31`) | Decided (A) |
| L8 | Per-IP limits need an unforgeable IP: use the one Vercel sets, never caller `x-forwarded-for`. | No IP handling exists | Decided |
| L9 | "Machine full" was undefined after Q6. | — | Decided (A) |
| L10 | No VM image exists to boot. First step: build the ARM64 image locally with `npm run image:build`. | release variables only | Decided |
| L11 | Outputs above 1 MiB cannot be stored in a Convex document. | `contract/src/index.ts:61`, Convex limits | Decided by Q17 |

**Confirm before coding**

- That Convex's free plan allows the scheduled daily cleanup and a WebSocket
  subscription authenticated by a custom JWT issued by our Vercel route.
- That `saveMachineStateTo`/`restoreMachineStateFrom` work for this guest
  configuration on macOS 14+ (the L5 spike).
- Resend's free tier limits against 5 sends/email/hour at expected signup volume.

## Build plan (by likelihood of tweaking)

Judgment calls first; mechanical work last.

1. **Hibernate spike** on this Mac: boot, save, restore, confirm a Node server
   survives; pick the guest channel (console port or virtio socket).
2. **Identity and auth**: accounts, machines, email codes via Resend, machine
   credential file, `login`/`logout`/`machines`/`account` commands, MCP
   email-and-code sign-in page, generalized token shape, rate limits, wipe.
3. **Relay connector**: TypeScript launchd job with a direct Convex
   subscription authenticated by a 24-hour JWT from Vercel; forwards over the
   local socket; capacity on change; lazy offline.
4. **Multi-sandbox daemon**: many VMs, APFS-cloned disks, NAT network and MAC
   per sandbox, guest identity regeneration, relative sizing, resize, 75% full
   rule with LRU sleep, idle sleep and opt-in idle delete, host sleep/shutdown
   handling.
5. **Catalog and CLI**: `sandbox` commands (create, list, rename, resize,
   delete, start, stop, sleep), placement flags, fun names, 900 KiB cap with
   truncation report, paging for `fs.read`/`job.output`, P1 reporting fields.
6. **Relay storage**: 24-hour retention cron, remove Vercel Blob, per-account
   daily limits.
7. **Docs**: macOS 14 minimum, skill and llms.txt for the shipped CLI,
   `DEVELOPMENT.md` settings, SECURITY.md for accounts and the relay.

## Implementation prompt

> Write the spec for durable sandboxes from `specs/durable-sandboxes/map.md`
> using write-spec: slice it into independently verifiable steps in the build
> plan's order, starting with the hibernate spike, with each slice proven on
> this Mac mini and the second machine simulated locally. Carry every decision
> in the ledger verbatim as a given.
