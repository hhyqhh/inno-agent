#!/usr/bin/env bash
# Regenerate the embedded PPTist bundle served at /pptist/ (used by the
# workspace panel's pptx edit mode). PPTist is AGPL-3.0 — the bundle counts
# as an AGPL component of distributed builds; see README "Third-party
# licenses".
#
# What it does:
#   1. clones pipipi-pikachu/PPTist at a pinned commit (shallow)
#   2. applies scripts/patches/pptist-embed.patch (postMessage embed bridge
#      in src/embed.ts + an export-capture hook in useExport.ts)
#   3. npm install + vite build
#   4. strips bundled CJK webfonts (~37 MB; the editor falls back to system
#      fonts for those families) and stages the rest into
#      apps/inno-agent/web/public/pptist/
#
# Usage: scripts/prepare-pptist.sh
set -euo pipefail

PPTIST_COMMIT="04e06cb397b7f146c6e3e4f62ccddc0b72c041d2"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST_DIR="$REPO_ROOT/apps/inno-agent/web/public/pptist"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "cloning PPTist @ $PPTIST_COMMIT"
git clone --quiet https://github.com/pipipi-pikachu/PPTist.git "$TMP_DIR/pptist"
git -C "$TMP_DIR/pptist" checkout --quiet "$PPTIST_COMMIT"
git -C "$TMP_DIR/pptist" apply "$REPO_ROOT/scripts/patches/pptist-embed.patch"

cd "$TMP_DIR/pptist"
npm install --no-audit --no-fund
npx vite build

rm -f dist/assets/*.woff2
rm -rf "$DEST_DIR"
mkdir -p "$DEST_DIR"
cp -R dist/* "$DEST_DIR/"
du -sh "$DEST_DIR"
echo "staged at $DEST_DIR"
