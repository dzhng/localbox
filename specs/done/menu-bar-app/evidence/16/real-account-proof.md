# Real-account proof (slice 16)

Run 2026-11-22, 19:24–19:41 UTC, on the development Mac's own account (Mac mini, 12 CPUs, 24 GiB, macOS 27.0.1),
screen locked with no password (`host check`: `hibernate: available`). Bento's D33 pattern: a release-shaped install
on the real account, then undone and proven gone.

## What was installed, and how it was kept apart from a real install

| | Rehearsal | A real release |
| --- | --- | --- |
| Bundle | `~/Applications/Localbox Rehearsal.app`, id `sh.localbox.mac.rehearsal` | `Localbox.app`, `sh.localbox.mac` |
| Code signature | throwaway self-signed "Localbox Rehearsal Scratch", disposable keychain | "Localbox Release" |
| Manifest and feed key | scratch Ed25519 key, made for this run and deleted after | the pinned release key |
| Feed and release | `http://127.0.0.1:18716` (a local server with `Range`) | GitHub, `localbox.sh/mac/appcast.xml` |
| Machine root, logs, credential | `~/Library/{Application Support,Logs}/Localbox (sh.localbox.mac.rehearsal)` | `…/Localbox`, `~/.config/localbox/credentials.json` |
| Launch lock | `~/Library/Caches/sh.localbox.mac.rehearsal/launch.lock` | `~/Library/Caches/sh.localbox.mac/launch.lock` |
| Home command, skill | `/tmp/lbr16/agent-home/.local/bin/localbox`, skill under `/tmp/lbr16/agent-home` | `~/.local/bin/localbox`, `~/.agents/skills/localbox` |
| Account | a local dev stack (`scripts/proof/stack.ts up`), code read from its log | Resend email codes |

Bundles were `build-app.mjs --release` output (release Swift builds, the patched Sparkle) made rehearsal-shaped
before signing, as probe 44 does: `CFBundleIdentifier`, `CFBundleName`, `SUFeedURL`, `NSAllowsLocalNetworking`, a
launcher compiled with the rehearsal's lock path and `LocalboxLaunchLockRelativePath`, and an `LSEnvironment`
(`LOCALBOX_BIN_DIR`, `LOCALBOX_SKILL_HOME`, `LOCALBOX_RELEASE_URL`, `LOCALBOX_API_ORIGIN`) that every LaunchServices
launch applies (step 5's `open`, the login item, Sparkle's relaunch). The release folder held what `release.sh`
writes: the zip, a signed `appcast.xml`, the minimal Linux image's parts, a signed `release.json`, `SHA256SUMS`. No
real release key or identity was read, copied or created.

## Before

`~/.local/bin/localbox`, `~/.agents/skills/localbox`, `~/.claude/skills/localbox`, `~/.codex/skills/localbox`,
`~/Library/Application Support/Localbox`, `~/Library/Logs/Localbox` and `~/.config/localbox/credentials.json` did not
exist; no shell profile mentioned localbox (sha256 of `.zshenv`, `.zprofile`, `.zshrc`, `.profile` recorded and the
files backed up); nothing under `~/Library` named the rehearsal id; no defaults domain; no process.

## Steps

The installation procedure's own blocks (cut from `installation.md` by `scripts/proof/lib/installation.ts`), each run
in a detached shell (`nohup env -i HOME USER LOGNAME SHELL PATH=/usr/bin:/bin:/usr/sbin:/sbin TMPDIR
LOCALBOX_RELEASE_URL … </dev/null &`), as an SSH session would; key login to localhost is not set up, so a true SSH
run stays on the [manual runbook](../../manual-runbook.md). Substituted: the app's name and id, the pinned key in step 3,
and the home command's path in step 6.

1. **Check the Mac:** `arm64`, `27.0.1`.
2. **Download:** exit 0.
3. **Verify:** exit 0, `Localbox 0.16.0: release.json is signed by the pinned key`, `Localbox-macos-arm64.zip: OK`.
4. **Put in place:** exit 0, no quarantine.
   - **Pre-launch isolation check (refused once).** The installed bundle's own CLI code, run with its own Node, printed
     the paths it would use. The first bundle answered the real root and `~/.config/localbox/credentials.json`: it had
     been assembled from a `dist/` compiled before the root change (`b0d91fd`). It was deleted unlaunched, `dist/`
     rebuilt, N rebuilt and steps 2–4 rerun; the second answered the rehearsal root, its own credential, the scratch
     command directory and skill home.
5. **Open:** exit 0; the app, `localbox-hostd --supervised` and `connector run` ran from `~/Applications`.
6. **Check:** exit 0. `app status`: `0.16.0`, `build: release`, daemon `running`, `open_at_login: enabled`,
   `hibernate: available`, `update.status: You’re up to date.`, the built-in image `downloading` (`expanding`).
   - The daemon's start-time agent setup installed the skill for 56 harnesses and the command, both under
     `/tmp/lbr16/agent-home` (hostd.log). Step 6's own `cli status` and `skill status` read `missing`: they ran in the
     stripped shell, without the bundle's `LSEnvironment`, so they looked at the real paths. With the same environment
     (a wrapper), `cli status` was `installed` (the rehearsal's launcher), `skill status` `installed`, `managed: true`,
     `source_revision: 0.16.0`. A rehearsal artifact, not a procedure fault.
   - Built-in image: `ready` within two minutes, fetched from the local release (`release.json`, `SHA256SUMS`, the
     zst part, `efi-vars`, `image.json`).
   - Login item: `app login-item` → `enabled` (a real `SMAppService` registration for the rehearsal id).
7. **Sign in** (local stack): `login --email rehearsal@example.com`, then the code from the stack's log →
   `Signed in … 1 machine`; `app status` connector `connected`, the credential written only in the rehearsal root.
8. **Sandbox:** `sandbox create --name rehearsal-one --memory 2G` → `created`, image `linux`, 6 CPUs, 2 GiB;
   `shell exec -- uname -a` → `Linux rehearsal-one 6.8.0-151-generic … aarch64`. A process counting every 0.2 s in
   `/run/rh-counter` was started (443 at publish time).
9. **N to N+1:** 0.16.1 built the same way and published by replacing the served release folder. `update check` at
   19:34:46: Sparkle fetched `appcast.xml` and the zip; app.log: `stopping (update): waiting for rehearsal-one`,
   `Installing Localbox 0.16.1…`, `exiting for the update`, `relaunched by an update into 0.16.1` at 19:34:50
   (`--localbox-update-relaunch`). After: Info.plist `0.16.1`, `codesign --verify --deep --strict` ok, the home
   command byte-identical to N+1's launcher, `rehearsal-one` `last_boot.kind: woke` ("restored rehearsal-one from its
   saved state"), counter 1056 then 1062 a second later (it kept its memory and climbs). N+1's image check fetched only
   `release.json` (same disk digests).
   - **Finding, fixed:** `update check` answered `idle, "You’re up to date."` at once, the previous cycle's answer,
     while the update was in fact being installed. `UpdateCoordinator.check()` asked Sparkle asynchronously and only
     Sparkle's callback set `checking`, so the CLI's wait for a busy state saw none. The coordinator now reports
     `checking` before asking Sparkle; `update-coordinator.test.mjs` pins it.
10. **The CLI starts the app:** `osascript -e 'quit app id "sh.localbox.mac.rehearsal"'`, no process left; the next
    `localbox app status` started the app and answered (daemon `starting`, then `running`); `rehearsal-one` woke again.

## Undo

The new "Removing Localbox" steps, with the rehearsal's names (the sandbox deleted first):

```
$ localbox sandbox delete rehearsal-one --confirm rehearsal-one   deleted: catalog entry, identity, disk, boot store
$ localbox logout                                                signed_out: true
$ localbox agents setup off                                      turned_off
$ localbox skill uninstall                                       uninstalled /tmp/lbr16/agent-home/.agents/skills/localbox
$ localbox app login-item off                                    state: disabled
$ osascript -e 'quit app id "sh.localbox.mac.rehearsal"'         (waited until not running)
$ rm -rf ~/Applications/"Localbox Rehearsal.app" <home command>
```

Left by the procedure, as documented, then removed by hand: the rehearsal root and logs, `~/Library/Caches/<id>` (the
launch lock and Sparkle's cache), `~/Library/HTTPStorages/<id>`, the defaults domain (`defaults delete`, then its
plist), and a stale LaunchServices record for the deleted bundle (`lsregister -u`). The procedure now names the logs,
caches and settings too. The release server and the local stack were stopped; `/tmp/lbr16` (scratch keys, identity,
builds, the scratch skill home) was deleted.

## After

The same snapshot as before, line for line, except the release server no longer running: no
`~/.local/bin/localbox`, no global skill in any harness, profiles byte-identical to their backups (no PATH block was
ever written: agent setup's command went to the scratch directory), no real root, logs or credential, nothing under
`~/Library` naming the rehearsal id, no defaults domain, no LaunchServices record, no process.

Not verifiable here: whether System Settings > Login Items keeps a disabled record for the rehearsal. `SMAppService`
reports `disabled` after `login-item off`; listing Background Task Management's records (`sfltool dumpbtm`) asks for
an administrator and was not run.
