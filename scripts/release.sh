#!/bin/sh
# Builds one release into OUT_DIR (default dist/release): Localbox-macos-arm64.zip (the signed app, the CLI and
# Sparkle inside it), appcast.xml (Sparkle's feed for that zip, signed), the built-in linux image's parts, release.json
# (signed) and SHA256SUMS. DEVELOPMENT.md ("Releasing") lists the inputs.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
OUT_DIR=${1:-$ROOT/dist/release}
VERSION=${VERSION:-$(node -p "require(process.argv[1]).version" "$ROOT/package.json")}
IMAGE_DIGEST=${IMAGE_DIGEST:-sha256:unrecorded}
IDENTITY=${APPLE_SIGNING_IDENTITY:-}
# The key installers trust (pinned in the installation procedure); a scratch release names its own.
PUBLIC_KEY=${LOCALBOX_RELEASE_PUBLIC_KEY:-$ROOT/skills/localbox/release-public.pem}

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
  echo "zstd is required to compress the linux image (brew install zstd)" >&2
  exit 1
fi
# The built-in linux image directory, as `npm run image:build -- --out DIR` writes it.
LOCALBOX_IMAGE=${LOCALBOX_IMAGE:-}
for file in image.json disk.img boot/efi-vars; do
  if [ -z "$LOCALBOX_IMAGE" ] || [ ! -f "$LOCALBOX_IMAGE/$file" ]; then
    echo "LOCALBOX_IMAGE must name a linux image directory (npm run image:build -- --out DIR); $file is missing" >&2
    exit 1
  fi
done
LOCALBOX_IMAGE=$(CDPATH= cd -- "$LOCALBOX_IMAGE" && pwd)
# The patched Sparkle (npm run sparkle:build), checked against its receipt by build-app.mjs.
export LOCALBOX_SPARKLE_FRAMEWORK=${LOCALBOX_SPARKLE_FRAMEWORK:-$ROOT/dist/sparkle/Sparkle.framework}
if [ ! -d "$LOCALBOX_SPARKLE_FRAMEWORK" ]; then
  echo "no Sparkle framework at $LOCALBOX_SPARKLE_FRAMEWORK: run npm run sparkle:build (or set LOCALBOX_SPARKLE_FRAMEWORK)" >&2
  exit 1
fi
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
    "$RELEASE_PRIVATE_KEY" "$PUBLIC_KEY"; then
    echo "RELEASE_PRIVATE_KEY does not match $PUBLIC_KEY" >&2
    exit 1
  fi
fi
# Without APPLE_SIGNING_IDENTITY the release identity's PKCS#12 signs the app; sign.mjs imports it into a disposable
# keychain. A missing identity fails: a freshly generated one would be a different signer.
# sign.mjs's flags are kept as this script's arguments (OUT_DIR is already read), so a path or name may hold spaces.
if [ -n "$IDENTITY" ]; then
  set -- --identity "$IDENTITY"
elif [ "${ALLOW_UNSIGNED:-0}" = "1" ]; then
  set -- --identity -
else
  LOCAL_P12=${LOCALBOX_SIGNING_P12:-$SIGNING_DIR/release-identity.p12}
  LOCAL_PASSWORD=${LOCALBOX_SIGNING_P12_PASSWORD_FILE:-$SIGNING_DIR/release-identity-password.txt}
  if [ ! -f "$LOCAL_P12" ] || [ ! -f "$LOCAL_PASSWORD" ]; then
    echo "the release signing identity is missing: expected $LOCAL_P12 and $LOCAL_PASSWORD (or set APPLE_SIGNING_IDENTITY)" >&2
    exit 1
  fi
  set -- --p12 "$LOCAL_P12" --password-file "$LOCAL_PASSWORD"
  if [ -f "$SIGNING_DIR/public.json" ]; then
    set -- "$@" --sha1 "$(node -p 'require(process.argv[1]).sha1' "$SIGNING_DIR/public.json")"
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
trap 'rm -rf "$STAGE"' EXIT INT TERM

npm --prefix "$ROOT" run build
npm --prefix "$ROOT" run build:guest-agent -- --release-version "$VERSION"
node "$ROOT/apps/macos/App/scripts/build-app.mjs" --release --out "$STAGE" --version "$VERSION" --public-key "$PUBLIC_KEY" \
  ${LOCALBOX_NODE_BIN:+--node "$LOCALBOX_NODE_BIN"}
node "$ROOT/apps/macos/App/scripts/sign.mjs" "$STAGE/Localbox.app" "$@"
ditto -c -k --keepParent --norsrc --noextattr --noqtn "$STAGE/Localbox.app" "$OUT_DIR/Localbox-macos-arm64.zip"

cd "$ROOT"
# Sparkle's feed offers this release's zip at its versioned URL (https://localbox.sh/mac/appcast.xml redirects to the
# latest release's appcast.xml). The zip and the feed are signed with the same Ed25519 key as release.json, whose
# public half the bundle carries as SUPublicEDKey.
RELEASE_DIR="$OUT_DIR" RELEASE_VERSION="$VERSION" RELEASE_PRIVATE_KEY="${RELEASE_PRIVATE_KEY:-}" \
  RELEASE_DOWNLOAD="https://github.com/${LOCALBOX_RELEASE_REPOSITORY:-dzhng/localbox}/releases/download/v$VERSION" node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
import { appcast, signAppcast, sparkleSignature } from "./dist/scripts/appcast.js";
const dir = process.env.RELEASE_DIR, key = process.env.RELEASE_PRIVATE_KEY && readFileSync(process.env.RELEASE_PRIVATE_KEY);
const zip = readFileSync(`${dir}/Localbox-macos-arm64.zip`);
// An unsigned local packaging check gets an unsigned feed, which every installed app refuses.
const feed = appcast({ version: process.env.RELEASE_VERSION, url: `${process.env.RELEASE_DOWNLOAD}/Localbox-macos-arm64.zip`, length: zip.length,
  signature: key ? sparkleSignature(zip, key) : "", minimumSystemVersion: "14.0" });
writeFileSync(`${dir}/appcast.xml`, key ? signAppcast(feed, key) : feed);
NODE
# The linux image ships beside the app (its disk as zstd parts under GitHub's 2 GiB asset cap, its boot store and
# image.json); the app fetches them into images/linux.
RELEASE_DIR="$OUT_DIR" RELEASE_VERSION="$VERSION" RELEASE_IMAGE_DIGEST="$IMAGE_DIGEST" RELEASE_IMAGE="$LOCALBOX_IMAGE" RELEASE_PRIVATE_KEY="${RELEASE_PRIVATE_KEY:-}" RELEASE_KEY_ID="${RELEASE_KEY_ID:-}" node --input-type=module <<'NODE'
import { readFileSync } from "node:fs";
import { makeManifest, packImage, signManifest, writeRelease } from "./dist/scripts/release.js";
const dir = process.env.RELEASE_DIR;
const version = process.env.RELEASE_VERSION;
const image = await packImage(process.env.RELEASE_IMAGE, dir, `localbox-linux-${version}`);
let manifest = await makeManifest(dir, version, process.env.RELEASE_IMAGE_DIGEST, undefined, image);
if (process.env.RELEASE_PRIVATE_KEY) {
  // The manifest carries no public key: verifiers trust only the pinned one.
  manifest = signManifest(manifest, readFileSync(process.env.RELEASE_PRIVATE_KEY), process.env.RELEASE_KEY_ID || "release");
}
await writeRelease(dir, manifest);
NODE

echo "release artifacts written to $OUT_DIR"
