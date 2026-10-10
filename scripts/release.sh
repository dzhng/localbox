#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
OUT_DIR=${1:-$ROOT/dist/release}
VERSION=${VERSION:-0.1.0}
IMAGE_DIGEST=${IMAGE_DIGEST:-sha256:unrecorded}
IDENTITY=${APPLE_SIGNING_IDENTITY:-}

case "$VERSION" in
  ''|*[!A-Za-z0-9._-]*) echo "VERSION contains invalid characters" >&2; exit 1 ;;
esac
if ! printf '%s\n' "$IMAGE_DIGEST" | grep -Eq '^sha256:[0-9a-fA-F]{64}$'; then
  echo "IMAGE_DIGEST must be a sha256 digest" >&2
  exit 1
fi
if [ "$(uname -m)" != "arm64" ]; then
  echo "agent-computer releases require arm64" >&2
  exit 1
fi
for required in AGENT_COMPUTER_KERNEL AGENT_COMPUTER_INITRD AGENT_COMPUTER_TEMPLATE_DISK; do
  value=$(eval "printf '%s' \"\${$required-}\"")
  if [ -z "$value" ] || [ ! -f "$value" ]; then
    echo "$required must name an existing release artifact" >&2
    exit 1
  fi
done
if [ -z "${RELEASE_PRIVATE_KEY:-}" ] && [ "${ALLOW_UNSIGNED:-0}" != "1" ]; then
  echo "RELEASE_PRIVATE_KEY is required; set ALLOW_UNSIGNED=1 only for local packaging checks" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/agent-computer-release.XXXXXX")
cleanup() {
  python3 - "$STAGE" <<'PY'
import shutil
import sys
shutil.rmtree(sys.argv[1], ignore_errors=True)
PY
}
trap cleanup EXIT INT TERM

npm --prefix "$ROOT" run build
swift build --package-path "$ROOT/apps/macos/HostDaemon" -c release

APP="$STAGE/Agent Computer.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/vm"
cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>agent-computer-hostd</string>
  <key>CFBundleIdentifier</key>
  <string>com.agentcomputer.hostd</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Agent Computer</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>$VERSION</string>
  <key>CFBundleVersion</key>
  <string>$VERSION</string>
</dict>
</plist>
EOF
cp "$ROOT/apps/macos/HostDaemon/.build/arm64-apple-macosx/release/agent-computer-hostd" "$APP/Contents/MacOS/agent-computer-hostd" 2>/dev/null \
  || cp "$ROOT/apps/macos/HostDaemon/.build/out/Products/Release/agent-computer-hostd" "$APP/Contents/MacOS/agent-computer-hostd"
cp "$ROOT/apps/macos/HostDaemon/Resources/com.agentcomputer.hostd.plist" "$APP/Contents/Resources/com.agentcomputer.hostd.plist"
cp "$ROOT/apps/macos/HostDaemon/Resources/agent-computer-hostd.entitlements" "$APP/Contents/Resources/agent-computer-hostd.entitlements"
cp "$AGENT_COMPUTER_KERNEL" "$APP/Contents/Resources/vm/vmlinuz"
cp "$AGENT_COMPUTER_INITRD" "$APP/Contents/Resources/vm/initrd"
cp "$AGENT_COMPUTER_TEMPLATE_DISK" "$APP/Contents/Resources/vm/template.img"

CLI="$STAGE/agent-computer-cli"
mkdir -p "$CLI/dist" "$CLI/bin"
cp -R "$ROOT/dist/apps" "$CLI/dist/apps"
cp -R "$ROOT/dist/packages" "$CLI/dist/packages"
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$CLI/"
cat > "$CLI/bin/agent-computer" <<'EOF'
#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec node "$ROOT/dist/apps/cli/src/index.js" "$@"
EOF
chmod 0755 "$CLI/bin/agent-computer"
npm --prefix "$CLI" install --omit=dev --ignore-scripts --no-package-lock --no-audit --no-fund >/dev/null

if [ -n "$IDENTITY" ]; then
  codesign --force --options runtime --timestamp --entitlements "$APP/Contents/Resources/agent-computer-hostd.entitlements" --sign "$IDENTITY" "$APP/Contents/MacOS/agent-computer-hostd"
  codesign --force --deep --options runtime --timestamp --entitlements "$APP/Contents/Resources/agent-computer-hostd.entitlements" --sign "$IDENTITY" "$APP"
  codesign --force --options runtime --timestamp --sign "$IDENTITY" "$CLI/bin/agent-computer"
  codesign --verify --deep --strict --verbose=2 "$APP"
elif [ "${ALLOW_UNSIGNED:-0}" != "1" ]; then
  echo "APPLE_SIGNING_IDENTITY is required; set ALLOW_UNSIGNED=1 only for local packaging checks" >&2
  exit 1
fi

APP_ZIP="$OUT_DIR/Agent-Computer-$VERSION.zip"
ditto -c -k --keepParent "$APP" "$APP_ZIP"
CLI_TAR="$OUT_DIR/agent-computer-cli-$VERSION.tar.gz"
tar -czf "$CLI_TAR" -C "$STAGE" agent-computer-cli

if [ -n "${NOTARY_PROFILE:-}" ]; then
  xcrun notarytool submit "$APP_ZIP" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$APP"
  ditto -c -k --keepParent "$APP" "$APP_ZIP"
fi

RELEASE_DIR="$OUT_DIR" RELEASE_VERSION="$VERSION" RELEASE_IMAGE_DIGEST="$IMAGE_DIGEST" RELEASE_PRIVATE_KEY="${RELEASE_PRIVATE_KEY:-}" RELEASE_KEY_ID="${RELEASE_KEY_ID:-}" node --input-type=module <<'NODE'
import { readFileSync } from "node:fs";
import { makeManifest, signManifest, writeRelease } from "./dist/scripts/release.js";
const dir = process.env.RELEASE_DIR;
const version = process.env.RELEASE_VERSION;
const imageDigest = process.env.RELEASE_IMAGE_DIGEST;
let manifest = await makeManifest(dir, version, imageDigest);
if (process.env.RELEASE_PRIVATE_KEY) manifest = signManifest(manifest, readFileSync(process.env.RELEASE_PRIVATE_KEY), process.env.RELEASE_KEY_ID || "release");
await writeRelease(dir, manifest);
NODE

echo "release artifacts written to $OUT_DIR"
