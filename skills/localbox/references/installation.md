# Install Localbox

Use this when `localbox` is missing and the user asked for it. You install one
signed GitHub release; the release's own installer sets up everything else,
including this skill. Do not build from source, do not run `npx skills add`, and
do not copy the skill into any agent directory yourself: the installer does it,
records that Localbox owns it, and keeps it matched to every later release.

## Check the Mac

`uname -m` must print `arm64` and `sw_vers -productVersion` must be 14 or newer.
Anything else (Intel, Linux, Docker) cannot run Localbox; say so and stop.

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
localbox help
```

If `localbox` is not on this shell's PATH yet, use `~/.local/bin/localbox`; the
installer adds a marked PATH block for future login shells when needed. Then sign
in (`localbox login --email`) and tell the user to start a fresh agent session so
the installed skill is loaded. Report a short checklist: release version, skill
state, CLI link, signed in or not.
