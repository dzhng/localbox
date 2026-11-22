# 14 · Settings window

Needs 09 and 12. A visual slice with a reference.

## Contract

Settings copies Bento's window exactly where a section applies (brief,
decision 4): the same 560-point `NSWindow` hosting a grouped SwiftUI `Form`,
remembering its frame, with these sections in this order.

1. **About:** `LabeledContent("Version", …)`, as Bento's.
2. **Account** (replaces Bento's Workspace):
   - signed out: an email field and "Send Code";
   - code sent: "Enter the code we emailed to EMAIL", a code field, "Sign In"
     and "Use a Different Email";
   - signed in: the email, this Mac's name, and "Sign Out…" (with a
     confirmation: signing out removes this Mac from the account).
   Footer: "Signing in connects this Mac to your Localbox account."
3. **General**, copied from Bento's `generalSection`
   (`Sources/Bento/SettingsWindow.swift`, lines 554–600 at the frozen commit)
   with "Bento" replaced by "Localbox" and nothing else changed:
   - Toggle "Show this window when Localbox starts"
   - detail row "Set up my agents" with its summary and toggle
   - detail row "Open at login" with its description and toggle, the red
     failure line, and the "Open Login Items Settings…" button when the state
     is `requires_approval` or `not_found`
   - the updates rows. In this slice `update` is null, so the window shows
     Bento's other branch: "Updates are installed manually in this build."
     Slice 15 turns the rows on.

Bento's Permissions, Sync, Outbox & Storage, Recording and Shortcuts sections
and its admin-message banner are left out.

## API seam

- **`SettingsModel`** in `LocalboxAppCore`: state from `AppFacts` plus local
  form state; intents over a `SettingsActions` protocol whose production
  implementation calls `BundledCLI`:
  `login --email E`, `login --email E --code C`, `logout`,
  `agents setup on|off`, `app login-item on|off`. It refreshes when the window
  opens and after every mutation, as Bento's does. "Show this window when
  Localbox starts" is the app's own preference (the one setting that is not
  CLI state), default off.
- **`SettingsView`** in `LocalboxMenu`; **`SettingsWindow`** in the executable
  (Bento's `makeWindow` is the model: 560 wide, height
  `min(780, visible - 60)`, titled, closable, miniaturizable, frame restored
  only if still on a screen).
- Must compile for macOS 14: guard any API newer than 14 that Bento's code
  uses.

## What the human can see

Settings shots beside Bento's, and the real window from the popover's
Settings… item.

## Verification

- A Node runner with a fake CLI (Bento's `tests/settings-cli.test.mjs`
  pattern) asserting each control issues exactly the expected CLI call, and
  that a CLI failure shows its message without losing form state.
- Swift model tests: the three Account states and their transitions; the
  login-item states; the summary strings.
- **Offscreen view shots**, light and dark, saved under
  `specs/menu-bar-app/evidence/14/`: signed out; code sent; signed in; login
  item needing approval; agent setup needing attention.
- **compare-screenshots** against Bento's Settings. First render the
  reference: export Bento at the frozen commit with `git archive` into a
  scratch directory, run its `tests/settings-view-shots.mjs` there with output
  pointed at scratch (never a worktree in `~/dev/bento`), and copy the shots
  for the manual-updates state to `specs/menu-bar-app/assets/bento-settings-*.png`.
  **Slice variable: the product name string.** **Crops:** the About section,
  and the General section from its header to its footer, at 560 pt, light and
  dark. Pass means identical geometry, control order and wording apart from
  the name. The Account section has no reference and is judged by critique
  only. If Bento's shots cannot be built here, record that in `choices.md` and
  use a line-by-line diff of the two SwiftUI section bodies plus the user's
  eye; say so rather than skipping.
- **screenshot-critique** as the last check on every shot, by an unprimed
  subagent.
- **Human checkpoint, non-blocking:** open the shots with preview-shots, wait
  about five minutes, then decide on the evidence, record it in `choices.md`,
  close the shots and continue.

## Delegated to the implementer

The Account section's layout and field widths; its exact sentences (plain, in
the style of Bento's footers); the wording of the sign-out confirmation.

## Must stay green

Slice 12's fixtures; slice 13's shots (shared styles must not shift them).

## Feedback that would change this slice

The user naming another Bento section they want kept; a different sign-in
flow than the email code.
