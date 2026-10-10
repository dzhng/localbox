#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
SOURCE_DIR=${1:-}
ALLOW_UNSIGNED=${ALLOW_UNSIGNED:-0}
INSTALL_ROOT=${AGENT_COMPUTER_INSTALL_ROOT:-$HOME/Library/Application Support/AgentComputer}
RELEASE_ROOT="$INSTALL_ROOT/releases"
BIN_DIR=${AGENT_COMPUTER_BIN_DIR:-$HOME/.local/bin}
LAUNCH_AGENTS_DIR=${AGENT_COMPUTER_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}
TOKEN_FILE=${AGENT_COMPUTER_IPC_TOKEN_FILE:-$INSTALL_ROOT/ipc-token}
SOCKET_PATH=${AGENT_COMPUTER_SOCKET_PATH:-$INSTALL_ROOT/agent.sock}
DISK_PATH=${AGENT_COMPUTER_DISK:-$INSTALL_ROOT/vm/disk.img}

if [ -z "$SOURCE_DIR" ] || [ ! -d "$SOURCE_DIR" ]; then
  echo "usage: scripts/install-release.sh RELEASE_DIR" >&2
  exit 2
fi
if [ "$(uname -m)" != "arm64" ]; then
  echo "agent-computer releases require arm64" >&2
  exit 1
fi
if [ -z "${RELEASE_PUBLIC_KEY:-}" ] && [ "$ALLOW_UNSIGNED" != "1" ]; then
  echo "RELEASE_PUBLIC_KEY is required; set ALLOW_UNSIGNED=1 only for local install checks" >&2
  exit 1
fi

APP_ZIP=$(find "$SOURCE_DIR" -maxdepth 1 -type f -name 'Agent-Computer-*.zip' -print | head -1)
CLI_TAR=$(find "$SOURCE_DIR" -maxdepth 1 -type f -name 'agent-computer-cli-*.tar.gz' -print | head -1)
if [ -z "$APP_ZIP" ] || [ -z "$CLI_TAR" ] || [ ! -f "$SOURCE_DIR/release.json" ]; then
  echo "release directory is missing app, CLI, or manifest artifacts" >&2
  exit 1
fi

STAGE=$(mktemp -d "${TMPDIR:-/tmp}/agent-computer-install.XXXXXX")
INSTALL_STAGE=
cleanup() {
  rm -rf "$STAGE"
  if [ -n "${INSTALL_STAGE:-}" ]; then rm -rf "$INSTALL_STAGE"; fi
}
trap cleanup EXIT INT TERM
tar -xzf "$CLI_TAR" -C "$STAGE"
CLI_STAGE="$STAGE/agent-computer-cli"
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
VERSION=${VERSION#agent-computer-cli-}
VERSION=${VERSION%.tar.gz}
case "$VERSION" in
  ''|*[!A-Za-z0-9._-]*) echo "invalid release version" >&2; exit 1 ;;
esac
EXPECTED_APP="$SOURCE_DIR/Agent-Computer-$VERSION.zip"
if [ "$APP_ZIP" != "$EXPECTED_APP" ]; then
  echo "app and CLI artifact versions do not match" >&2
  exit 1
fi

mkdir -p "$RELEASE_ROOT" "$BIN_DIR" "$LAUNCH_AGENTS_DIR" "$(dirname "$TOKEN_FILE")" "$(dirname "$DISK_PATH")"
TARGET="$RELEASE_ROOT/$VERSION"
if [ -e "$TARGET" ]; then
  echo "release $VERSION is already installed" >&2
  exit 1
fi
INSTALL_STAGE=$(mktemp -d "$RELEASE_ROOT/.stage.XXXXXX")
ditto -x -k "$APP_ZIP" "$INSTALL_STAGE"
tar -xzf "$CLI_TAR" -C "$INSTALL_STAGE"
if [ ! -d "$INSTALL_STAGE/Agent Computer.app" ] || [ ! -x "$INSTALL_STAGE/agent-computer-cli/bin/agent-computer" ]; then
  echo "release archive did not extract the expected app and CLI" >&2
  rm -rf "$INSTALL_STAGE"
  exit 1
fi
if [ "$ALLOW_UNSIGNED" != "1" ]; then
  codesign --verify --deep --strict --verbose=2 "$INSTALL_STAGE/Agent Computer.app"
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

ACTIVE_APP="$RELEASE_ROOT/active/Agent Computer.app"
PLIST="$LAUNCH_AGENTS_DIR/com.agentcomputer.hostd.plist"
cp "$ACTIVE_APP/Contents/Resources/com.agentcomputer.hostd.plist" "$PLIST"
plutil -replace 'ProgramArguments.0' -string "$ACTIVE_APP/Contents/MacOS/agent-computer-hostd" "$PLIST"
plutil -replace 'EnvironmentVariables.AGENT_COMPUTER_IPC_TOKEN_FILE' -string "$TOKEN_FILE" "$PLIST"
plutil -replace 'EnvironmentVariables.AGENT_COMPUTER_SOCKET_PATH' -string "$SOCKET_PATH" "$PLIST"
plutil -replace 'EnvironmentVariables.AGENT_COMPUTER_KERNEL' -string "$ACTIVE_APP/Contents/Resources/vm/vmlinuz" "$PLIST"
plutil -replace 'EnvironmentVariables.AGENT_COMPUTER_INITRD' -string "$ACTIVE_APP/Contents/Resources/vm/initrd" "$PLIST"
plutil -replace 'EnvironmentVariables.AGENT_COMPUTER_DISK' -string "$DISK_PATH" "$PLIST"
plutil -replace 'EnvironmentVariables.AGENT_COMPUTER_TEMPLATE_DISK' -string "$ACTIVE_APP/Contents/Resources/vm/template.img" "$PLIST"
chmod 600 "$PLIST"

if [ ! -s "$TOKEN_FILE" ]; then
  umask 077
  "$VERIFY_NODE" -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' > "$TOKEN_FILE"
fi
chmod 600 "$TOKEN_FILE"
ln -sfn "$RELEASE_ROOT/active/agent-computer-cli/bin/agent-computer" "$BIN_DIR/agent-computer"

if [ "${AGENT_COMPUTER_SKIP_LAUNCHD:-0}" != "1" ]; then
  DOMAIN="gui/$(id -u)"
  launchctl bootout "$DOMAIN/com.agentcomputer.hostd" >/dev/null 2>&1 || true
  launchctl bootstrap "$DOMAIN" "$PLIST"
  launchctl kickstart -k "$DOMAIN/com.agentcomputer.hostd"
fi

echo "installed Agent Computer $VERSION"
echo "CLI: $BIN_DIR/agent-computer"
echo "HostDaemon: $ACTIVE_APP/Contents/MacOS/agent-computer-hostd"
