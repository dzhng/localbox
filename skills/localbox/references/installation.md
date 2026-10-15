# Install Localbox for the agent

Localbox is agent installed. There is no browser app download step. When the
CLI is missing, use the release API once, download the complete tagged kit, and
run the release installer from the agent environment.

The installer requires Apple Silicon and verifies both `SHA256SUMS` and the
Ed25519 manifest before it writes anything. Keep the downloaded directory until
`localbox status` and `localbox skill status` succeed.

```sh
set -eu
download=$(mktemp -d)
cd "$download"
repo="${LOCALBOX_RELEASE_REPOSITORY:-dzhng/localbox}"
curl --fail --location "https://api.github.com/repos/$repo/releases/latest" -o latest.json
tag=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["tag_name"])' latest.json)
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

The bundled skill carries the pinned release public key. If the agent already
has this skill in one of the global harness directories, the installer finds it
automatically. Pass it explicitly when bootstrapping from another environment:

```sh
RELEASE_PUBLIC_KEY="$HOME/.agents/skills/localbox/release-public.pem" \
  "$download/localbox-cli/scripts/install-release.sh" "$download"
```

The installer creates the versioned active release, authenticated HostDaemon
socket, CLI symlink, and launchd updater, then runs `localbox skill install`.
That replaces any global copy of this skill with the release's bundled one and
records ownership, so every later update refreshes it. The installed CLI
carries its own ARM64 Node runtime and pinned `skills@1.7.0` implementation, so
skill setup never invokes host `npx`, `npm`, or a network package install.
The installer's last line reports the skill result; `needs_attention` means
run `localbox skill status --json` and follow the skill lifecycle reference.

Verify the agent-facing installation:

```sh
localbox status
localbox skill status --json   # state: installed, managed: true
localbox help --json
```

If the command is not on the current shell's `PATH`, use
`~/.local/bin/localbox` directly. The installer adds a marked PATH block for a
future login shell when the account does not already cover `~/.local/bin`.
