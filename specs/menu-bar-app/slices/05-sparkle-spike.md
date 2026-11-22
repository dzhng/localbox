# 05 · Spike: patched Sparkle, N to N+1

Needs 02 (the supervisor app and a go) and 03 (the assembler). The largest
spike. Throwaway lab under `specs/menu-bar-app/spikes/05/`; the patch and build
script it produces are kept for slice 15.

## Question

Does Bento's Sparkle patch, re-applied under Localbox names, install a signed
update with no UI, while a VM hibernates and CLI clients drain?

## Reference (frozen)

`~/dev/bento` at `45a61d39f49e3bb431daecd9023fa4eb59950692`:
`apps/macos/scripts/sparkle/{bento.patch,upstream.json,build.mjs,framework.mjs,README.md}`
(Sparkle 2.10.0 at `eef1a539a373c1f1a320624b1130fc5de7b2e100`; Bento's pin file
calls the patch `runtime-unverified`, so this is a real proof, not a
formality), `scripts/launcher/main.c`, `Sources/Bento/SparkleDriver.swift`,
`UpdateCoordinator.swift`, and `scripts/installed-update-lab.mjs`.

The patch's Bento names: Info.plist key `BentoLaunchLockRelativePath`, relaunch
argument `--bento-update-relaunch`, relaunch environment allowlist
(`BENTO_RECORDING_HOME`, `BENTO_DEFAULTS`), and `BentoTerminationTimeout`
(20 s) and `BentoReplyTimeout` (10 s). A termination timeout revokes the
install permit.

## Steps

1. Copy the build scripts and re-apply the patch as `localbox.patch` with only
   names changed: `LocalboxLaunchLockRelativePath`,
   `--localbox-update-relaunch`, allowlist `LOCALBOX_MACHINE_ROOT` and
   `LOCALBOX_APP`. Build at the same pinned commit (needs full Xcode).
2. Build the lab: slice 02's supervisor, a minimal `SPUUserDriver` with no UI,
   the C launcher renamed for Localbox (README, "Names"), a local HTTP feed
   behind a 302, and versions N and N+1 from slice 03's assembler, signed with
   the scratch identity.
3. Sign the appcast two ways and try both: with a scratch Ed25519 key in
   Sparkle's own format, and with a scratch key in the release key's format
   (PKCS#8 PEM, as `release-private.pem` is), converting the public half to
   Sparkle's `SUPublicEDKey`.

## Checks

1. The update installs with no window and no App Management prompt in
   `~/Applications` (watch `tccd` logs).
2. A launcher started during replacement exits 75 `UPDATING`.
3. A client holding the shared lock delays the install; releasing it lets the
   install proceed.
4. **Gate order:** the daemon hibernates before the install permit is granted,
   so the 20 s termination timeout is never the hibernation budget.
5. A VM saved by daemon N restores under daemon N+1 with its marker process
   alive.
6. The N+1 daemon child starts with no launch-constraint violation.
7. `SMAppService.mainApp.status` is still `.enabled` after replacement.
8. Killing the installer mid-flight leaves a working N.
9. Sparkle accepts an appcast signed by a key in the release key's format.

## Verdict

**Go:** checks 1–8 pass. Check 9 decides the key: pass means the appcast uses
the existing release key (README, A9).

**Fallbacks.** Each needs the user's sign-off; stop and ask.

- Check 9 fails: a separate Sparkle seed in `.release-signing/` (new key
  material that must be backed up before the first publish).
- The patch cannot be made to work: stock Sparkle 2.10 with
  `SPUUpdaterDelegate` postponement, where the app takes the launch lock
  exclusively before allowing relaunch and the launcher also refuses on an
  `updating` marker file. The window between app exit and replacement is
  guarded only by the marker.
- Sparkle cannot work at all: decision 2 is dead.

## What the human can see

`spikes.md` section "05" with the nine checks; `apps/macos/App/sparkle/` is
*not* created yet (slice 15 moves the kept files there).

## Delegated to the implementer

Lab layout; feed server; how the shared-lock client is simulated.

## Must stay green

Nothing in the product changes.

## Feedback that would change this slice

The user preferring a separate Sparkle key regardless of check 9.
