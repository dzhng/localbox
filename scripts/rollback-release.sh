#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/localbox-path.sh"

VERSION=${1:-}
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

case "$VERSION" in
  ''|*[!A-Za-z0-9._-]*) echo "usage: scripts/rollback-release.sh VERSION" >&2; exit 2 ;;
esac
TARGET="$RELEASE_ROOT/$VERSION"
if [ ! -d "$TARGET" ] || [ ! -f "$TARGET/release.json" ]; then
  echo "installed release $VERSION was not found" >&2
  exit 1
fi
if [ -z "${RELEASE_PUBLIC_KEY:-}" ] && [ "$ALLOW_UNSIGNED" != "1" ]; then
  echo "RELEASE_PUBLIC_KEY is required; set ALLOW_UNSIGNED=1 only for local rollback checks" >&2
  exit 1
fi

NODE_ROOT="$RELEASE_ROOT/active/localbox-cli"
if [ ! -x "$NODE_ROOT/node" ]; then NODE_ROOT="$TARGET/localbox-cli"; fi
NODE="$NODE_ROOT/node"
if [ ! -x "$NODE" ]; then echo "installed release has no bundled node runtime" >&2; exit 1; fi

(cd "$NODE_ROOT" && TARGET="$TARGET" RELEASE_ROOT="$RELEASE_ROOT" RELEASE_PUBLIC_KEY="${RELEASE_PUBLIC_KEY:-}" ALLOW_UNSIGNED="$ALLOW_UNSIGNED" "$NODE" --input-type=module <<'NODE'
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rollbackRelease, verifyManifestSignature } from "./dist/scripts/release.js";
const target = process.env.TARGET;
const root = process.env.RELEASE_ROOT;
const manifest = JSON.parse(readFileSync(join(target, "release.json"), "utf8"));
if (process.env.RELEASE_PUBLIC_KEY) verifyManifestSignature(manifest, readFileSync(process.env.RELEASE_PUBLIC_KEY));
else if (process.env.ALLOW_UNSIGNED !== "1") throw new Error("release signature is required");
await rollbackRelease(root, manifest.version, manifest, "arm64");
NODE
)

ACTIVE_APP="$RELEASE_ROOT/active/Localbox.app"
PLIST="$LAUNCH_AGENTS_DIR/com.localbox.hostd.plist"
UPDATER_PLIST="$LAUNCH_AGENTS_DIR/com.localbox.updater.plist"
# launchd does not expand ~ in log paths, and a job whose log path it cannot open never starts.
LOG_DIR="$HOME/Library/Logs/Localbox"
mkdir -p "$LOG_DIR"
cp "$ACTIVE_APP/Contents/Resources/com.localbox.hostd.plist" "$PLIST"
cp "$ACTIVE_APP/Contents/Resources/com.localbox.updater.plist" "$UPDATER_PLIST"
/usr/libexec/PlistBuddy -c "Set :ProgramArguments:0 $ACTIVE_APP/Contents/MacOS/localbox-hostd" "$PLIST"
plutil -replace 'EnvironmentVariables.LOCALBOX_IPC_TOKEN_PATH' -string "$TOKEN_FILE" "$PLIST"
plutil -replace 'EnvironmentVariables.LOCALBOX_SOCKET' -string "$SOCKET_PATH" "$PLIST"
plutil -replace 'EnvironmentVariables.LOCALBOX_SANDBOXES' -string "$SANDBOXES_DIR" "$PLIST"
plutil -replace 'EnvironmentVariables.LOCALBOX_KERNEL' -string "$ACTIVE_APP/Contents/Resources/vm/vmlinuz" "$PLIST"
plutil -replace 'EnvironmentVariables.LOCALBOX_INITRD' -string "$ACTIVE_APP/Contents/Resources/vm/initrd" "$PLIST"
plutil -replace 'EnvironmentVariables.LOCALBOX_TEMPLATE_DISK' -string "$RELEASE_ROOT/active/vm/template.img" "$PLIST"
plutil -replace 'EnvironmentVariables.LOCALBOX_CLI' -string "$RELEASE_ROOT/active/localbox-cli/bin/localbox" "$PLIST"
plutil -replace 'EnvironmentVariables.LOCALBOX_BIN_DIR' -string "$BIN_DIR" "$PLIST"
if [ -n "${LOCALBOX_MACHINE_ROOT:-}" ]; then plutil -replace 'EnvironmentVariables.LOCALBOX_MACHINE_ROOT' -string "$LOCALBOX_MACHINE_ROOT" "$PLIST"; fi
plutil -replace StandardOutPath -string "$LOG_DIR/hostd.log" "$PLIST"
plutil -replace StandardErrorPath -string "$LOG_DIR/hostd.error.log" "$PLIST"
chmod 600 "$PLIST"
/usr/libexec/PlistBuddy -c "Set :ProgramArguments:0 $BIN_DIR/localbox" "$UPDATER_PLIST"
plutil -replace 'EnvironmentVariables.LOCALBOX_INSTALL_ROOT' -string "$INSTALL_ROOT" "$UPDATER_PLIST"
plutil -replace 'EnvironmentVariables.LOCALBOX_RELEASE_REPOSITORY' -string "$RELEASE_REPOSITORY" "$UPDATER_PLIST"
if [ -f "$PUBLIC_KEY_FILE" ]; then plutil -replace 'EnvironmentVariables.LOCALBOX_RELEASE_PUBLIC_KEY' -string "$PUBLIC_KEY_FILE" "$UPDATER_PLIST"; fi
plutil -replace StandardOutPath -string "$LOG_DIR/updater.log" "$UPDATER_PLIST"
plutil -replace StandardErrorPath -string "$LOG_DIR/updater.error.log" "$UPDATER_PLIST"
chmod 600 "$UPDATER_PLIST"
localbox_add_path
# Agent setup matches the skill and the localbox link to the release rolled back to.
"$RELEASE_ROOT/active/localbox-cli/bin/localbox" agents reconcile --reason rollback >/dev/null || echo "warning: agent setup did not reconcile; run: localbox skill status --json" >&2

if [ "${LOCALBOX_SKIP_LAUNCHD:-0}" != "1" ]; then
  DOMAIN="gui/$(id -u)"
  launchctl bootout "$DOMAIN/com.localbox.hostd" >/dev/null 2>&1 || true
  launchctl bootout "$DOMAIN/com.localbox.updater" >/dev/null 2>&1 || true
  launchctl bootstrap "$DOMAIN" "$PLIST"
  launchctl kickstart -k "$DOMAIN/com.localbox.hostd"
  launchctl bootstrap "$DOMAIN" "$UPDATER_PLIST"
  launchctl kickstart -k "$DOMAIN/com.localbox.updater"
  # The connector runs `localbox` through the link, which now reaches the release rolled back to.
  launchctl kickstart -k "$DOMAIN/com.localbox.connector" >/dev/null 2>&1 || true
fi

echo "rolled back Localbox to $VERSION"
