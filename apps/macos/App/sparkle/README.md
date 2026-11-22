# Localbox's Sparkle

The [upstream pin](upstream.json) and [patch](localbox.patch) bind the framework's
source: Bento's maintained patch at its frozen commit, re-applied under Localbox's
names (the Info.plist key `LocalboxLaunchLockRelativePath`, the relaunch argument
`--localbox-update-relaunch`, the relaunch environment `HOME`,
`LOCALBOX_MACHINE_ROOT`, `LOCALBOX_APP`). A stock framework does not implement this
installation contract. The patch keeps Sparkle's MIT [license](LICENSE).

The installed host owns the launch lock's path; the helper takes that lock
exclusively when the host grants permission, holds it through replacement and the
quiet relaunch, and gives up rather than wait if a command holds it. Only the
host's explicit permission and its own exit let a staged update replace the
bundle: an ordinary quit, a crash or a killed helper leave the old one. The app's
[`SparkleDriver`](../Sources/Localbox/SparkleDriver.swift) and
[`UpdateCoordinator`](../Sources/LocalboxAppCore/UpdateCoordinator.swift) own the
host's side.

## Source build

[`build.mjs`](build.mjs) (`npm run sparkle:build`) builds from a separate checkout
at the pin, never a shared one. It compares the raw source with the pinned tree
plus patch, rejects unexpected inputs, rechecks them after compiling, and writes a
receipt binding the inputs to the framework's file digests;
`build-app.mjs` checks that receipt before linking or embedding the framework.
Full Xcode, past its first-launch setup, is required. The built framework and the
source checkout stay in `dist/` and are never committed.
