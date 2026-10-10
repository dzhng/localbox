# Slice 12 — macOS app and host controls

## Contract unlocked

A user can install the app, have the default VM and outbound relay start
automatically, and control lifecycle without learning VM or relay internals.

## API seam and ownership

The Swift/SwiftUI app and host daemon own VM registry, image/disk paths, relay
connection, keychain material, and status UI. First launch provisions and starts
the default VM and relay; desktop/browser services remain demand-started. The
UI calls the same catalog operations as the CLI; it does not add a policy layer
or host access.

## Runnable artifact

A development `.app` shows first-run, starting, ready, disconnected, paused,
and reset states. Controls expose start, pause, stop, open desktop, revoke, logs,
and explicit reset/reprovision.

## Verification

- App restart preserves VM state and connection identity.
- No unbounded idle CPU, memory, or battery work.
- Host entitlements and filesystem access are audited.
- All controls map to catalog calls and have CLI-equivalent results.

For every changed status-window shot, run `screenshot-critique` last. Use
`compare-screenshots` only when an approved target exists, with the status-window
crop as the mask. Human review through `preview-shots` is non-blocking.
