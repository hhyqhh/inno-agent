#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# scripts/build-linux.sh  —  Inno Agent 本地 Linux 打包脚本
#
# 用法：
#   ./scripts/build-linux.sh                   # 打包 AppImage（默认）
#   ./scripts/build-linux.sh --target deb      # 打包 .deb
#   ./scripts/build-linux.sh --target both     # 同时打包 AppImage + deb
#   ./scripts/build-linux.sh --bump patch      # 先升版本号再打包（patch/minor/major）
#   ./scripts/build-linux.sh --open            # 打包完自动打开产物目录
#
# 依赖：Node >= 20.6.0、npm；架构自动识别（aarch64 / x86_64）。
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ── 镜像源（国内网络下载 Electron / electron-builder 依赖走淘宝镜像） ──────────
# 如已手动 export 过同名变量，则尊重用户设置；否则用 npmmirror.com 默认值。
export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
export ELECTRON_BUILDER_BINARIES_MIRROR="${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}"

BUMP=""
TARGET="appimage"
OPEN_AFTER=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --bump)
      [[ -z "${2:-}" ]] && { echo "错误：--bump 需要 patch|minor|major"; exit 1; }
      BUMP="$2"; shift ;;
    --target)
      [[ -z "${2:-}" ]] && { echo "错误：--target 需要 appimage|deb|both"; exit 1; }
      TARGET="$2"; shift ;;
    --open)   OPEN_AFTER=true ;;
    -h|--help)
      sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)        echo "未知参数: $1"; exit 1 ;;
  esac
  shift
done

# ── 0. 架构 & 目标识别 ────────────────────────────────────────────────────────
ARCH_RAW="$(uname -m)"
case "$ARCH_RAW" in
  aarch64|arm64) EB_ARCH="--arm64" ;;
  x86_64|amd64)  EB_ARCH="--x64" ;;
  *) echo "不支持的架构: $ARCH_RAW"; exit 1 ;;
esac

case "$TARGET" in
  appimage) EB_TARGETS=(--linux AppImage) ;;
  deb)      EB_TARGETS=(--linux deb) ;;
  both)     EB_TARGETS=(--linux AppImage deb) ;;
  *) echo "未知 target: $TARGET（支持 appimage|deb|both）"; exit 1 ;;
esac

# ── 1. 可选：升版本号 ──────────────────────────────────────────────────────────
if [[ -n "$BUMP" ]]; then
  echo "▶ 升级版本号 ($BUMP)…"
  npm version "$BUMP" --no-git-tag-version
fi

VERSION=$(node -p "require('./package.json').version")
echo "▶ 构建版本 v$VERSION  (arch=$ARCH_RAW  target=$TARGET)"

# ── 2. 编译后端 TypeScript ────────────────────────────────────────────────────
echo "▶ 编译后端…"
npm --workspace inno-agent run build

# ── 3. 编译前端（Vite）────────────────────────────────────────────────────────
echo "▶ 编译前端…"
npm --workspace inno-agent-web run build

# ── 4. electron-builder 打包 ──────────────────────────────────────────────────
echo "▶ 打包 Electron ($TARGET, $ARCH_RAW)…"
npx electron-builder "${EB_TARGETS[@]}" "$EB_ARCH" --publish never

# ── 5. 完成提示 ───────────────────────────────────────────────────────────────
OUT_DIR="$REPO_ROOT/dist-electron"
echo ""
echo "✅ 打包完成，产物位于：$OUT_DIR/"
shopt -s nullglob
for f in "$OUT_DIR"/*.AppImage "$OUT_DIR"/*.deb; do
  printf "   %s  (%s)\n" "$(basename "$f")" "$(du -sh "$f" | cut -f1)"
done
shopt -u nullglob

if $OPEN_AFTER; then
  xdg-open "$OUT_DIR" >/dev/null 2>&1 \
    || echo "提示：xdg-open 不可用，请手动查看 $OUT_DIR"
fi
