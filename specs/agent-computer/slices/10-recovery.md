# Slice 10 — Recovery and demand lifecycle

## Contract unlocked

Sleep, wake, network changes, process crashes, and desktop demand changes heal
without duplicate mutations or stale channels.

## API seam and ownership

The host daemon owns lifecycle states (`stopped`, `starting`, `running`,
`paused`, `stopping`, `error`), reconnect supervision, and local operation
observation. The guest owns process cleanup and its mutation journal. Desktop
startup is demand-driven by live work/viewers plus a grace interval.

## Runnable artifact

`agent-computer recovery probe` injects sleep/network/channel drops, kills the
guest gateway, runs a long command, opens a desktop viewer, and emits a timeline
report with final VM and operation state.

## Verification

- Reads retry only when safe; mutations never blindly replay.
- Uncertain mutations can be resolved by status or exact replay when advertised.
- Channel epochs prevent stale reconnects.
- Desktop restarts after demand returns and reaps after demand disappears.
- Forced app quit leaves no leaked process or lock and resumes cleanly.

## Human review

Review the recovery timeline and status language; no visual gate unless a status
window changes in this slice.
