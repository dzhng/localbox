# 10 · Release, agent install, and deleting the old path

Needs 01 (the launch command) and 09. This is the cutover:
after it the tree holds one install story.

## Contract

One command builds `Localbox-VERSION.zip` (the app, CLI inside), the Linux
image parts, `release.json` and `SHA256SUMS`. An agent installs with `curl`,
`shasum -c`, the pinned-key check, `ditto` and one open command, with no click
and no password. Nothing of the old path remains.

## API seam

- **`apps/macos/App/scripts/build-app.mjs`**: the one definition of the bundle
  layout (README, "Contracts"), for dev and release. Writes `Info.plist`
  (`LSUIElement`, `CFBundleIdentifier`, `LSMinimumSystemVersion` 14.0,
  `LocalboxLaunchLockRelativePath`; `SUFeedURL` and `SUPublicEDKey` are added
  by slice 15), `Resources/cli/version`, and `Resources/release-public.pem`.
- **`apps/macos/App/scripts/sign.mjs`**: a port of Bento's `signReleaseTree`
  (inside-out, `--timestamp=none`, no `--deep`), with the virtualization
  entitlement on `localbox-hostd` only, identifier `sh.localbox.cli` on the
  launcher and `node`, and the guest-agent files exempt. It uses the existing
  "Localbox Release" identity through the disposable-keychain logic lifted out
  of `scripts/release.sh`.
- **`scripts/release.sh`** shrinks to: read credentials (unchanged), build,
  `build-app.mjs --release`, `sign.mjs`, zip with `ditto`, then `packImage`,
  `makeManifest`, `signManifest`, `writeRelease` from `scripts/release.ts`.
  The CLI tarball and `NOTARY_PROFILE` are gone.
- **`skills/localbox/references/installation.md`** is rewritten around Bento's
  `skills/bento/references/setup.md`, keeping Localbox's stronger check:
  1. check `arm64` and macOS 14+ (and say macOS 27 is needed for macOS
     sandboxes); keep the hibernation section as it is;
  2. download `release.json`, `SHA256SUMS` and the app zip from
     `releases/latest/download` (not the image parts: the app fetches those);
  3. `shasum -a 256 -c` for the files downloaded, then verify `release.json`'s
     Ed25519 signature against the public key pinned in the procedure
     (`openssl pkeyutl -verify` or the snippet the implementer proves works on
     a stock Mac; no Node is available before install);
  4. `ditto -x -k` into a temp directory; if `~/Applications/Localbox.app`
     exists, quit it (`osascript -e 'quit app id "sh.localbox.mac"'`), wait for
     it to exit and move it to a temp backup; `ditto` the new app into
     (spike 01: confirm no `com.apple.quarantine` attribute is on it, and
     stop with a clear message if there is, because a quarantined app opens a
     Gatekeeper dialog that hangs every launch; never strip the attribute)
     `~/Applications` (use `/Applications` only when a copy is already there
     and writable);
  5. open it with the command slice 01 chose;
  6. verify: `~/.local/bin/localbox app status --json`, `cli status`,
     `skill status`, `host check`;
  7. tell the user Localbox now opens at login and how to turn it off; if the
     login item needs approval, say where to approve it.
  It also documents removal: `localbox agents setup off`, `localbox app
  login-item off`, quit, delete the app.
- **Deleted in this slice:** `scripts/install-release.sh`,
  `scripts/rollback-release.sh`, `scripts/uninstall.sh`,
  `scripts/localbox-path.sh`, `scripts/cli-launcher.sh`,
  `apps/macos/HostDaemon/Resources/sh.localbox.{hostd,connector,updater}.plist`,
  `apps/cli/src/updater.ts`, `apps/cli/src/connector-job.ts`, the `update` and
  `connector`-job rows and branches in `index.ts` (`update` returns in
  slice 15), `activateRelease`, `activeRelease`, `rollbackRelease` and
  `verifyInstalledRelease` in `scripts/release.ts`, the `installer`/`cli`
  fields and `releases/active` logic in `layout.ts`, `Reason` values `install`
  and `rollback`, the connector's unflagged exit-when-signed-out path and its
  `--supervised` flag (slice 08's seam: supervised is now its only mode), and their tests
  (`tests/updater.test.ts`, `tests/connector-job.test.ts`, the activation,
  rollback, installer and uninstall cases in `tests/release.test.ts`).
- **Rewritten:** `skill-lifecycle.md`; `DEVELOPMENT.md` ("Releases are the only
  install path", "Releasing", the install, rollback and uninstall section, the
  environment table); `.agents/skills/release/SKILL.md`;
  `apps/macos/HostDaemon/README.md`; the site's `llms.txt` source in
  `apps/site`; `.github/workflows/release-checks.yml` path filters; `SECURITY.md`
  (what is signed and verified); probe `14-agent-setup.ts`, which now drives an
  assembled app in a scratch `HOME` at tiers `u` and `a`; and
  `scripts/proof/lib/real-daemon.ts` only if it imported something deleted.

## What the human can run

On this Mac's real account, with a dev-id build published to a local directory
served over HTTP (Bento's D33 pattern): follow the new `installation.md` from
`ssh localhost`, see the menu bar item appear, run `localbox sandbox create`,
then undo everything with the removal steps.

## Verification

- `tests/release.test.ts`, reduced to manifest, signature, image pack and
  expand, and path traversal; plus a test that `installation.md` names real
  asset names and pins the same key as `skills/localbox/release-public.pem`.
- An assembler test: the plist keys; the launcher's lock string equals the
  plist key's value; guest-agent digests equal `agent-version.json`; the
  bundle's public key equals the skill's.
- New to Localbox (README, "Ported from Bento, not re-proven"): the bundled
  `node` runs a JIT-heavy loop without a code-signing kill; `localbox-hostd`
  run from inside the signed bundle boots a real VM (tier `v`); a `ditto` zip
  round trip still verifies.
- A packaged smoke: `codesign --verify --deep --strict`, then `localbox help`
  through the home command in a scratch `HOME`.
- Probe 14 at tiers `u` and `a`.
- `git grep -n -E "launchctl|releases/active|install-release|rollback" --
  apps packages scripts skills DEVELOPMENT.md` shows only the guest agent's own
  units and this spec.
- The signature-check snippet in `installation.md` is run on this Mac against
  a release signed with a scratch key, and against a tampered manifest.

## Delegated to the implementer

The zip's exact name; where the disposable-keychain helper lives; wording of
the docs within the steps above.

## Must stay green

`npm test`, `swift test`, probes at tiers `u`, `s`, `l`, `v`; the manifest
schema; the pinned key.

## Feedback that would change this slice

The user wanting `/Applications` regardless (it can need admin rights for a
standard user, which breaks decision 8).
