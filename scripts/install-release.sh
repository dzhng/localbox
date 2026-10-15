#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
. "$SCRIPT_DIR/localbox-path.sh"
SOURCE_DIR=${1:-}
ALLOW_UNSIGNED=${ALLOW_UNSIGNED:-0}
INSTALL_ROOT=${LOCALBOX_INSTALL_ROOT:-$HOME/Library/Application Support/Localbox}
RELEASE_ROOT="$INSTALL_ROOT/releases"
BIN_DIR=${LOCALBOX_BIN_DIR:-$HOME/.local/bin}
LAUNCH_AGENTS_DIR=${LOCALBOX_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}
TOKEN_FILE=${LOCALBOX_MACHINE_ROOT:-$INSTALL_ROOT}/ipc-token
SOCKET_PATH=${LOCALBOX_MACHINE_ROOT:-$INSTALL_ROOT}/agent.sock
SANDBOXES_DIR=${LOCALBOX_MACHINE_ROOT:-$INSTALL_ROOT}/sandboxes
PUBLIC_KEY_FILE=${LOCALBOX_RELEASE_PUBLIC_KEY_FILE:-$INSTALL_ROOT/release-public.pem}
RELEASE_REPOSITORY=${LOCALBOX_RELEASE_REPOSITORY:-dzhng/localbox}

if [ -z "${RELEASE_PUBLIC_KEY:-}" ]; then
  for candidate in \
    "${LOCALBOX_SKILL_SOURCE:-}/release-public.pem" \
    "$HOME/.agents/skills/localbox/release-public.pem" \
    "$HOME/.codex/skills/localbox/release-public.pem" \
    "$HOME/.claude/skills/localbox/release-public.pem"; do
    if [ -n "$candidate" ] && [ -f "$candidate" ]; then
      RELEASE_PUBLIC_KEY="$candidate"
      break
    fi
  done
fi

if [ -z "$SOURCE_DIR" ] || [ ! -d "$SOURCE_DIR" ]; then
  echo "usage: scripts/install-release.sh RELEASE_DIR" >&2
  exit 2
fi
if [ "$(uname -m)" != "arm64" ]; then
  echo "localbox releases require arm64" >&2
  exit 1
fi
if [ -z "${RELEASE_PUBLIC_KEY:-}" ] && [ "$ALLOW_UNSIGNED" != "1" ]; then
  echo "RELEASE_PUBLIC_KEY is required; set ALLOW_UNSIGNED=1 only for local install checks" >&2
  exit 1
fi

APP_ZIP=$(find "$SOURCE_DIR" -maxdepth 1 -type f -name 'Localbox-*.zip' -print | head -1)
CLI_TAR=$(find "$SOURCE_DIR" -maxdepth 1 -type f -name 'localbox-cli-*.tar.gz' -print | head -1)
if [ -z "$APP_ZIP" ] || [ -z "$CLI_TAR" ] || [ ! -f "$SOURCE_DIR/release.json" ]; then
  echo "release directory is missing app, CLI, or manifest artifacts" >&2
  exit 1
fi

STAGE=$(mktemp -d "${TMPDIR:-/tmp}/localbox-install.XXXXXX")
INSTALL_STAGE=
cleanup() {
  rm -rf "$STAGE"
  if [ -n "${INSTALL_STAGE:-}" ]; then rm -rf "$INSTALL_STAGE"; fi
}
trap cleanup EXIT INT TERM
tar -xzf "$CLI_TAR" -C "$STAGE"
CLI_STAGE="$STAGE/localbox-cli"
VERIFY_NODE="$CLI_STAGE/node"
if [ ! -x "$VERIFY_NODE" ]; then
  echo "CLI archive does not contain its bundled node runtime" >&2
  exit 1
fi

(cd "$CLI_STAGE" && SOURCE_DIR="$SOURCE_DIR" RELEASE_PUBLIC_KEY="${RELEASE_PUBLIC_KEY:-}" ALLOW_UNSIGNED="$ALLOW_UNSIGNED" "$VERIFY_NODE" --input-type=module <<'NODE'
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyManifestSignature, verifyRelease } from "./dist/scripts/release.js";
const dir = process.env.SOURCE_DIR;
const manifest = JSON.parse(readFileSync(join(dir, "release.json"), "utf8"));
await verifyRelease(dir, manifest, "arm64");
if (process.env.RELEASE_PUBLIC_KEY) verifyManifestSignature(manifest, readFileSync(process.env.RELEASE_PUBLIC_KEY));
else if (process.env.ALLOW_UNSIGNED !== "1") throw new Error("release signature is required");
NODE
)

VERSION=$(basename "$CLI_TAR")
VERSION=${VERSION#localbox-cli-}
VERSION=${VERSION%.tar.gz}
case "$VERSION" in
  ''|*[!A-Za-z0-9._-]*) echo "invalid release version" >&2; exit 1 ;;
esac
EXPECTED_APP="$SOURCE_DIR/Localbox-$VERSION.zip"
if [ "$APP_ZIP" != "$EXPECTED_APP" ]; then
  echo "app and CLI artifact versions do not match" >&2
  exit 1
fi

mkdir -p "$RELEASE_ROOT" "$BIN_DIR" "$LAUNCH_AGENTS_DIR" "$(dirname "$TOKEN_FILE")" "$SANDBOXES_DIR"
if [ -n "${RELEASE_PUBLIC_KEY:-}" ] && [ -f "$RELEASE_PUBLIC_KEY" ]; then cp "$RELEASE_PUBLIC_KEY" "$PUBLIC_KEY_FILE"; chmod 600 "$PUBLIC_KEY_FILE"; fi
TARGET="$RELEASE_ROOT/$VERSION"
if [ -e "$TARGET" ]; then
  echo "release $VERSION is already installed" >&2
  exit 1
fi
INSTALL_STAGE=$(mktemp -d "$RELEASE_ROOT/.stage.XXXXXX")
ditto -x -k "$APP_ZIP" "$INSTALL_STAGE"
tar -xzf "$CLI_TAR" -C "$INSTALL_STAGE"
if [ ! -d "$INSTALL_STAGE/Localbox.app" ] || [ ! -x "$INSTALL_STAGE/localbox-cli/bin/localbox" ]; then
  echo "release archive did not extract the expected app and CLI" >&2
  rm -rf "$INSTALL_STAGE"
  exit 1
fi
if [ "$ALLOW_UNSIGNED" != "1" ]; then
  codesign --verify --deep --strict --verbose=2 "$INSTALL_STAGE/Localbox.app"
fi
cp "$SOURCE_DIR/release.json" "$INSTALL_STAGE/release.json"
cp "$SOURCE_DIR/SHA256SUMS" "$INSTALL_STAGE/SHA256SUMS"
cp "$APP_ZIP" "$INSTALL_STAGE/$(basename "$APP_ZIP")"
cp "$CLI_TAR" "$INSTALL_STAGE/$(basename "$CLI_TAR")"
mv "$INSTALL_STAGE" "$TARGET"

(cd "$CLI_STAGE" && TARGET="$TARGET" RELEASE_ROOT="$RELEASE_ROOT" "$VERIFY_NODE" --input-type=module <<'NODE'
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { activateRelease } from "./dist/scripts/release.js";
const target = process.env.TARGET;
const root = process.env.RELEASE_ROOT;
const manifest = JSON.parse(readFileSync(join(target, "release.json"), "utf8"));
await activateRelease(root, manifest.version, manifest, "arm64");
NODE
)

ACTIVE_APP="$RELEASE_ROOT/active/Localbox.app"
PLIST="$LAUNCH_AGENTS_DIR/com.localbox.hostd.plist"
UPDATER_PLIST="$LAUNCH_AGENTS_DIR/com.localbox.updater.plist"
CONNECTOR_PLIST="$LAUNCH_AGENTS_DIR/com.localbox.connector.plist"
cp "$ACTIVE_APP/Contents/Resources/com.localbox.hostd.plist" "$PLIST"
cp "$ACTIVE_APP/Contents/Resources/com.localbox.updater.plist" "$UPDATER_PLIST"
cp "$ACTIVE_APP/Contents/Resources/com.localbox.connector.plist" "$CONNECTOR_PLIST"
/usr/libexec/PlistBuddy -c "Set :ProgramArguments:0 $ACTIVE_APP/Contents/MacOS/localbox-hostd" "$PLIST"
plutil -replace 'EnvironmentVariables.LOCALBOX_IPC_TOKEN_PATH' -string "$TOKEN_FILE" "$PLIST"
plutil -replace 'EnvironmentVariables.LOCALBOX_SOCKET' -string "$SOCKET_PATH" "$PLIST"
plutil -replace 'EnvironmentVariables.LOCALBOX_SANDBOXES' -string "$SANDBOXES_DIR" "$PLIST"
plutil -replace 'EnvironmentVariables.LOCALBOX_KERNEL' -string "$ACTIVE_APP/Contents/Resources/vm/vmlinuz" "$PLIST"
plutil -replace 'EnvironmentVariables.LOCALBOX_INITRD' -string "$ACTIVE_APP/Contents/Resources/vm/initrd" "$PLIST"
plutil -replace 'EnvironmentVariables.LOCALBOX_TEMPLATE_DISK' -string "$ACTIVE_APP/Contents/Resources/vm/template.img" "$PLIST"
chmod 600 "$PLIST"
/usr/libexec/PlistBuddy -c "Set :ProgramArguments:0 $BIN_DIR/localbox" "$UPDATER_PLIST"
plutil -replace 'EnvironmentVariables.LOCALBOX_INSTALL_ROOT' -string "$INSTALL_ROOT" "$UPDATER_PLIST"
plutil -replace 'EnvironmentVariables.LOCALBOX_RELEASE_REPOSITORY' -string "$RELEASE_REPOSITORY" "$UPDATER_PLIST"
if [ -f "$PUBLIC_KEY_FILE" ]; then plutil -replace 'EnvironmentVariables.LOCALBOX_RELEASE_PUBLIC_KEY' -string "$PUBLIC_KEY_FILE" "$UPDATER_PLIST"; fi
chmod 600 "$UPDATER_PLIST"
/usr/libexec/PlistBuddy -c "Set :ProgramArguments:0 $BIN_DIR/localbox" "$CONNECTOR_PLIST"
if [ -n "${LOCALBOX_API_ORIGIN:-}" ]; then plutil -replace 'EnvironmentVariables.LOCALBOX_API_ORIGIN' -string "$LOCALBOX_API_ORIGIN" "$CONNECTOR_PLIST"; fi
if [ -n "${LOCALBOX_MACHINE_ROOT:-}" ]; then plutil -replace 'EnvironmentVariables.LOCALBOX_MACHINE_ROOT' -string "$LOCALBOX_MACHINE_ROOT" "$CONNECTOR_PLIST"; fi
chmod 600 "$CONNECTOR_PLIST"

if [ ! -s "$TOKEN_FILE" ]; then
  umask 077
  "$VERIFY_NODE" -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' > "$TOKEN_FILE"
fi
chmod 600 "$TOKEN_FILE"
ln -sfn "$RELEASE_ROOT/active/localbox-cli/bin/localbox" "$BIN_DIR/localbox"
localbox_add_path

# The release owns the global Localbox skill. Installing it here records the
# ownership receipt the updater needs to refresh it after every update.
SKILL_STATE="skipped"
if [ "${LOCALBOX_SKIP_SKILL:-0}" != "1" ]; then
  if "$BIN_DIR/localbox" skill install --json >/dev/null; then SKILL_STATE="installed"; else
    SKILL_STATE="needs_attention (run: localbox skill status --json)"
    echo "warning: the Localbox skill was not installed; run: localbox skill status --json" >&2
  fi
fi

if [ "${LOCALBOX_SKIP_LAUNCHD:-0}" != "1" ]; then
  DOMAIN="gui/$(id -u)"
  launchctl bootout "$DOMAIN/com.localbox.hostd" >/dev/null 2>&1 || true
  launchctl bootstrap "$DOMAIN" "$PLIST"
  launchctl kickstart -k "$DOMAIN/com.localbox.hostd"
  if [ "${LOCALBOX_SKIP_UPDATER_RELOAD:-0}" != "1" ]; then
    launchctl bootout "$DOMAIN/com.localbox.updater" >/dev/null 2>&1 || true
    launchctl bootstrap "$DOMAIN" "$UPDATER_PLIST"
    launchctl kickstart -k "$DOMAIN/com.localbox.updater"
  fi
  launchctl bootout "$DOMAIN/com.localbox.connector" >/dev/null 2>&1 || true
  launchctl bootstrap "$DOMAIN" "$CONNECTOR_PLIST"
  launchctl kickstart -k "$DOMAIN/com.localbox.connector"
fi

echo "installed Localbox $VERSION"
echo "CLI: $BIN_DIR/localbox"
echo "HostDaemon: $ACTIVE_APP/Contents/MacOS/localbox-hostd"
echo "Skill: $SKILL_STATE"
