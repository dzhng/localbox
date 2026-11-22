#!/bin/sh
# Builds the spike 02 supervisor app (throwaway) into <out-dir>/LocalboxSpikeChild.app.
#
#   build.sh <out-dir>                                   ad hoc signed app; the daemon stays where the config names it
#   build.sh <out-dir> --daemon <localbox-hostd> --identity "<identity>" [--keychain <keychain file>]
#                                                        copies the daemon to Contents/MacOS/localbox-hostd and signs
#                                                        it (with the virtualization entitlement) and then the app
#                                                        with that identity, inside out, as a release does
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(CDPATH= cd -- "$here/../../../.." && pwd)
out=${1:?usage: build.sh <out-dir> [--daemon PATH] [--identity NAME] [--keychain FILE]}; shift
daemon=""; identity="-"; keychain=""
while [ $# -gt 0 ]; do
  case "$1" in
    --daemon) daemon=$2; shift 2 ;;
    --identity) identity=$2; shift 2 ;;
    --keychain) keychain=$2; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
case "$identity" in *"Localbox Release"*) echo "the spike never signs with the release identity" >&2; exit 2 ;; esac

app="$out/LocalboxSpikeChild.app"
rm -rf "$app"; mkdir -p "$app/Contents/MacOS"
cp "$here/Info.plist" "$app/Contents/Info.plist"
swiftc -O -o "$app/Contents/MacOS/LocalboxSpikeChild" "$here/main.swift" -framework AppKit
if [ -n "$daemon" ]; then
  cp "$daemon" "$app/Contents/MacOS/localbox-hostd"
  codesign --force --timestamp=none ${keychain:+--keychain "$keychain"} --sign "$identity" --identifier sh.localbox.spike.hostd \
    --entitlements "$root/apps/macos/HostDaemon/Resources/localbox-hostd.entitlements" "$app/Contents/MacOS/localbox-hostd"
fi
codesign --force --timestamp=none ${keychain:+--keychain "$keychain"} --sign "$identity" "$app"
codesign --verify --strict "$app"
echo "$app"
