#!/usr/bin/env bash
# Verify the actual app shipped inside the DMG, not a stale unpacked build.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
VERSION=$(node -p 'require("./package.json").version')
DMG="dist-electron/inno-agent-${VERSION}-arm64.dmg"
[[ -f "$DMG" ]] || { echo "缺少产物：$DMG" >&2; exit 1; }
MOUNT=$(mktemp -d "${TMPDIR:-/tmp}/inno-agent-verify.XXXXXX")
cleanup() {
  hdiutil detach "$MOUNT" -quiet >/dev/null 2>&1 || true
  rmdir "$MOUNT" 2>/dev/null || true
}
trap cleanup EXIT
hdiutil attach "$DMG" -readonly -nobrowse -mountpoint "$MOUNT" -quiet
APP="$MOUNT/Inno Agent.app"
[[ -d "$APP" ]] || { echo 'DMG 中未找到 Inno Agent.app。' >&2; exit 1; }
codesign --verify --deep --strict --verbose=2 \
  -R='anchor apple generic and certificate leaf[subject.OU] = "Q5N3RF9WVC"' "$APP"
DETAILS=$(codesign --display --verbose=4 "$APP" 2>&1)
if ! printf '%s\n' "$DETAILS" | grep -Eq 'flags=.*runtime'; then
  echo '应用未启用 Hardened Runtime。' >&2
  exit 1
fi
xcrun stapler validate "$APP"
spctl --assess --type execute --verbose=4 "$APP"
echo "签名、Team ID、Hardened Runtime、公证票据和 Gatekeeper 验证通过：$DMG"
