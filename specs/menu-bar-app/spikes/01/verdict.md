# Spike 01 verdict: hands-off first launch and login item

Run 2026-11-22 05:23–05:35 PST on macOS 27.0.1 (26A434), one display, user
logged in at the console with the **screen locked** for the whole run
(`CGSSessionScreenIsLocked: 1`).

**Verdict: go, with leg b unproven over real SSH.** No fallback is needed on
this evidence. Legs a, d and e meet the slice's bar. Leg b could only be
approximated (see below); both approximations passed.

## Deviations from the slice, read these first

1. **Signing identity.** `codesign --sign "Agent Computer Local"` blocked on a
   keychain access dialog (`SecurityAgent`, 434×182) and never returned, so the
   bundle was signed with a throwaway self-signed code-signing identity,
   "Localbox Spike 01 Scratch", in a scratch keychain under `/tmp` that was
   never added to the search list and is now deleted. That cert is untrusted
   (`CSSMERR_TP_NOT_TRUSTED`); "Agent Computer Local" shows as a valid
   identity. Nothing named "Localbox Release" was used or created.
2. **Leg b is an approximation.** `ssh -o BatchMode=yes localhost true` fails
   (`Host key verification failed`; with host-key checking off:
   `Permission denied (publickey,password,keyboard-interactive)`). sshd,
   `authorized_keys` and `known_hosts` were not touched. The stand-ins ran in
   this session's own bootstrap (`launchctl managername` = `Aqua`), so they
   prove a stripped environment and no controlling terminal, **not** an SSH
   session's `Background` bootstrap.

## Legs

Every row is from the JSON the app wrote (`evidence/01/<leg>.json`).
`modal` is read from `foreign_windows`, sampled 4 s after `register()`.

| Leg | Command | `open` exit | `status_before` | `status_after` | `register_error` | `screens` | `pid` | New window after launch |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | `open -g ~/Applications/Spike.app` | 0 | `notFound` | `enabled` | `null` | 1 | 69978 | `Notification Center@21` only (the banner) |
| b (approx, stripped) | `env -i HOME USER PATH … perl setsid … sh -c 'open -g ~/Applications/Spike.app'`, after `--unregister` | 0 | `notRegistered` | `enabled` | `null` | 1 | 71089 | none |
| b (approx, fallback 1 command) | `env -i HOME="$HOME" PATH=/usr/bin:/bin /bin/launchctl asuser $(id -u) /usr/bin/open -g "$HOME/Applications/Spike.app"` | 0 | `enabled` | `enabled` | `null` | 1 | 71930 | none |
| d | quit, `open -g ~/Applications/Spike.app` | 0 | `enabled` | `enabled` | `null` | 1 | 72181 | none |
| e | rebuild (build 2, new cdhash), re-sign, `ditto` over the bundle, `open -g` | 0 | `enabled` | `enabled` | `null` | 1 | 73315 | none |
| c | `xattr -w com.apple.quarantine` on the already-launched bundle, `open -g` | 0 | `enabled` | `enabled` | `null` | 1 | 73608 | none; ran translocated |
| c2 | never-launched build 3, quarantined before the first `open -g` | 0 | no JSON | no JSON | – | – | 75763 (held) | `CoreServicesUIAgent@8`, 260×268: the Gatekeeper modal |

In every passing leg the process was running afterwards, `status_after_4s`
was `enabled`, `status_item_visible` was `true`, and a separate
`Spike --status` printed `enabled`.

`foreign_windows` in every leg also lists `SecurityAgent@1000` and
`loginwindow@2000/2001`. Both were on screen **before** the app launched
(`foreign_windows_before`): the first is the keychain dialog from the blocked
`codesign` above, the second is the lock screen. Neither was caused by the app.

Leg a's first-launch JSON, trimmed of window and environment lists:

```json
{ "build": "1", "bundle_path": "/Users/server/Applications/Spike.app",
  "pid": 69978, "ppid": 1, "register_error": null, "sampled_after_s": 4,
  "screens": 1, "status_after": "enabled", "status_after_4s": "enabled",
  "status_before": "notFound", "status_item_visible": true }
```

## Log excerpts

Leg a, `com.apple.backgroundtaskmanagement` (`evidence/01/a.btm.log`):

```
registerLaunchItem: result=no error, new item=uuid=20645712-…, name=Spike, type=app, disposition=[enabled, allowed, n…
smd: getEffectiveDisposition: disposition=[enabled, allowed, notified], have LWCR=true
BackgroundTaskManagementAgent: Posting advisory notification request: … body='“Spike” will open automatically when you log …
```

Leg e, after the cdhash changed from `7c403033…` to `95cb85e1…`
(`e.cdhash.txt`, `e.btm.log`):

```
registerLaunchItem: found existing item: uuid=20645712-…, name=Spike, type=app, disposition=[enabled, allowed, notified]
smd: getEffectiveDisposition: disposition=[enabled, allowed, notified], have LWCR=true
```

TCC (`<leg>.tcc-gk.log`): `tccd` evaluated `kTCCServiceScreenCapture`,
`kTCCServiceListenEvent` and `kTCCServiceAppleEvents` for the app in every
leg. No prompt window appeared. `ScreenCapture` comes from the probe's own
`CGWindowListCopyWindowInfo` call, so it says nothing about the product.

Leg c2 (`c2.gatekeeper.log`, `c2-fresh-build-quarantined.tcc-gk.log`):

```
syspolicyd: Error checking with notarization daemon: 3
syspolicyd: allowUI is YES, creating codeEval object
LAUNCH: Successful launched … pid=75763 sh.localbox.spike.launch (quarantined)
LAUNCH: … launched with launchInQuarantine == true, so not starting the application.
QUARANTINE: Setting risk category to LSRiskCategoryUnsafeExecutable
```

## Leg c: the failure mode, for the docs

- A quarantined bundle that has **never run** fails silently from a shell:
  `open -g` exits 0, a process exists but is held before `main` (no JSON, no
  status item), and a Gatekeeper modal waits on screen. An agent sees success.
- While that modal is open, **every** exec from `~/Applications/Spike.app`
  hangs in `_dyld_start` (`c2.exec-held.txt`), even after the bundle was
  replaced with an unquarantined, previously accepted build. The same binary
  ran normally from `/tmp`.
- Quarantining a bundle that had already run did not block it: it launched
  translocated (`bundle_path` under `AppTranslocation`) and `register()` still
  returned `enabled` against the `~/Applications` item.
- `ditto` preserves `com.apple.quarantine`. The install procedure must never
  let the attribute reach the bundle (`curl` and `ditto -x -k` do not set it)
  and should assert its absence before the first `open`.

## Surprises

- Signing with "Agent Computer Local" needs a click. Any spike or build that
  signs with it from an agent session will block the same way. Another
  session's `codesign --sign "Agent Computer Local" --identifier
  sh.localbox.spike.hostd` was seen blocked during this run.
- `launchctl asuser $(id -u)` works without root for the same user, so
  fallback 1 is available if a real SSH leg needs it.
- `SMAppService.mainApp` resolved by bundle id, not path: a copy in `/tmp`
  read `enabled` and its `unregister()` disabled the `~/Applications` item.
- `unregister()` leaves the Background Task Management record in place,
  disabled (`disposition=[disabled, allowed, notified]`). A later `register()`
  finds it and posts no second banner.
- `sfltool dumpbtm` asks for an admin password; do not use it in a probe.

## Not proven here

- A real SSH (`Background` bootstrap) launch. Run legs b and d from a second
  machine, or after the user enables key auth to localhost.
- The same legs signed with the real, trusted-in-keychain identity.
- An unlocked screen (whether the banner or a modal behaves differently).
- Surviving a logout or reboot.

## What was undone

- Login item unregistered: `{"status_before":"enabled","status_after":"notRegistered","unregister_error":null}`,
  confirmed by two later `--status` runs printing `notRegistered`
  (`cleanup.txt`, `cleanup.btm.log`). The unregister had to run from the
  `/tmp` build because the installed copy's exec was held by the leg c2 modal.
- No `Spike` process is running. `~/Applications/Spike.app` is deleted.
  `~/Applications` existed before the run and was kept.
- The scratch keychain and all of `/tmp/localbox-spike-01` are deleted. The
  keychain search list and the login keychain are unchanged.

**Left behind, needs the user:** two dialogs under the lock screen that no
process of this run owns: the Gatekeeper modal for Spike from leg c2
(`CoreServicesUIAgent`; choose Done/Cancel, not Open) and the keychain access
dialog for "Agent Computer Local" (`SecurityAgent`; Deny, unless the other
session's signing should proceed). A disabled "Spike" record also remains in
Background Task Management; `sfltool resetbtm` would clear it but resets every
login item, so it was left.
