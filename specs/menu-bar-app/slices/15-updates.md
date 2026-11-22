# 15 · Updates

Needs 10 and 14. The Sparkle mechanism is ported from Bento, not spiked.

## Contract

Sparkle is the only updater. An update installs with no Sparkle window, waits
for sandboxes to hibernate and for running `localbox` commands to finish, and
relaunches into the new version with sandboxes waking. `localbox update
check|install|status` works through the app. There is no rollback (brief,
decision 9).

## API seam

- **`apps/macos/App/sparkle/`**: `localbox.patch`, `upstream.json` (Sparkle
  2.10.0 at `eef1a539a373c1f1a320624b1130fc5de7b2e100`, with the patch's
  SHA-256) and `build.mjs`: Bento's `scripts/sparkle/` at the frozen commit
  with the patch re-applied under Localbox names only (README, "Names"). The app package links Sparkle
  only when `LOCALBOX_SPARKLE_FRAMEWORK` is set (as Bento's does with
  `BENTO_SPARKLE_FRAMEWORK`); without it the package builds a dev app whose
  `update` fact is null.
- **`SparkleDriver`** (executable target): a custom `SPUUserDriver` with no
  Sparkle UI, a port of Bento's. Relaunch passes `--localbox-update-relaunch`.
- **`UpdateCoordinator`** (`LocalboxAppCore`, the only owner of update
  gating). `install(automatic: Bool)` runs, in order:
  1. **Blockers.** A built-in image fetch in its `installing` phase blocks. For
     `automatic` only: sandboxes running while `hibernate` is not `available`
     blocks, with status "Waiting: sandboxes would restart. Install from
     Settings, or unlock this Mac." (README, A12). A manual install proceeds.
  2. Stop the connector.
  3. Stop the daemon through `Lifetime` (reason `update`) and wait for it to
     exit, with no deadline of Sparkle's.
  4. Wait until no CLI client holds the shared launch lock; status "Waiting
     for localbox commands to finish".
  5. Grant Sparkle's install permit and exit within its 20 s termination
     timeout (nothing slow is left by now).
  Any failure before step 5 restarts the children and reports why.
- **App socket:** `update.check`, `update.install`, `update.status`,
  `update.set_automatic { enabled }`. **CLI:** `localbox update
  check|install|status [--json]` and `localbox update automatic on|off` are
  clients of those. `AppFacts.update` becomes `{ available: true, enabled,
  can_check, status?, version? }`.
- **Settings:** the General section's update rows turn on exactly as Bento's:
  the toggle "Automatically download and install updates", the "Check for
  Updates" button, the status line, and the footer ("Installs when sandboxes
  and background work are idle." / "Automatic updates are off. You can still
  check and install manually."). Only that first footer sentence differs from
  Bento's, which mentions recording.
- **Release:** `build-app.mjs --release` adds `SUFeedURL`
  (`https://localbox.sh/mac/appcast.xml`), `SUPublicEDKey`,
  `SURequireSignedFeed`, `SUVerifyUpdateBeforeExtraction`,
  `SUEnableAutomaticChecks`, `SUScheduledCheckInterval` 3600, and Sparkle's
  automatic-install keys off (the coordinator decides). `scripts/release.sh`
  writes and signs `appcast.xml` as a release asset with the existing
  release key (README, A9). The first step of this slice checks Sparkle accepts
  a feed signed by a key in that format (a scratch key of the same kind); if it
  does not, stop and ask the user before creating a separate Sparkle key. Automatic install defaults to **on** in the app's preferences.
- **Site:** `apps/site/vercel.json` gains permanent paths that 302 to the
  latest GitHub release: `/mac/appcast.xml` →
  `releases/latest/download/appcast.xml`. The hostname and path never change
  once an app ships.
- After a relaunch into a new version, `Lifetime` runs `app image ensure`
  (slice 11), and the daemon's start-time reconcile refreshes the home command
  and skill from the new bundle.

## What the human can run

`localbox update check --json`; in the update lab, publish N+1 to a local feed
and watch the popover say "Putting 1 sandbox to sleep…", the app relaunch, and
the sandbox report `woke`.

## Verification

- Swift driver tests: a port of Bento's `tests/update-coordinator.test.mjs`:
  gate order, each blocker, the automatic-versus-manual rule, children
  restarted on failure, exit inside the timeout.
- `node:test`: the `update` CLI verbs against a fake app socket; a site test
  for the redirect.
- Probe `43-installed-update.ts` (a port of Bento's `scripts/installed-update-lab.mjs`; scratch signing
  identity, scratch feed key, local feed, scratch `HOME`):
  - tier `a`: N to N+1 on the fixture backend; a `localbox` call during
    replacement gets exit 75 and succeeds on retry; a long-running call delays
    the install; the home command's bytes equal N+1's launcher afterwards;
    the login item is still enabled; killing the installer leaves a working N.
  - tier `v`: the same with one real VM whose marker process survives.
- **View shots** of the General section's update states (`enabled`,
  `disabled`, `checking`, `up to date`, `waiting`, `failed`), light and dark,
  under `specs/menu-bar-app/evidence/15/`, with **compare-screenshots** against
  the same-named state from Bento's `settings-view-shots.mjs` (slice variable:
  the product name string plus the one footer sentence; crop: the General
  section), then **screenshot-critique** as the last check.
- **Human checkpoint, non-blocking,** as in slice 14.

## Delegated to the implementer

The appcast generator (Sparkle's `generate_appcast` or a small script, as long
as the feed is signed with the chosen key); the wording of status lines not
quoted above; where the automatic-install preference is stored.

## Must stay green

Probe 41 (lifetime) and 42 (image); slice 14's shots other than the update
rows; the manifest schema and pinned key.

## Feedback that would change this slice

Sparkle refusing the release key's format (then the user decides on a separate key); the user wanting automatic install off by default.
