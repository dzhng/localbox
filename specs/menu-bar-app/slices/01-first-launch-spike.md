# 01 · Spike: hands-off first launch and login item

No dependencies. Throwaway code under `specs/menu-bar-app/spikes/01/`.

## Question

Can an agent with only a shell put a self-signed, un-notarized `LSUIElement`
app into `~/Applications`, open it, and have `SMAppService.mainApp.register()`
return `.enabled`, with no click and no password? This is the user's seamless
install requirement (brief, decision 8) and Open at login by default
(decision 5).

## Probe

A small AppKit app (about 60 lines), bundle id `sh.localbox.spike.launch`,
signed with a scratch self-signed identity (the keychain already has one,
"Agent Computer Local"; never the release identity). On launch it writes one
JSON file to a path given by an environment variable or a fixed scratch path:

```json
{ "status_before": "...", "status_after": "...", "register_error": null,
  "screens": 1, "foreign_windows": ["owner names from CGWindowListCopyWindowInfo"],
  "pid": 123 }
```

then shows a status item and stays alive. `foreign_windows` exists to catch a
modal from `CoreServicesUIAgent` or `UserNotificationCenter`.

## Legs

| Leg | Command | Records |
| --- | --- | --- |
| a | `open -g ~/Applications/Spike.app` from this GUI session | the JSON |
| b | `ssh localhost 'open -g ~/Applications/Spike.app'` | the JSON; `open`'s exit code |
| c | leg a after `xattr -w com.apple.quarantine …` on the bundle | the failure mode, for the docs |
| d | quit, `open -g` again | `status_before` is still enabled |
| e | replace the bundle with a re-signed rebuild using `ditto`, open | status still enabled |

Also save `log show --last 5m --predicate 'subsystem ==
"com.apple.backgroundtaskmanagement"'` and any `tccd` prompt lines for each leg.

## Verdict

**Go:** legs a, b, d and e report `.enabled`, the process is running, and
`foreign_windows` shows no modal. A notification banner ("Background Items
Added") is fine.

**Fallbacks, in order.** Record which one applies; 3 needs the user.

1. `open` fails over SSH: retry with `launchctl asuser $(id -u) open -g …`. If
   that works, the install procedure uses it.
2. `register()` returns `.requiresApproval`: the app still runs now. The plan
   continues; facts carry `open_at_login: "requires_approval"`, the popover
   warns, the agent tells the user, and Settings shows Bento's Login Items
   button. The install stays hands-off; only surviving a reboot is degraded.
3. Neither launch path works, or the user rejects 2: a static LaunchAgent whose
   program is Apple's `/usr/bin/open -g <app>` never changes on update, so
   Bento's launch-constraint dead end does not apply. It contradicts "no
   launchd jobs". **Stop and ask the user.**

## What the human can see

`spikes.md` gains a section "01" with a table of the five legs and the verdict.
The scratch app is deleted, its login item unregistered
(`SMAppService.mainApp.unregister()` from a `--unregister` flag) and
`~/Applications/Spike.app` removed.

## Delegated to the implementer

The modal-detection method; the JSON path; how the scratch app is built
(`swiftc` or a SwiftPM package).

## Must stay green

Nothing in the product changes. `npm test` and `swift test` are untouched.

## Feedback that would change this slice

The user accepting or rejecting fallback 2 in advance; a second Mac becoming
available for a real headless leg (then run legs b and d there too and record
`screens: 0`).
