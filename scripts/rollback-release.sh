#!/bin/sh
set -eu

VERSION=${1:-}
ALLOW_UNSIGNED=${ALLOW_UNSIGNED:-0}
INSTALL_ROOT=${LOCALBOX_INSTALL_ROOT:-$HOME/Library/Application Support/Localbox}
RELEASE_ROOT="$INSTALL_ROOT/releases"
BIN_DIR=${LOCALBOX_BIN_DIR:-$HOME/.local/bin}
LAUNCH_AGENTS_DIR=${LOCALBOX_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}
TOKEN_FILE=${LOCALBOX_IPC_TOKEN_FILE:-$INSTALL_ROOT/ipc-token}
SOCKET_PATH=${LOCALBOX_SOCKET_PATH:-$INSTALL_ROOT/agent.sock}
DISK_PATH=${LOCALBOX_DISK:-$INSTALL_ROOT/vm/disk.img}

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
cp "$ACTIVE_APP/Contents/Resources/com.localbox.hostd.plist" "$PLIST"
plutil -replace 'ProgramArguments.0' -string "$ACTIVE_APP/Contents/MacOS/localbox-hostd" "$PLIST"
plutil -replace 'EnvironmentVariables.LOCALBOX_IPC_TOKEN_FILE' -string "$TOKEN_FILE" "$PLIST"
plutil -replace 'EnvironmentVariables.LOCALBOX_SOCKET_PATH' -string "$SOCKET_PATH" "$PLIST"
plutil -replace 'EnvironmentVariables.LOCALBOX_KERNEL' -string "$ACTIVE_APP/Contents/Resources/vm/vmlinuz" "$PLIST"
plutil -replace 'EnvironmentVariables.LOCALBOX_INITRD' -string "$ACTIVE_APP/Contents/Resources/vm/initrd" "$PLIST"
plutil -replace 'EnvironmentVariables.LOCALBOX_DISK' -string "$DISK_PATH" "$PLIST"
plutil -replace 'EnvironmentVariables.LOCALBOX_TEMPLATE_DISK' -string "$ACTIVE_APP/Contents/Resources/vm/template.img" "$PLIST"
chmod 600 "$PLIST"
ln -sfn "$RELEASE_ROOT/active/localbox-cli/bin/localbox" "$BIN_DIR/localbox"

if [ "${LOCALBOX_SKIP_LAUNCHD:-0}" != "1" ]; then
  DOMAIN="gui/$(id -u)"
  launchctl bootout "$DOMAIN/com.localbox.hostd" >/dev/null 2>&1 || true
  launchctl bootstrap "$DOMAIN" "$PLIST"
  launchctl kickstart -k "$DOMAIN/com.localbox.hostd"
fi

echo "rolled back Localbox to $VERSION"
