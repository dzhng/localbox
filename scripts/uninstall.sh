#!/bin/sh
set -eu

INSTALL_ROOT=${AGENT_COMPUTER_INSTALL_ROOT:-$HOME/Library/Application Support/AgentComputer}
RELEASE_ROOT="$INSTALL_ROOT/releases"
BIN_DIR=${AGENT_COMPUTER_BIN_DIR:-$HOME/.local/bin}
LAUNCH_AGENTS_DIR=${AGENT_COMPUTER_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}
PLIST="$LAUNCH_AGENTS_DIR/com.agentcomputer.hostd.plist"

if [ "${AGENT_COMPUTER_SKIP_LAUNCHD:-0}" != "1" ]; then
  DOMAIN="gui/$(id -u)"
  launchctl bootout "$DOMAIN/com.agentcomputer.hostd" >/dev/null 2>&1 || true
fi
if [ -e "$PLIST" ]; then rm -f "$PLIST"; fi
if [ -L "$BIN_DIR/agent-computer" ] || [ -e "$BIN_DIR/agent-computer" ]; then rm -f "$BIN_DIR/agent-computer"; fi
if [ "${AGENT_COMPUTER_REMOVE_RELEASES:-0}" = "1" ]; then rm -rf "$RELEASE_ROOT"; fi

echo "uninstalled Agent Computer host integration"
