#!/usr/bin/env bash
# Download and stage LibreOffice for bundling into the desktop installers.
#
# Layout produced (gitignored):
#   vendor/libreoffice/darwin-arm64/LibreOffice.app/   (from the official DMG)
#   vendor/libreoffice/win32-x64/LibreOffice/          (MSI administrative extract;
#                                                       run scripts/prepare-libreoffice.ps1
#                                                       on Windows / windows-latest CI)
#
# electron-builder picks these up via per-platform extraResources and the
# backend finds them through INNO_BUNDLED_TOOLS_DIR (see electron/main.js and
# apps/inno-agent/src/office/engine-locator.ts).
#
# Usage:
#   scripts/prepare-libreoffice.sh [--keep-locales] [--version <lo-version>]
#
# Env:
#   LO_SHA256   optional expected SHA-256 of the DMG; verified when set.
set -euo pipefail

LO_VERSION="26.8.1"
KEEP_LOCALES=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep-locales) KEEP_LOCALES=1; shift ;;
    --version) LO_VERSION="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST_DIR="$REPO_ROOT/vendor/libreoffice/darwin-arm64"
DMG="LibreOffice_${LO_VERSION}_MacOS_aarch64.dmg"
URL="https://download.documentfoundation.org/libreoffice/stable/${LO_VERSION}/mac/aarch64/${DMG}"

if [[ ! -d "$DEST_DIR/LibreOffice.app" ]]; then

TMP_DIR="$(mktemp -d)"
trap 'hdiutil detach "$TMP_DIR/mnt" -quiet 2>/dev/null || true; rm -rf "$TMP_DIR"' EXIT

echo "downloading $URL"
curl -fL --retry 3 -o "$TMP_DIR/$DMG" "$URL"

if [[ -n "${LO_SHA256:-}" ]]; then
  echo "$LO_SHA256  $TMP_DIR/$DMG" | shasum -a 256 -c -
fi

mkdir -p "$TMP_DIR/mnt" "$DEST_DIR"
hdiutil attach -readonly -nobrowse -mountpoint "$TMP_DIR/mnt" "$TMP_DIR/$DMG"
cp -R "$TMP_DIR/mnt/LibreOffice.app" "$DEST_DIR/LibreOffice.app"
hdiutil detach "$TMP_DIR/mnt" -quiet

else
  echo "already staged: $DEST_DIR/LibreOffice.app"
fi

if [[ "$KEEP_LOCALES" -eq 0 ]]; then
  # Strip interface locales we do not ship with; the app UI stays in the
  # system language for en/zh users, which covers Inno Agent's audience.
  # This removes well over half of LibreOffice.app's installed size.
  find "$DEST_DIR/LibreOffice.app/Contents/Resources" -maxdepth 1 -name "*.lproj" \
    ! -name "en.lproj" ! -name "zh_CN.lproj" ! -name "zh_TW.lproj" ! -name "Base.lproj" \
    -exec rm -rf {} + 2>/dev/null || true
fi

# The Document Foundation signs the bundled LibreOfficePython launcher with a
# macOS launch constraint: only LibreOffice's own processes may exec it, so a
# direct spawn from our backend dies with SIGKILL ("Code Signature Invalid /
# Launch Constraint Violation"). Re-signing the launcher ad hoc drops that
# constraint. The signed CI build re-signs every bundled Mach-O with our own
# Developer ID at packaging time, which has the same effect — this ad hoc
# signature only matters for local/dev use of the staged tree.
PYBIN="$DEST_DIR/LibreOffice.app/Contents/Frameworks/LibreOfficePython.framework/Versions/Current/Resources/Python.app/Contents/MacOS/LibreOfficePython"
if [[ -f "$PYBIN" ]]; then
  codesign --remove-signature "$PYBIN" 2>/dev/null || true
  codesign --sign - --force "$PYBIN"
  echo "re-signed $(basename "$PYBIN") (ad hoc, drops launch constraint)"
fi

# Bundle both serif and sans CJK fallbacks; keep source font choices distinct.
FONTS_DIR="$DEST_DIR/LibreOffice.app/Contents/Resources/fonts/truetype"
mkdir -p "$FONTS_DIR"
for family in Sans Serif; do
  for weight in Regular Bold; do
    font="Noto${family}SC-${weight}.otf"
    if [[ ! -f "$FONTS_DIR/$font" ]]; then
      echo "fetching $font"
      curl -fL --retry 3 -o "$FONTS_DIR/$font" \
        "https://raw.githubusercontent.com/googlefonts/noto-cjk/main/$family/SubsetOTF/SC/$font"
    fi
  done
  curl -fL --retry 3 -o "$FONTS_DIR/Noto${family}-LICENSE.txt" \
    "https://raw.githubusercontent.com/googlefonts/noto-cjk/main/$family/LICENSE"
done

# The copy loses its quarantine attribute, but the engine runs headless and
# unsigned-spawned; strip nothing else. Report the result.
du -sh "$DEST_DIR/LibreOffice.app"
echo "staged at $DEST_DIR/LibreOffice.app"
