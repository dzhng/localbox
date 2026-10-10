#!/bin/sh
set -eu

OUT_DIR=${1:-dist/release}
VERSION=${VERSION:-0.1.0}
IMAGE_DIGEST=${IMAGE_DIGEST:-sha256:unrecorded}
mkdir -p "$OUT_DIR"
if [ "$(uname -m)" != "arm64" ]; then
  echo "agent-computer releases require arm64" >&2
  exit 1
fi
echo "Build arm64 app/CLI artifacts into $OUT_DIR, then generate release.json and SHA256SUMS with scripts/release.ts (version $VERSION, image $IMAGE_DIGEST)."
