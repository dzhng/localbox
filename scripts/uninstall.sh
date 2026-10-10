#!/bin/sh
set -eu

INSTALL_ROOT=${LOCALBOX_INSTALL_ROOT:-$HOME/Library/Application Support/Localbox}
RELEASE_ROOT="$INSTALL_ROOT/releases"
BIN_DIR=${LOCALBOX_BIN_DIR:-$HOME/.local/bin}
LAUNCH_AGENTS_DIR=${LOCALBOX_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}
PLIST="$LAUNCH_AGENTS_DIR/com.localbox.hostd.plist"

if [ "${LOCALBOX_SKIP_LAUNCHD:-0}" != "1" ]; then
  DOMAIN="gui/$(id -u)"
  launchctl bootout "$DOMAIN/com.localbox.hostd" >/dev/null 2>&1 || true
fi
if [ -e "$PLIST" ]; then rm -f "$PLIST"; fi
if [ -L "$BIN_DIR/localbox" ] || [ -e "$BIN_DIR/localbox" ]; then rm -f "$BIN_DIR/localbox"; fi
if [ "${LOCALBOX_REMOVE_RELEASES:-0}" = "1" ]; then rm -rf "$RELEASE_ROOT"; fi

echo "uninstalled Localbox host integration"
