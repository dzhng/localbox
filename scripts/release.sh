#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
OUT_DIR=${1:-$ROOT/dist/release}
VERSION=${VERSION:-$(node -p "require(process.argv[1]).version" "$ROOT/package.json")}
IMAGE_DIGEST=${IMAGE_DIGEST:-sha256:unrecorded}
IDENTITY=${APPLE_SIGNING_IDENTITY:-}
SIGNING_KEYCHAIN=
SIGNING_WORK=

case "$VERSION" in
  ''|*[!A-Za-z0-9._-]*) echo "VERSION contains invalid characters" >&2; exit 1 ;;
esac
if ! printf '%s\n' "$IMAGE_DIGEST" | grep -Eq '^sha256:[0-9a-fA-F]{64}$'; then
  echo "IMAGE_DIGEST must be a sha256 digest" >&2
  exit 1
fi
if [ "$(uname -m)" != "arm64" ]; then
  echo "localbox releases require arm64" >&2
  exit 1
fi
if ! command -v zstd >/dev/null 2>&1; then
  echo "zstd is required to compress the VM template (brew install zstd)" >&2
  exit 1
fi
for required in LOCALBOX_KERNEL LOCALBOX_INITRD LOCALBOX_TEMPLATE_DISK; do
  value=$(eval "printf '%s' \"\${$required-}\"")
  if [ -z "$value" ] || [ ! -f "$value" ]; then
    echo "$required must name an existing release artifact" >&2
    exit 1
  fi
done
# Release credentials live in the checkout's git-ignored .release-signing/
# (backed up outside the repository): the Ed25519 manifest key whose public half
# is pinned in the skill, and the self-signed code-signing identity.
SIGNING_DIR=${LOCALBOX_SIGNING_DIR:-$ROOT/.release-signing}
if [ -z "${RELEASE_PRIVATE_KEY:-}" ] && [ -f "$SIGNING_DIR/release-private.pem" ]; then
  RELEASE_PRIVATE_KEY="$SIGNING_DIR/release-private.pem"
fi
if [ "${ALLOW_UNSIGNED:-0}" != "1" ]; then
  if [ -z "${RELEASE_PRIVATE_KEY:-}" ]; then
    echo "RELEASE_PRIVATE_KEY is required (or $SIGNING_DIR/release-private.pem); set ALLOW_UNSIGNED=1 only for local packaging checks" >&2
    exit 1
  fi
  # Installers trust only the pinned key, so a manifest signed by any other key
  # would publish a release nobody can install.
  if ! node -e 'const c=require("node:crypto"),f=require("node:fs");process.exit(c.createPublicKey(f.readFileSync(process.argv[1])).export({type:"spki",format:"pem"}).toString()===f.readFileSync(process.argv[2],"utf8")?0:1)' \
    "$RELEASE_PRIVATE_KEY" "$ROOT/skills/localbox/release-public.pem"; then
    echo "RELEASE_PRIVATE_KEY does not match skills/localbox/release-public.pem" >&2
    exit 1
  fi
fi

# The manifest lists every file in OUT_DIR, so a leftover from an earlier run would be signed into this one.
mkdir -p "$OUT_DIR"
OUT_DIR=$(CDPATH= cd -- "$OUT_DIR" && pwd)
if [ -n "$(ls -A "$OUT_DIR")" ]; then
  echo "$OUT_DIR must be empty" >&2
  exit 1
fi
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/localbox-release.XXXXXX")
cleanup() {
  if [ -n "$SIGNING_KEYCHAIN" ] && [ -n "$SIGNING_WORK" ] && [ -e "$SIGNING_KEYCHAIN" ]; then
    security delete-keychain "$SIGNING_KEYCHAIN" >/dev/null 2>&1 || true
  fi
  if [ -n "$SIGNING_WORK" ]; then
    rm -rf "$SIGNING_WORK"
  fi
  python3 - "$STAGE" <<'PY'
import shutil
import sys
shutil.rmtree(sys.argv[1], ignore_errors=True)
PY
}
trap cleanup EXIT INT TERM

# Without APPLE_SIGNING_IDENTITY, the release identity's PKCS#12 is imported into
# a disposable keychain with a partition list for headless codesign. The key
# never enters the login keychain and cleanup deletes the keychain. A missing
# identity fails: a freshly generated one would be a different signer.
if [ -z "$IDENTITY" ] && [ "${ALLOW_UNSIGNED:-0}" != "1" ]; then
  SIGNING_WORK=$(mktemp -d "${TMPDIR:-/tmp}/localbox-signing.XXXXXX")
  SIGNING_KEYCHAIN="$SIGNING_WORK/signing.keychain-db"
  SIGNING_PASSWORD=$(openssl rand -hex 24)
  LOCAL_P12=${LOCALBOX_SIGNING_P12:-$SIGNING_DIR/release-identity.p12}
  LOCAL_PASSWORD=${LOCALBOX_SIGNING_P12_PASSWORD_FILE:-$SIGNING_DIR/release-identity-password.txt}
  if [ ! -f "$LOCAL_P12" ] || [ ! -f "$LOCAL_PASSWORD" ]; then
    echo "the release signing identity is missing: expected $LOCAL_P12 and $LOCAL_PASSWORD (or set APPLE_SIGNING_IDENTITY)" >&2
    exit 1
  fi
  SIGNING_P12_PASSWORD=$(cat "$LOCAL_PASSWORD")
  python3 - "$LOCAL_P12" "$SIGNING_WORK/identity.p12" <<'PY'
import base64
import pathlib
import sys

source, target = map(pathlib.Path, sys.argv[1:])
value = source.read_bytes().strip()
try:
    value = base64.b64decode(value, validate=True)
except Exception:
    pass
target.write_bytes(value)
PY
  SIGNING_P12="$SIGNING_WORK/identity.p12"
  SIGNING_CERT="$SIGNING_WORK/identity.crt"
  printf '%s\n' "$SIGNING_P12_PASSWORD" | openssl pkcs12 -in "$SIGNING_P12" \
    -clcerts -nokeys -passin stdin -out "$SIGNING_CERT" >/dev/null 2>&1
  IDENTITY=$(openssl x509 -in "$SIGNING_CERT" -noout -fingerprint -sha1 \
    | sed 's/.*=//; s/://g')
  if [ -f "$SIGNING_DIR/public.json" ]; then
    PINNED_SHA1=$(node -p 'require(process.argv[1]).sha1' "$SIGNING_DIR/public.json")
    if [ "$(printf '%s' "$IDENTITY" | tr 'A-F' 'a-f')" != "$PINNED_SHA1" ]; then
      echo "the signing identity does not match $SIGNING_DIR/public.json" >&2
      exit 1
    fi
  fi
  security create-keychain -p "$SIGNING_PASSWORD" "$SIGNING_KEYCHAIN" >/dev/null
  security unlock-keychain -p "$SIGNING_PASSWORD" "$SIGNING_KEYCHAIN"
  security import "$SIGNING_P12" -k "$SIGNING_KEYCHAIN" -P "$SIGNING_P12_PASSWORD" -T /usr/bin/codesign >/dev/null
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$SIGNING_PASSWORD" "$SIGNING_KEYCHAIN" >/dev/null
fi

npm --prefix "$ROOT" run build
swift build --package-path "$ROOT/apps/macos/HostDaemon" -c release

APP="$STAGE/Localbox.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/vm"
cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>localbox-hostd</string>
  <key>CFBundleIdentifier</key>
  <string>com.localbox.hostd</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Localbox</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>$VERSION</string>
  <key>CFBundleVersion</key>
  <string>$VERSION</string>
</dict>
</plist>
EOF
cp "$ROOT/apps/macos/HostDaemon/.build/arm64-apple-macosx/release/localbox-hostd" "$APP/Contents/MacOS/localbox-hostd" 2>/dev/null \
  || cp "$ROOT/apps/macos/HostDaemon/.build/out/Products/Release/localbox-hostd" "$APP/Contents/MacOS/localbox-hostd"
cp "$ROOT/apps/macos/HostDaemon/Resources/com.localbox.hostd.plist" "$APP/Contents/Resources/com.localbox.hostd.plist"
cp "$ROOT/apps/macos/HostDaemon/Resources/com.localbox.updater.plist" "$APP/Contents/Resources/com.localbox.updater.plist"
cp "$ROOT/apps/macos/HostDaemon/Resources/com.localbox.connector.plist" "$APP/Contents/Resources/com.localbox.connector.plist"
cp "$ROOT/apps/macos/HostDaemon/Resources/localbox-hostd.entitlements" "$APP/Contents/Resources/localbox-hostd.entitlements"
cp "$LOCALBOX_KERNEL" "$APP/Contents/Resources/vm/vmlinuz"
cp "$LOCALBOX_INITRD" "$APP/Contents/Resources/vm/initrd"

CLI="$STAGE/localbox-cli"
mkdir -p "$CLI/dist" "$CLI/bin"
cp -R "$ROOT/dist/apps" "$CLI/dist/apps"
cp -R "$ROOT/dist/packages" "$CLI/dist/packages"
cp -R "$ROOT/dist/scripts" "$CLI/dist/scripts"
mkdir -p "$CLI/scripts"
cp "$ROOT/scripts/install-release.sh" "$ROOT/scripts/rollback-release.sh" "$ROOT/scripts/localbox-path.sh" "$CLI/scripts/"
cp -R "$ROOT/skills/localbox" "$CLI/skill"
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$CLI/"
NODE_BIN=${LOCALBOX_NODE_BIN:-}
if [ -z "$NODE_BIN" ]; then NODE_BIN=$(command -v node || true); fi
if [ -z "$NODE_BIN" ] || [ ! -f "$NODE_BIN" ]; then
  echo "an ARM64 node runtime is required; set LOCALBOX_NODE_BIN" >&2
  exit 1
fi
if ! file "$NODE_BIN" | grep -Eq 'arm64|aarch64'; then
  echo "LOCALBOX_NODE_BIN must be an ARM64 executable" >&2
  exit 1
fi
cp "$NODE_BIN" "$CLI/node"
cp "$ROOT/scripts/cli-launcher.sh" "$CLI/bin/localbox"
chmod 0755 "$CLI/bin/localbox"
npm --prefix "$CLI" install --omit=dev --ignore-scripts --no-package-lock --no-audit --no-fund >/dev/null
if [ ! -f "$CLI/node_modules/skills/bin/cli.mjs" ]; then
  echo "the release CLI is missing the pinned skills installer" >&2
  exit 1
fi
cp -R "$CLI/node_modules/skills" "$CLI/skills-installer"
rm -rf "$CLI/skills-installer/node_modules" "$CLI/skills-installer/.cache"

sign_code() {
  if [ -n "$SIGNING_KEYCHAIN" ]; then
    codesign "$@" --keychain "$SIGNING_KEYCHAIN"
  else
    codesign "$@"
  fi
}
verify_code() {
  if [ -n "$SIGNING_KEYCHAIN" ]; then
    codesign "$@" --keychain "$SIGNING_KEYCHAIN"
  else
    codesign "$@"
  fi
}

if [ -n "$IDENTITY" ]; then
  sign_code --force --options runtime --timestamp --entitlements "$APP/Contents/Resources/localbox-hostd.entitlements" --sign "$IDENTITY" "$APP/Contents/MacOS/localbox-hostd"
  sign_code --force --deep --options runtime --timestamp --entitlements "$APP/Contents/Resources/localbox-hostd.entitlements" --sign "$IDENTITY" "$APP"
  sign_code --force --options runtime --timestamp --sign "$IDENTITY" "$CLI/bin/localbox"
  # Keep Node outside hardened runtime so V8 can reserve executable JIT memory;
  # the HostDaemon app is hardened separately.
  sign_code --force --timestamp --sign "$IDENTITY" "$CLI/node"
  verify_code --verify --deep --strict --verbose=2 "$APP"
  verify_code --verify --strict --verbose=2 "$CLI/node" "$CLI/bin/localbox"
fi

APP_ZIP="$OUT_DIR/Localbox-$VERSION.zip"
ditto -c -k --keepParent --norsrc --noextattr --noqtn "$APP" "$APP_ZIP"
CLI_TAR="$OUT_DIR/localbox-cli-$VERSION.tar.gz"
tar -czf "$CLI_TAR" -C "$STAGE" localbox-cli

# The template ships beside the app as zstd parts under GitHub's 2 GiB asset cap; the installer expands them. A
# 128 MiB window (--long=27) is the most Node's zstd decoder accepts by default.
TEMPLATE_PREFIX="localbox-template-$VERSION.img.zst."
zstd -q -T0 -19 --long=27 -c "$LOCALBOX_TEMPLATE_DISK" | (cd "$OUT_DIR" && split -d -a 3 -b 2000m - "$TEMPLATE_PREFIX")

if [ -n "${NOTARY_PROFILE:-}" ]; then
  xcrun notarytool submit "$APP_ZIP" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$APP"
  ditto -c -k --keepParent --norsrc --noextattr --noqtn "$APP" "$APP_ZIP"
fi

cd "$ROOT"
RELEASE_DIR="$OUT_DIR" RELEASE_VERSION="$VERSION" RELEASE_IMAGE_DIGEST="$IMAGE_DIGEST" RELEASE_TEMPLATE="$LOCALBOX_TEMPLATE_DISK" RELEASE_TEMPLATE_PREFIX="$TEMPLATE_PREFIX" RELEASE_PRIVATE_KEY="${RELEASE_PRIVATE_KEY:-}" RELEASE_KEY_ID="${RELEASE_KEY_ID:-}" node --input-type=module <<'NODE'
import { readFileSync, readdirSync, statSync } from "node:fs";
import { makeManifest, sha256, signManifest, writeRelease } from "./dist/scripts/release.js";
const dir = process.env.RELEASE_DIR;
const version = process.env.RELEASE_VERSION;
const imageDigest = process.env.RELEASE_IMAGE_DIGEST;
const source = process.env.RELEASE_TEMPLATE;
const parts = readdirSync(dir).filter((name) => name.startsWith(process.env.RELEASE_TEMPLATE_PREFIX)).sort();
const template = { sha256: await sha256(source), size: statSync(source).size, parts };
let manifest = await makeManifest(dir, version, imageDigest, undefined, template);
if (process.env.RELEASE_PRIVATE_KEY) {
  // The manifest carries no public key: verifiers trust only the pinned one.
  manifest = signManifest(manifest, readFileSync(process.env.RELEASE_PRIVATE_KEY), process.env.RELEASE_KEY_ID || "release");
}
await writeRelease(dir, manifest);
NODE

echo "release artifacts written to $OUT_DIR"
