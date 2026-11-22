# 09 · App control: socket, login item, `localbox app`

Needs 08 (and 01's verdict).

## Contract

Everything the app can do natively is reachable from the CLI, so an agent can
do all that Settings can. Open at login is on by default.

## API seam

- **`LocalboxAppCore.AppSocket`**: a Unix socket at `<root>/app.sock`, mode
  0600, one JSON line in and one out (Bento's `AppSocket.swift`). It keeps
  answering when the daemon is down. Operations in this slice:
  - `app.info` → `{ version, build: "release" | "dev", in_applications,
    children: { daemon: "running" | "starting" | "stopped" | "backing_off",
    connector: same }, stopping: null | { reason, pending: [names] } }`
  - `login_item.get` → `{ state: "enabled" | "disabled" | "requires_approval"
    | "not_found" }`
  - `login_item.set { enabled }` → the same shape after the change
  `update.*` is reserved for slice 15. An unknown operation answers the CLI's
  failure envelope with `unsupported`.
- **`LoginItem`** (`SMAppService.mainApp`): on the first launch of a release
  build inside an Applications folder, register once (brief, decision 5) and
  store `loginItemInitialized` in the app's defaults so a user who turns it off
  is never re-registered. `.requiresApproval` is a state, not an error
  (slice 01, fallback 2).
- **CLI** (`apps/cli/src/app.ts`, `apps/cli/src/app-socket.ts`):
  - `localbox app status --json` → for now `app.info` plus the login item
    state; slice 12 grows it into the full facts shape.
  - `localbox app login-item [on|off] --json`.
  - Both use `ensureApp` first. With no app-managed layout they fail with
    `unsupported` and "this command needs Localbox.app".
- **`login`** in `index.ts` drops its `restartConnectorJob()` call when the
  layout is app-managed (the supervised connector picks the credentials up by
  itself, README A3). The call and `connector-job.ts` are deleted in slice 10.

## What the human can run

With the dev build installed as `~/Applications/Localbox Dev.app`:
`localbox app status --json`, `localbox app login-item off`, then `on`, and
see the item in System Settings › General › Login Items.

## Verification

- Swift driver tests: socket permissions; one line in, one out; a stale socket
  file from a dead app is replaced, a live one is not; `login_item.*` against a
  fake `SMAppService` driver, including `requires_approval` and the
  "user turned it off" rule.
- `node:test`: the app-socket client (success, app not running after
  `ensureApp` times out, `unsupported`).
- Probe 41 at tier `a` gains: `localbox app status` shows both children
  running; killing the daemon shows `backing_off` then `running`.
- Manual, on the real account with the dev build, undone afterwards: the login
  item really registers and survives a relaunch. (A dev build registers only
  when asked through `login-item on`, never by default.)

## Delegated to the implementer

Request ids on the socket; the defaults key name; error wording.

## Must stay green

Slice 08's suites; the contract snapshots (no catalog change here; these are
local commands).

## Feedback that would change this slice

Slice 01 ending in fallback 3 (a static LaunchAgent): `LoginItem` would then
own that plist instead of `SMAppService`, behind the same socket operations.
