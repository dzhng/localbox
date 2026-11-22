# 13 · Popover

Needs 12. A visual slice.

## Contract

Clicking the status item opens a Bento-style popover (an `NSPopover`, not an
`NSMenu`) showing, top to bottom (brief, decision 3):

1. **Header:** the account's email or "Not signed in"; "Connected" or the
   connector's state; room left ("6 of 8 CPUs · 12 of 16 GB · 210 GB disk");
   the version.
2. **Warning band**, when `warnings` is non-empty: the first warning's message
   and its fix; a count if there are more.
3. **Sandboxes on this Mac:** name, OS, state. A copying sandbox shows a
   progress bar. Each row's menu: Copy Name; Sleep (running); Wake (asleep,
   paused, stopped); Open Log. No Delete and no Create.
4. **Images in progress:** name, "Building", "Copying" or "Downloading", phase
   and a progress bar. The built-in image's download appears here as "linux".
   The section is absent when nothing is in progress.
5. **Footer:** Settings… and Quit. While stopping, the popover shows "Putting
   N sandboxes to sleep…" with the pending names instead of the lists.

The status item's icon is a template image; it gains a warning variant when
`warnings` is non-empty.

## API seam

- **`PopoverPresentation(AppFacts) -> PopoverRows`** in `LocalboxAppCore`,
  pure: the strings, bars and enabled actions above. All copy lives here.
- **`LocalboxMenu`** (new library target; SwiftUI views, no process spawning):
  `PopoverView(rows:perform:)`. The executable hosts it in an `NSPopover`
  (Bento's `CapturePopover.swift` is the model for the host: transient
  behaviour, anchoring to the status item, no activation of other windows).
- **Actions** are argv arrays handed to `BundledCLI`: `sandbox sleep NAME`,
  `sandbox start NAME`, `sandbox logs NAME` (written to a temp file and opened
  with the default text viewer), and Copy Name (pasteboard only). A failed
  action shows the CLI's error message in the row until the next refresh.
- The slice 08 placeholder `NSMenu` is deleted.

## What the human can see

Offscreen shots for every fixture, light and dark, and the real popover in the
menu bar from `npm run app:dev`.

## Verification

- Unit tests on `PopoverPresentation` using slice 12's shared fixtures: signed
  out; connector down; hibernation blocked; idle and connected with no
  sandboxes (an empty state line, not a blank area); three sandboxes (running,
  asleep, copying 43%); twelve sandboxes (the list scrolls, the popover's
  height is capped); an image building and the built-in image downloading;
  stopping with two pending.
- **Offscreen view shots** (`apps/macos/App/tests/view-shots/`, Bento's
  `settings-view-shots.mjs` pattern: a stub renders the real view in an
  `NSHostingView` with synthetic facts, no window, no focus) for each fixture
  in light and dark, saved under `specs/menu-bar-app/evidence/13/`.
- **compare-screenshots** against a Bento popover reference. First render it:
  export Bento at the frozen commit with `git archive` into a scratch
  directory, run its `tests/capture-view-shots.mjs` there with output pointed
  at scratch, and copy the idle-state shot to
  `specs/menu-bar-app/assets/bento-popover.png`. **Slice variable: popover
  chrome** (material, corner radius, outer padding, row height, type ramp).
  **Crop:** the header band plus the first row. Content differs by design and
  is not judged; neither are icons. If Bento's shot cannot be built here,
  record that in `choices.md`, compare against the chrome values read from
  `CaptureView.swift`, and say so in the slice record rather than skipping.
- **screenshot-critique** as the last check on every shot, by an unprimed
  subagent, before the slice is accepted.
- Probe 41 at tier `a` gains: the popover opens through a test hook without
  the frontmost app changing, and a Sleep action changes the daemon's state.
- **Human checkpoint, non-blocking:** open the shots with preview-shots, give
  the user about five minutes, then decide on the evidence, record the decision
  in `choices.md`, close the shots and continue.

## Delegated to the implementer

Row layout, spacing and icons within Bento's chrome; the popover's width
(Bento's is the default); the status item glyph and its warning variant
(placeholder art is fine: a template PDF or SF Symbol, replaced later by
dropping a file at one documented path); the empty-state sentence; the test
hook's mechanism.

## Must stay green

Slice 12's fixtures and tests; probe 41.

## Feedback that would change this slice

The user reacting to the shots (density, what the header leads with); a request
for Delete or Create in the popover (out of scope today).
