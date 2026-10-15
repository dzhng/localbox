#!/bin/sh
set -eu
codesign --force --sign - --entitlements "$(dirname "$0")/../../../apps/macos/HostDaemon/Resources/localbox-hostd.entitlements" "$@"
