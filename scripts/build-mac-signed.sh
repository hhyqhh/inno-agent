#!/usr/bin/env bash
# Run in your own terminal: passwords are read without echo and never saved.
set +x
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ "$(uname -s)" != Darwin ]]; then
  echo '签名打包需要 macOS。' >&2
  exit 1
fi
export CSC_LINK="${CSC_LINK:-$HOME/Documents/inno-agent-developer-id.p12}"
export APPLE_ID="${APPLE_ID:-hhyqhh@126.com}"
export APPLE_TEAM_ID="${APPLE_TEAM_ID:-Q5N3RF9WVC}"
unset CSC_IDENTITY_AUTO_DISCOVERY
if [[ ! -f "$CSC_LINK" ]]; then
  echo '找不到本地 .p12 文件，请通过 CSC_LINK 指定绝对路径。' >&2
  exit 1
fi
xcrun --find notarytool >/dev/null
xcrun --find stapler >/dev/null

if [[ -z "${CSC_KEY_PASSWORD:-}" ]]; then
  read -r -s -p '.p12 导出密码（不显示）：' CSC_KEY_PASSWORD </dev/tty
  printf '\n'
fi
if [[ -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]]; then
  read -r -s -p 'Apple App 专用密码（不是 Apple 登录密码，不显示）：' APPLE_APP_SPECIFIC_PASSWORD </dev/tty
  printf '\n'
fi
export CSC_KEY_PASSWORD APPLE_APP_SPECIFIC_PASSWORD
node scripts/check-mac-signing.cjs
# Authenticate/decrypt the P12 without printing its private key or the password.
/usr/bin/openssl pkcs12 -in "$CSC_LINK" -passin env:CSC_KEY_PASSWORD -noout
npm run build
npm run electron:package:mac:signed
