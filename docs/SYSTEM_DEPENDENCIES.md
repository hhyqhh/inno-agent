# Inno Agent 系统环境依赖文档

本文档列出了 Inno Agent 在沙箱/容器镜像中运行所需的全部系统级依赖，分为**构建时依赖**、**运行时必要依赖**、**可选运行时依赖**、**Python 科学计算环境**、**Native 原生模块**五个部分。

---

## 一、构建时依赖（Docker 镜像构建阶段）

构建阶段需要编译 TypeScript 后端 + Vite 前端，并安装 npm 依赖。其中 `node-pty` 等原生模块在缺少预编译二进制时需要从源码编译。

| 依赖包 | 用途 | 备注 |
|--------|------|------|
| `node` (>= 20.6.0，推荐 >= 22.5) | JavaScript 运行时 | 22.5+ 内置 `node:sqlite`，支持 L3 跨对话记忆 |
| `npm` | 包管理器 | 随 Node.js 一起安装 |
| `python3` | `node-pty` 的 `node-gyp` 编译 | node-pty 在 Linux 上可能需要从源码编译 |
| `make` | `node-pty` 的 `node-gyp` 编译 | 同上 |
| `g++` | `node-pty` 的 `node-gyp` 编译（C++ 源码） | 同上 |
| `ca-certificates` | npm install 和 HTTPS 连接的基础 CA 证书 | Debian 基础镜像通常已内置 |

**建议基础镜像**: `node:22-bookworm`（或更新版本）

---

## 二、运行时必要依赖

这些是项目自身代码直接调用的系统工具，**缺一不可**。

### 2.1 系统命令行工具

| 工具 | 绝对路径 | 调用位置 | 用途 |
|------|----------|----------|------|
| **unzip** | `/usr/bin/unzip` | [`server.ts:642`](apps/inno-agent/src/server.ts#L642) [`server.ts:719`](apps/inno-agent/src/server.ts#L719) | 1. 技能包 ZIP 解压安装<br>2. ZIP 文件内容校验（`unzip -Z1`） |
| **zip** | `/usr/bin/zip` | [`server.ts:688`](apps/inno-agent/src/server.ts#L688) | 工作区目录下载时打包为 ZIP 归档 |
| **bash** | `/bin/bash` | [`local-pty-backend.ts:72`](apps/inno-agent/src/terminal/local-pty-backend.ts#L72) | PTY 终端默认 Shell（当 `$SHELL` 未设置时的回退） |

> ⚠️ **注意**：当前 Dockerfile 的 runtime 阶段只安装了 `unzip`，缺少 `zip`。如需支持工作区下载功能，需补充安装 `zip`。

### Meeting audio import: FFmpeg

Importing or retranscribing meeting audio requires `ffmpeg` on `PATH`. It normalizes WAV, MP3, M4A, WebM, OGG, MP4, AAC and FLAC input to 16 kHz mono PCM WAV. Install it with `apt-get install -y ffmpeg`, `brew install ffmpeg`, or `winget install Gyan.FFmpeg`.

### 2.2 安装命令（Debian/Ubuntu）

```bash
apt-get update && apt-get install -y unzip zip bash ffmpeg && rm -rf /var/lib/apt/lists/*
```

`bash` 在 Debian 基础镜像中通常已预装，但建议显式声明。

### 2.3 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `NODE_ENV` | `production` | 生产模式 |
| `INNO_HOME` | `/var/lib/inno-agent`（Docker） | 主目录 |
| `INNO_CONFIG_DIR` | `/etc/inno-agent`（Docker） | 配置文件目录 |
| `INNO_DATA_DIR` | `<home>/data` | 数据目录（L1/L2/L3 + sessions + jobs） |
| `INNO_SKILLS_DIR` | `<home>/skills` | 技能包目录 |
| `INNO_WORKSPACE_DIR` | `/srv/inno-workspace`（Docker） | 默认工作区目录 |
| `INNO_PORT` | `3000` | HTTP 服务端口 |
| `SHELL` | `/bin/bash` | PTY 终端使用的 Shell |
| `TERM` | `xterm-256color` | 终端类型 |
| `LANG` | `en_US.UTF-8` | 系统语言编码 |

### 2.4 目录结构和权限

```
/etc/inno-agent/          # 配置文件目录（只读）
  └── config.json
/var/lib/inno-agent/      # 数据主目录（读写）
  ├── data/               # L1 学习者档案、L2 Wiki、L3 跨对话记忆、sessions、jobs
  │   ├── learner/        # L1 学习者档案
  │   ├── l2/             # L2 Wiki 知识库
  │   ├── l3/             # L3 SQLite 跨对话索引
  │   ├── sessions/       # PI session JSONL 文件
  │   ├── jobs/           # 定时任务持久化
  │   └── log/            # 服务日志（pino 按天轮转）
  └── skills/             # 技能包目录（可读写）
/srv/inno-workspace/      # 默认工作区目录（读写）
/tmp/                     # 临时文件（ZIP 打包等操作使用）
```

---

## 三、可选运行时依赖

这些依赖仅在启用特定功能时才需要，缺失时对应功能会优雅降级或不可用。

### 3.1 Sandbox 沙箱模式（Linux）

启用 `--sandbox` 参数时需要以下系统工具：

| 工具 | 用途 | 安装命令 |
|------|------|----------|
| **bwrap** (bubblewrap) | Linux 内核命名空间隔离（用户空间容器） | `apt-get install -y bubblewrap` |
| **socat** | 网络命名空间内的 Unix Socket 代理转发 | `apt-get install -y socat` |
| **ripgrep** (`rg`) | 扫描危险文件构建 deny path 列表 | `apt-get install -y ripgrep` |

`apply-seccomp`（seccomp-bpf 过滤器）已由 `@carderne/sandbox-runtime` 捆绑在 `vendor/seccomp/` 中，无需单独安装。预编译版本仅支持 **x64** 和 **ARM64** 架构。

> **参考**: [pi-sandbox/index.ts:60](node_modules/pi-sandbox/index.ts#L60) 明确注明 *"Linux also requires: bubblewrap, socat, ripgrep"*

### 3.2 Sandbox 沙箱模式（macOS）

macOS 上使用系统内置工具，无需额外安装：
- `sandbox-exec` — macOS App Sandbox 内核级执行（系统内置）
- `log stream` — 监控沙箱违规事件（系统内置）

### 3.3 L3 跨对话记忆

| 依赖 | 要求 | 降级行为 |
|------|------|----------|
| `node:sqlite` | Node.js >= 22.5.0 | 低于 22.5 时 **L3 记忆功能自动禁用**，不影响其他功能 |

### 3.4 文档解析（parse_document 工具）

文档解析通过 `@llamaindex/liteparse` 实现，支持 PDF、Office 文档和图片的文本提取。

**Office 文档解析需要系统级依赖：** liteparse 通过 headless LibreOffice 将 Office 文档（`.docx`、`.xlsx`、`.pptx` 等）转换为 PDF 后再提取文本。

| 平台 | 安装命令 |
|------|----------|
| macOS | `brew install --cask libreoffice` |
| Ubuntu/Debian | `apt-get install libreoffice` |
| Windows | `choco install libreoffice-fresh` |

其他格式的依赖通过 npm 包预编译二进制捆绑，无需安装系统级库：

- PDF 解析：`@hyzyla/pdfium`（WASM），`pdfjs-dist`（WASM）
- 图片/OCR：`sharp`（捆绑 libvips 预编译），`tesseract.js`（WASM）
- 支持的格式：`.pdf` `.docx` `.xlsx` `.pptx` `.png` `.jpg` `.jpeg` `.gif` `.webp` `.tiff`
- 文件大小上限：100MB

### 3.5 Python 科学计算环境（Miniforge）

Inno Agent 是一个面向学习和探索的智能体项目，用户经常需要通过终端执行 Python 脚本、Jupyter Notebook、数据分析等任务。推荐在镜像中预装 **Miniforge**（conda-forge 社区维护的 conda 发行版），提供完整的 Python 科学生态。

#### 为什么不选 Anaconda / Miniconda？

Anaconda 公司自 2020 年起修改了服务条款：**员工 ≥ 200 人的商业组织**使用 Anaconda 默认包仓库（`defaults` channel）需要购买商业许可。Miniconda 虽然安装器本身是 BSD 协议，但默认源同样指向 Anaconda 的商业仓库，存在同样的合规风险。

Miniforge 由 conda-forge 社区维护，**完全开源免费，商用无限制**，且 conda-forge 的包更新更快、覆盖更广。

#### Docker 安装

```dockerfile
# 安装 Miniforge（conda-forge 社区版，商用无限制）
ENV CONDA_DIR=/opt/conda
RUN wget -q https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-Linux-$(uname -m).sh \
    -O /tmp/miniforge.sh \
    && bash /tmp/miniforge.sh -b -p ${CONDA_DIR} \
    && ${CONDA_DIR}/bin/conda init bash \
    && rm /tmp/miniforge.sh
ENV PATH=${CONDA_DIR}/bin:${PATH}
```

安装后可用 `conda install` 或 `pip install` 安装任意 Python 包，如：

```bash
conda install -y numpy pandas matplotlib scikit-learn jupyter
pip install torch torchvision  # 深度学习框架
```

#### 包选用建议

| 场景 | 推荐安装 |
|------|----------|
| 基础数据分析 | `numpy pandas matplotlib` |
| 机器学习 | `scikit-learn xgboost` |
| 深度学习 | `pytorch` (conda-forge) 或 `tensorflow` |
| 交互式编程 | `jupyterlab ipykernel` |
| Web 爬虫 | `requests beautifulsoup4 lxml` |
| 图像处理 | `opencv pillow` |

---

## 四、Native 原生 Node.js 模块

以下 npm 包包含 C/C++ 原生扩展（`.node` 二进制文件），需要在目标平台上正确加载。

### 4.1 直接依赖

| 包名 | 原生文件 | 系统要求 | 备注 |
|------|----------|----------|------|
| **node-pty** | `prebuilds/<platform>/pty.node` + `spawn-helper` | PTY 子系统（forkpty/openpty） | 当前已确认的预编译平台：darwin-arm64, darwin-x64, win32-arm64, win32-x64, linux-x64, linux-arm64。若目标平台无预编译，则需从源码编译（需要 python3/make/g++）。`spawn-helper` 需要 **可执行权限**（`chmod +x`），Electron 打包时由 `scripts/after-pack.cjs` 自动处理。 |
| **sharp** | `@img/sharp-<platform>/` | 无（捆绑 libvips） | 图像处理，通过 `@llamaindex/liteparse` 间接依赖。libvips 已预编译捆绑在所有主要平台上。 |
| **koffi** | 编译的 `.node` 二进制 | `dlopen`/`dlsym`（Unix） | C FFI 接口，用于动态加载系统共享库。通过 `@hyzyla/pdfium` 间接依赖。 |

### 4.2 间接依赖（来自 PI SDK 生态）

| 包名 | 原生文件 | 系统要求 | 备注 |
|------|----------|----------|------|
| **@earendil-works/pi-tui** | macOS: `darwin-modifiers.node`<br>Windows: `win32-console-mode.node` | macOS CGEvent / Windows Console API | PI SDK TUI 键盘修饰键检测，仅 CLI/TUI 模式使用 |
| **iconv-corefoundation** | 编译的 `.node` 二进制 | macOS CoreFoundation 框架 | macOS 专用字符集转换，通过 `@carderne/sandbox-runtime` 间接依赖 |

### 4.3 Electron 相关

Electron 桌面打包时需要以下注意事项：
- `node-pty` 在 `package.json` 的 `asarUnpack` 中显式声明（`**/node_modules/node-pty/**/*`），确保原生 `.node` 文件从 asar 归档中解压
- `@homebridge` 也在 `asarUnpack` 中声明，但当前 `node_modules` 中未发现该目录

---

## 五、完整 Docker 镜像安装参考

### 5.1 多阶段构建的 Dockerfile 建议

```dockerfile
# ===== 构建阶段 =====
FROM node:22-bookworm AS build

# 安装 node-pty 编译工具（python3, make, g++）+ CA 证书
RUN apt-get update && apt-get install -y \
    ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# ... npm ci & npm run build ...

# ===== 运行时阶段 =====
FROM node:22-bookworm AS runtime

# 安装运行时系统工具
RUN apt-get update && apt-get install -y \
    unzip zip bash wget \
    && rm -rf /var/lib/apt/lists/*

# 安装 Miniforge（Python 科学计算环境，conda-forge 社区版，商用无限制）
ENV CONDA_DIR=/opt/conda
RUN wget -q https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-Linux-$(uname -m).sh \
    -O /tmp/miniforge.sh \
    && bash /tmp/miniforge.sh -b -p ${CONDA_DIR} \
    && ${CONDA_DIR}/bin/conda init bash \
    && rm /tmp/miniforge.sh
ENV PATH=${CONDA_DIR}/bin:${PATH}

# 可选：安装 sandbox 支持
# RUN apt-get update && apt-get install -y \
#     bubblewrap socat ripgrep \
#     && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    INNO_HOME=/var/lib/inno-agent \
    INNO_CONFIG_DIR=/etc/inno-agent \
    INNO_DATA_DIR=/var/lib/inno-agent/data \
    INNO_SKILLS_DIR=/var/lib/inno-agent/skills \
    INNO_WORKSPACE_DIR=/srv/inno-workspace \
    INNO_PORT=3000

# 创建必要的目录结构
RUN mkdir -p /etc/inno-agent \
    /var/lib/inno-agent/data/learner \
    /var/lib/inno-agent/data/l2 \
    /var/lib/inno-agent/data/l3 \
    /var/lib/inno-agent/data/sessions \
    /var/lib/inno-agent/data/jobs \
    /var/lib/inno-agent/data/log \
    /var/lib/inno-agent/skills \
    /srv/inno-workspace

EXPOSE 3000
CMD ["node", "apps/inno-agent/dist/server.js"]
```

### 5.2 一行安装（Debian/Ubuntu 完整版）

```bash
# 运行时必要
apt-get update && apt-get install -y unzip zip bash wget

# Miniforge（Python 科学计算环境，商用免费）
wget -q https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-Linux-$(uname -m).sh -O /tmp/miniforge.sh \
  && bash /tmp/miniforge.sh -b -p /opt/conda \
  && /opt/conda/bin/conda init bash \
  && rm /tmp/miniforge.sh
ENV PATH=/opt/conda/bin:${PATH}

# 沙箱模式（可选）
apt-get install -y bubblewrap socat ripgrep
```

### 5.3 node-pty spawn-helper 可执行权限

`node-pty` 的 `spawn-helper` 二进制文件在 npm 安装后可能缺少可执行权限。项目代码中包含运行时自动修复（[`local-pty-backend.ts:8-44`](apps/inno-agent/src/terminal/local-pty-backend.ts#L8-L44)），但 Electron 打包时需在 `afterPack` 钩子中处理（[`scripts/after-pack.cjs`](scripts/after-pack.cjs)）。

Docker 镜像中通常在构建阶段 `npm install` 后权限正常，无需额外处理。如果遇到 PTY 终端连接失败（`posix_spawnp failed`），执行以下命令修复：

```bash
find /app/node_modules/node-pty/prebuilds -name "spawn-helper" -exec chmod +x {} \;
```

---

## 六、依赖关系图

```
Inno Agent
├── [运行时必要] bash ───────────────── PTY 终端 Shell
├── [运行时必要] unzip ──────────────── 技能包安装、ZIP 校验
├── [运行时必要] zip ────────────────── 工作区下载打包
├── [运行时可选] Node.js >= 22.5 ────── L3 跨对话记忆 (node:sqlite)
├── [运行时可选] bwrap ──────────────── Linux Sandbox 命名空间隔离
├── [运行时可选] socat ──────────────── Linux Sandbox 网络代理
├── [运行时可选] ripgrep ────────────── Linux Sandbox 危险文件扫描
├── [运行时可选] Miniforge ──────────── Python 科学计算环境 (conda-forge)
│
├── [原生模块] node-pty ─────────────── PTY 伪终端 (C++/N-API)
├── [原生模块] sharp/libvips ────────── 图像处理 (C++/预编译)
├── [原生模块] koffi ────────────────── C FFI 动态库加载 (C/N-API)
├── [原生模块] @hyzyla/pdfium ───────── PDF 解析 (C++→WASM)
├── [原生模块] tesseract.js ─────────── OCR 文字识别 (C++→WASM)
│
├── [构建时] node >= 20.6 ───────────── TypeScript 编译 + 运行时
├── [构建时] python3 ────────────────── node-pty node-gyp 编译
├── [构建时] make ───────────────────── node-pty node-gyp 编译
├── [构建时] g++ ────────────────────── node-pty C++ 源码编译
└── [构建时] ca-certificates ────────── npm install HTTPS 连接
```

---

## 七、常见问题排查

| 问题现象 | 可能原因 | 解决方法 |
|----------|----------|----------|
| PTY 终端无法连接（`posix_spawnp failed`） | `spawn-helper` 缺少可执行权限 | `chmod +x node_modules/node-pty/prebuilds/<platform>/spawn-helper` |
| L3 记忆功能不工作 | Node.js 版本 < 22.5 | 升级到 Node.js 22.5+，或忽略（L3 功能可选） |
| 技能包上传失败 | 缺少 `unzip` 命令 | `apt-get install -y unzip` |
| 工作区下载 ZIP 失败 | 缺少 `zip` 命令 | `apt-get install -y zip` |
| 沙箱模式启动失败 | 缺少 `bwrap`/`socat`/`ripgrep` | `apt-get install -y bubblewrap socat ripgrep` |
| 文档解析报错 | `@llamaindex/liteparse` 原生模块加载失败 | 确保 npm install 完整执行，sharp 预编译二进制匹配平台 |
| npm install 时 node-pty 编译失败 | 缺少编译工具 | `apt-get install -y python3 make g++` |
