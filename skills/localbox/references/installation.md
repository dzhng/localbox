# Install Localbox

Use this when `localbox` is missing and the user asked for it. You install one
signed GitHub release; the release's own installer sets up everything else,
including this skill. Do not build from source, do not run `npx skills add`, and
do not copy the skill into any agent directory yourself: the installer does it,
records that Localbox owns it, and keeps it matched to every later release.

## Check the Mac

`uname -m` must print `arm64` and `sw_vers -productVersion` must be 14 or newer.
Anything else (Intel, Linux, Docker) cannot run Localbox; say so and stop.

## Prepare the Mac so sandboxes can hibernate

A sleeping sandbox hibernates: its memory is saved to disk, its RAM is freed,
and its processes resume on the next request. Updates and service restarts
hibernate running sandboxes the same way, so their processes survive. Apple's VM
framework encrypts the saved memory with a key from the logged-in user's
session, and refuses while that session is locked with a password. So:

- **Hibernation needs a logged-in session whose screen lock asks for no
  password.** A sleeping display or screen saver is fine (measured). Where the
  lock asks for a password and the screen is locked, a sleeping sandbox pauses
  in memory instead: its processes keep their state, but its RAM is not freed,
  and a sandbox put away to make room boots fresh at its next use.
- **A headless Mac (a Mac mini on a shelf) should be set up like a server:**
  System Settings > Users & Groups > automatic login on (so it comes back
  unlocked after a restart or power loss), and System Settings > Lock Screen >
  "Require password after screen saver begins or display is turned off" set to
  Never. The display may still sleep; only the password matters.
- These are the user's settings. Tell them what to change and why; do not change
  them yourself (they need the user's password).

After installing, `localbox host check` reports `hibernate` as `available`,
`only_while_unlocked` or `unknown`; anything but `available` lists the fixes.
The installer prints a `Sleep:` line with the same fixes when something needs
changing.

## Download and verify one release

Resolve the latest tag once and take every file from that tag. A network,
rate-limit or checksum failure is a blocker to report, not something to work
around.

```sh
set -eu
download=$(mktemp -d)
cd "$download"
repo="${LOCALBOX_RELEASE_REPOSITORY:-dzhng/localbox}"
curl --fail --location "https://api.github.com/repos/$repo/releases/latest" -o latest.json
tag=$(/usr/bin/plutil -extract tag_name raw -o - latest.json)
release="https://github.com/$repo/releases/download/$tag"
curl --fail --location "$release/release.json" -o release.json
curl --fail --location "$release/SHA256SUMS" -o SHA256SUMS
archive=$(awk '/localbox-cli-.*\.tar\.gz$/ { print $2 }' SHA256SUMS)
app=$(awk '/Localbox-.*\.zip$/ { print $2 }' SHA256SUMS)
test -n "$archive" && test -n "$app"
curl --fail --location "$release/$archive" -o "$archive"
curl --fail --location "$release/$app" -o "$app"
shasum -a 256 -c SHA256SUMS
tar -xzf "$archive" -C "$download"
```

## Run the installer

The installer verifies the Ed25519 signature on `release.json` against the
pinned release public key before it writes anything. When an older copy of this
skill is already installed it finds the key there; otherwise pass the key that
ships next to this file's skill (`release-public.pem`):

```sh
RELEASE_PUBLIC_KEY="$HOME/.agents/skills/localbox/release-public.pem" \
  "$download/localbox-cli/scripts/install-release.sh" "$download"
```

It installs the app and the CLI under
`~/Library/Application Support/Localbox/releases/`, registers the host daemon,
the relay connector and the updater with launchd, then runs agent setup:
`localbox agents reconcile --reason install` installs this skill for every agent
harness on the Mac and links `~/.local/bin/localbox`. Its last line is
`Skill: <state>`; anything but `installed` means read `localbox skill status`
and the [skill lifecycle](skill-lifecycle.md). The release carries its own Node
runtime and pinned `skills@1.7.0` installer, so nothing here uses the host's
Node, npm or npx. Keep the download directory until the checks below pass.

## Check it

```sh
localbox skill status      # state: installed, managed: true, source_revision: the tag's version
localbox cli status        # state: linked
localbox agents setup status
localbox host check        # hibernate: available, or the settings to change
localbox help
```

If `localbox` is not on this shell's PATH yet, use `~/.local/bin/localbox`; the
installer adds a marked PATH block for future login shells when needed. Then sign
in (`localbox login --email`) and tell the user to start a fresh agent session so
the installed skill is loaded. Report a short checklist: release version, skill
state, CLI link, signed in or not, and whether sandboxes can hibernate here
(with the settings to change if not).
