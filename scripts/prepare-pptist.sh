#!/usr/bin/env bash
# Rebuild the embedded PPTist bundle from verified, pinned sources and our
# embed patch. See web/public/pptist/SOURCE.md for source/license information.
set -euo pipefail

PPTIST_COMMIT="04e06cb397b7f146c6e3e4f62ccddc0b72c041d2"
PPTIST_SHA256="f8e5bf9a08fff6b6c1950d19f15f26e282a263dc8da02257e335990b378ee6fd"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST_DIR="$REPO_ROOT/apps/inno-agent/web/public/pptist"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# A full clone downloads unrelated history and stalled for minutes in review.
# The pinned archive plus lockfile is sufficient to reproduce this component.
curl --fail --location --silent --show-error --retry 2 --max-time 180 \
  "https://codeload.github.com/pipipi-pikachu/PPTist/tar.gz/$PPTIST_COMMIT" -o "$TMP_DIR/source.tar.gz"
python3 - "$TMP_DIR/source.tar.gz" "$PPTIST_SHA256" <<'PY'
import hashlib, pathlib, sys
if hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest() != sys.argv[2]:
    raise SystemExit("PPTist source checksum mismatch")
PY
tar -xzf "$TMP_DIR/source.tar.gz" -C "$TMP_DIR"
cd "$TMP_DIR/PPTist-$PPTIST_COMMIT"
git apply "$REPO_ROOT/scripts/patches/pptist-embed.patch"
npm ci --ignore-scripts --no-audit --no-fund
npx vite build
cp LICENSE dist/LICENSE
cat > dist/SOURCE.md <<SOURCE
# PPTist embedded build

PPTist is licensed under AGPL-3.0; see [LICENSE](./LICENSE).
Upstream source: https://github.com/pipipi-pikachu/PPTist/tree/$PPTIST_COMMIT
Source archive: https://codeload.github.com/pipipi-pikachu/PPTist/tar.gz/$PPTIST_COMMIT
Inno Agent modifications: https://github.com/hhyqhh/inno-agent/blob/refactor/scripts/patches/pptist-embed.patch
Rebuild: run scripts/prepare-pptist.sh from the Inno Agent repository.
The upstream lockfile pins dependencies; the patch adds the host bridge,
import completion/error signals, correlated full PPTX byte exports and embedded save shortcuts,
fixed imported text boxes, immediate model updates, host-owned file actions,
and the standalone export crop correction.
SOURCE
# Replace only after the entire rebuild succeeds.
rm -rf "$DEST_DIR"
mkdir -p "$DEST_DIR"
cp -R dist/. "$DEST_DIR/"
du -sh "$DEST_DIR"
