#!/bin/sh
# Build and sign Spike.app into a scratch directory (never into the repo).
#   build.sh <out-dir> <build-tag>
# Signs with SPIKE_IDENTITY (default "Agent Computer Local"), looked up in
# SPIKE_KEYCHAIN when set. Never a release identity.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out=${1:?out dir}
tag=${2:?build tag}
identity=${SPIKE_IDENTITY:-Agent Computer Local}
app="$out/Spike.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
sed "s/__BUILD__/$tag/" "$here/Info.plist" > "$app/Contents/Info.plist"
xcrun swiftc -O -target arm64-apple-macos14.0 "$here/main.swift" -o "$app/Contents/MacOS/Spike"
codesign --force --timestamp=none --options runtime \
  --identifier sh.localbox.spike.launch \
  ${SPIKE_KEYCHAIN:+--keychain "$SPIKE_KEYCHAIN"} \
  --sign "$identity" "$app"
codesign --verify --strict --verbose=2 "$app"
echo "$app"
