#!/bin/sh
# Installs the darwin guest agent into a macOS guest, as root, from a directory holding localbox-agent,
# localbox-desktop, localbox-vsock and these plists, and starts it. The desktop user must be logged in (auto-login)
# for the desktop role to load now and for `localbox-agent --grant-tcc`, which a caller runs after this.
#   sudo sh install.sh [<staging dir>]
set -eu
stage=${1:-$(dirname "$0")}
user=localbox
install -d -o root -g wheel -m 0755 /usr/local/localbox
for tool in localbox-agent localbox-desktop localbox-vsock; do
  install -o root -g wheel -m 0755 "$stage/$tool" "/usr/local/localbox/$tool"
done
install -o root -g wheel -m 0644 "$stage/sh.localbox.agent.plist" "$stage/sh.localbox.vsock.plist" /Library/LaunchDaemons/
install -o root -g wheel -m 0644 "$stage/sh.localbox.desktop.plist" /Library/LaunchAgents/
for label in sh.localbox.agent sh.localbox.vsock; do
  launchctl bootout "system/$label" 2>/dev/null || true
  launchctl bootstrap system "/Library/LaunchDaemons/$label.plist"
done
uid=$(id -u "$user")
launchctl bootout "gui/$uid/sh.localbox.desktop" 2>/dev/null || true
launchctl bootstrap "gui/$uid" /Library/LaunchAgents/sh.localbox.desktop.plist
