# 11 · Built-in image on first launch

Needs 04 (go) and 10.

## Contract

A Mac with no `images/linux`, or one whose digest differs from this release's,
fetches the built-in image by itself: verified, resumable across a quit, with
progress anyone can read. Until it is ready, `sandbox create` from `linux`
fails with a clear, retryable error that carries the progress.

## API seam

- **`localbox app image ensure --json`** (`apps/cli/src/builtin-image.ts`; the
  only writer of `images/linux`, README invariant 9):
  1. read this release's version from `layout().revision`;
  2. fetch
     `https://github.com/dzhng/localbox/releases/download/v<version>/release.json`
     (repository overridable by the existing `LOCALBOX_RELEASE_REPOSITORY`, and
     by a `file://` or `http://localhost` base for tests) and verify it with
     `verifyManifestSignature` against `Resources/release-public.pem`;
  3. if the installed `image.json` digest already equals the manifest's, print
     `ready` and exit: an update with an unchanged image downloads nothing;
  4. download each part with `Range` resume (or spike 04's fallback) into
     `<root>/downloads/linux-<version>/` (spike 04: `ImageStore`'s start-time
     sweep deletes anything staged under `<images>`), check each SHA-256;
  5. `expandImage`, then `installLinuxImage`, then delete the staging
     directory;
  6. print JSON lines `{ phase: "downloading" | "expanding" | "installing" |
     "ready" | "failed", done_bytes, total_bytes, error? }` and write the last
     one to `<root>/builtin-image.json`.
  A second `ensure` while one runs exits at once with the current state (a
  lock file in the staging directory).
- **App:** `Lifetime` runs `app image ensure` as a supervised one-shot at
  launch and after an update relaunch, retrying with the supervisor's backoff
  on failure. It is not restarted after `ready`.
- **Daemon:** when a create names `linux` and `images/linux` is absent, the
  refusal is `sandbox_not_ready`, retryable, with message "the built-in image
  is still downloading (N of M); try again when `localbox app status` shows it
  ready". The relay's create path passes it through. This is the only daemon
  change; the daemon does not fetch.
- **Install against the sweep (spike 04):** `expandImage` gains a progress
  callback and cleans its pid-named temp on the next run; the final
  `installLinuxImage` step must not be swept by a daemon starting mid-install
  (`ImageStore.sweepTemps` spares temps of running subjects only), so `ensure`
  expands in `<root>/downloads/` and the install into `<images>` is one
  rename.

## What the human can run

Install per slice 10 with `images/linux` removed: `localbox app status --json`
shows the image `downloading` with bytes climbing; quit and reopen mid-way: it
resumes; then `localbox sandbox create` works.

## Verification

- `node:test` with spike 04's fault server: resume after a cut; a truncated
  part, a flipped byte and a bad signature each end `failed` with
  `images/linux` untouched; already-current exits without a request for parts;
  a second `ensure` during a run returns the running state.
- `swift test`: the create refusal when the built-in image is absent.
- Probe `42-builtin-image.ts`, tier `a`: launch against a local release
  directory with no image; `app status` reaches `ready`; a create issued
  mid-download gets the retryable refusal with progress; a create afterwards
  succeeds on the fixture backend.
- One manual run against a real published release, time and peak disk recorded.

## Delegated to the implementer

Retry timing inside the supervisor's backoff; progress granularity; the lock
mechanism in the staging directory.

## Must stay green

`tests/release.test.ts`; `installLinuxImage`'s use by
`scripts/proof/lib/real-daemon.ts`; probes that seed `images/linux` directly.

## Feedback that would change this slice

The user wanting remote callers to see the download as an `image list` row:
that would move ownership to a daemon host operation (README, A6's lost
alternative).
