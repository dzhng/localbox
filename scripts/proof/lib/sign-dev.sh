#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
entitlements="$root/apps/macos/HostDaemon/Resources/localbox-hostd.entitlements"
build_dir=${BUILD_DIR:-$(cd "$root" && swift build --package-path apps/macos/HostDaemon --show-bin-path)}

for name in localbox-hostd localbox-vmlab; do
  path="$build_dir/$name"
  if [ ! -x "$path" ]; then
    echo "missing executable: $path (run swift build --package-path apps/macos/HostDaemon)" >&2
    exit 2
  fi
  codesign --force --sign - --entitlements "$entitlements" "$path"
done
