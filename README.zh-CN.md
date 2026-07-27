# Inno Agent

> 开源的**个人学习智能体**——分层记忆、主动调度、多渠道消息、工作区级练习实验室,基于 [Pi coding-agent SDK](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 构建,**不修改其内核**。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.6.0-brightgreen.svg)](https://nodejs.org)
[![Release](https://img.shields.io/github/v/release/hhyqhh/inno-agent.svg)](https://github.com/hhyqhh/inno-agent/releases)
[![Website](https://img.shields.io/badge/Website-Inno%20Agent-ff6b35.svg)](https://hhyqhh.github.io/inno-agent-website/)

[English](./README.md) | **简体中文**

🌐 **[项目主页](https://hhyqhh.github.io/inno-agent-website/)** · 📄 **[技术报告](./docs/inno-agent.pdf)**(arXiv,2026 年 6 月)· 📦 **[资源中心](https://github.com/Chloris-Blaxk/inno-agent-hub)**(技能库 + 工作区预设)

<p align="center">
  <img src="./docs/assets/l2-wiki.png" alt="Inno Agent — L2 wiki 知识库与知识图谱" width="100%" />
</p>

Inno Agent 是服务于单个学习者的长期学习伙伴。它把长期学习支持组织为三个显式记忆层——**L1 学习者画像**、**L2 原生 wiki 知识库**、**L3 会话记录与跨对话检索**——并围绕它们构建学习闭环:cron 调度器、个人 IM 渠道(飞书 / 微信),以及带浏览器内终端的练习实验室。

三种形态共享同一份运行时状态:

- **桌面应用**(Electron)—— macOS / Windows 一键安装。
- **Web UI**(React 19 + Tailwind 4)—— Node HTTP 服务,SSE 流式对话、终端、wiki 图谱、任务、技能与设置。
- **终端 CLI**(`inno`)—— 纯 TUI agent,无 HTTP。

## 为什么是 Inno Agent

通用编程 agent 面向开放式软件工程优化,而教育是不同的目标:价值在于**个性化讲解、误解诊断、出题、反馈、复习调度、隐私与低延迟的持续交互**。Inno Agent 的设计立场:

- **分层记忆,而非扁平的聊天摘要**——学习者状态、归档知识与近期对话生命周期不同,各自独立成层。
- **持久事实写入工具,而非回复**——凡影响后续教学的内容都通过工具写入 L1/L2,个性化决策有据可查。
- **开放、可纠正的学习者模型**——L1 画像对学习者可检视、可编辑,系统提示词禁止无证据的标签。
- **永不修改 SDK 内核**——所有学习行为通过注册工具和单个扩展钩子实现,运行时始终与上游兼容。

## 功能特性

- 🧠 **三层记忆**
  - **L1 学习者画像**——目标、知识状态、误解、偏好;每轮汇总为上下文包注入系统提示词。
  - **L2 原生 wiki**——人类可读、agent 可查询的页面,混合检索(词法 BM25 + 知识图谱),LLM 辅助摘要,支持 PDF/Office/图片摄入。
  - **L3 会话检索**——会话历史索引进 SQLite(FTS5),按相关性阈值门控的跨对话召回。
- ⏰ **主动调度器**——自然语言创建 cron 任务,可从 agent、UI 或守护进程触发。
- 💬 **个人 IM 渠道**——飞书(原生)+ 微信(iLink 扫码登录或 bridge 模式),统一dispatcher 回推提醒。
- 🧪 **练习实验室**——工作区级 Web 终端(xterm.js over WebSocket),运行记录可被 agent 读取。
- 🎯 **简单模式 + 预设**——面向非技术用户的一键预设工作区(教案、PPT 制作、情景讲解)。
- 🧩 **技能系统 + 内容中心**——从远程 hub(GitHub 仓库或自建 bundle 服务)浏览、导入技能与预设。
- 🔌 **可插拔模型供应商**——任意 `openai-completions` 或 `anthropic-messages` 端点(Anthropic、OpenAI、DeepSeek、Ollama、本地模型),UI 内实时切换。
- 🌍 **国际化与主题**——中/英文界面,四套主题。
- 🛡️ **可选系统级沙箱**——通过 [pi-sandbox](https://github.com/carderne/pi-sandbox) 管控 bash/文件操作;可选 `pi-subagents` 子代理。

## 快速开始

### 方式 A —— 桌面应用(最简单)

从 [**GitHub Releases**](https://github.com/hhyqhh/inno-agent/releases) 下载最新安装包:

- **macOS**(Apple Silicon):`Inno.Agent-x.y.z-arm64.dmg` —— 未签名,首次启动请右键 → 打开。
- **Windows**(x64):`Inno.Agent.Setup.x.y.z.exe` 或 `.msi`。

首次启动会在 `~/.inno-agent/config/config.json` 生成默认配置——在该文件(或应用内设置)中填入供应商 API key。

### 方式 B —— 源码运行

```bash
git clone https://github.com/hhyqhh/inno-agent.git
cd inno-agent

npm install      # 从 npm 拉取 Pi SDK
npm run build    # 编译后端 + 前端

mkdir -p runtime/config runtime/data runtime/skills workspace
cp config.example.json runtime/config/config.json
# 编辑 runtime/config/config.json,填入 providers[*].apiKey

npm run server -- --home ./runtime --workspace ./workspace --port 3000
```

打开 **http://localhost:3000**。详细的 5 分钟上手指南(含各供应商配置示例)见 **[QUICKSTART.md](./QUICKSTART.md)**。

### 方式 C —— Docker

```bash
docker compose up -d   # 服务端口 3000,挂载 runtime/ 与 workspace/
```

## 运行模式

```bash
npm run server          # Web UI(API + 已构建前端,端口 3000)
npm run start           # CLI(纯终端 agent,无 HTTP)
npm run electron        # 本地运行桌面应用
npm run server:sandbox  # 带系统级沙箱的 Web UI(需要 ripgrep)

# 开发模式:后端 :3000 + Vite 热更新 :5173
npm run dev:server & npm run web:dev
```

`restart-dev.sh` 编排完整开发生命周期(构建、启动、停止、状态、日志、冒烟测试)——运行 `bash restart-dev.sh --help` 查看。

## 配置

`runtime/config/config.json`(模板:[`config.example.json`](./config.example.json)):

```json
{
  "defaultProvider": "innospark",
  "defaultModel": "claude-sonnet-4-6",
  "providers": {
    "innospark": {
      "baseUrl": "https://api.example.com",
      "api": "anthropic-messages",
      "apiKey": "replace-me",
      "models": [{ "id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6" }]
    }
  },
  "server": { "port": 3000 },
  "channels": {
    "feishu": { "enabled": false },
    "wechat": { "enabled": false, "mode": "ilink" }
  },
  "memory": { "l1Enabled": true, "l2Enabled": true, "l3Enabled": true }
}
```

每个供应商声明 `baseUrl`、`api`(`openai-completions` 或 `anthropic-messages`)、`apiKey` 和 `models[]` 列表。在 UI 中切换模型时,服务器会热更新此文件。

### 运行时路径

CLI 与 server 都通过 `apps/inno-agent/src/runtime.ts` 解析路径。优先级:**CLI 参数 > 环境变量 > `~/.inno-agent/...`**。

| CLI 参数 | 环境变量 | 默认值 |
|---|---|---|
| `--home` | `INNO_HOME` | `~/.inno-agent` |
| `--config-dir` | `INNO_CONFIG_DIR` | `<home>/config` |
| `--data` | `INNO_DATA_DIR` | `<home>/data` |
| `--skills` | `INNO_SKILLS_DIR` | `<home>/skills` |
| `--workspace` | `INNO_WORKSPACE_DIR` | 调用时的工作目录 |
| `--port` | `INNO_PORT` | `3000` |

### 内容中心(Content Hub)

技能库与简单模式预设均从远程**内容中心**拉取——默认是公开 GitHub 仓库 [`Chloris-Blaxk/inno-agent-hub`](https://github.com/Chloris-Blaxk/inno-agent-hub)。在 `config.json` 的 `contentHub`(或 **设置 → 内容中心**)中可切换为私有 GitHub 仓库(`"type": "github"`)或自建 bundle 服务(`"type": "bundle"`)——零依赖的 bundle 服务器见 [`scripts/content-hub-server/`](./scripts/content-hub-server/)。预设下载后本地缓存,应用内置模板作为离线兜底。

## 架构

四层结构:**用户界面 → 应用层 → Pi agent 运行时 → 分层记忆。**

```text
用户界面          CLI · Web UI (React) · 桌面应用 · 飞书 · 微信
        ↓
应用层            渠道适配 · HTTP API (SSE) · 记忆编排
                  cron 调度器 · 练习实验室 · WebSocket 终端
        ↓
Agent 运行时      Pi AgentSession · 注册工具 · inno 扩展
(Pi SDK,未修改)  通用 LLM 供应商  ──或──  蒸馏教育模型
        ↓
分层记忆          L1 学习者画像 · L2 原生 wiki · L3 会话记录
```

- **Agent 核心**——`@earendil-works/pi-coding-agent` 提供主循环。[`inno-extension.ts`](./apps/inno-agent/src/agent/inno-extension.ts) 注册供应商与工具(L1/L2/L3、调度器、练习实验室、文档、OCR),并通过 `before_agent_start` 钩子把 L1 上下文包与阈值门控的 L3 召回注入系统提示词。
- **记忆**——L1(`src/memory/learner/`):证据驱动的画像 + 事件日志。L2(`src/memory/l2/`):带图谱、摘要、文档摄入与混合检索的结构化 wiki,经 agent 工具和 `/api/wiki/*` 暴露。L3(`src/memory/l3/`):叠加在 Pi 会话 JSONL 文件上的 SQLite FTS5 索引。
- **调度器**(`src/scheduler/`)——cron 任务持久化到 `jobs.json` + `runs.jsonl`。
- **渠道**(`src/channels/`)——`ChannelRegistry`,支持飞书、微信(iLink / bridge)、QQ(bridge)。
- **HTTP 服务**(`src/server.ts`)——原生 Node `http.createServer`,SSE 流式对话 + WebSocket 终端;路由表见 [`apps/inno-agent/README.md`](./apps/inno-agent/README.md)。
- **Web UI**(`web/src/`)——React 19 + Tailwind 4。状态在框架无关的 `EventEmitter` stores(`web/src/stores/`),REST/SSE 调用在 `web/src/api/`。

## 仓库结构

```text
apps/inno-agent/           后端(CLI + HTTP 服务),TypeScript → dist/
apps/inno-agent/web/       前端(React 19 + Tailwind 4 + Vite)
apps/inno-agent/presets/   内置预设工作区(离线兜底)
electron/                  Electron 主进程(桌面应用)
scripts/content-hub-server/  自建内容中心 bundle 服务
runtime/                   本地运行时状态(配置、数据、技能)—— gitignored
workspace/                 默认 agent 工作目录 —— gitignored
```

## 部署

典型的生产布局,分离代码、配置、数据与工作区:

```bash
INNO_CONFIG_DIR=/etc/inno-agent \
INNO_DATA_DIR=/var/lib/inno-agent/data \
INNO_SKILLS_DIR=/var/lib/inno-agent/skills \
INNO_WORKSPACE_DIR=/srv/inno-workspace \
INNO_PORT=3000 \
npm run server
```

提供 [`Dockerfile`](./Dockerfile) 与 [`docker-compose.yml`](./docker-compose.yml) 作为起点;完整依赖说明见 [`docs/SYSTEM_DEPENDENCIES.md`](./docs/SYSTEM_DEPENDENCIES.md)。桌面打包说明见 [`ELECTRON_BUILD.md`](./ELECTRON_BUILD.md)。

## 使用案例与文档

- [技能教程 —— 构建工作区 Agent](./docs/use-cases/skill-tutorial.md)——用 `agent.md` 和 `.skills/` 构建工作区范围的自定义学习 agent。
- [QUICKSTART.md](./QUICKSTART.md)——5 分钟上手指南。
- [apps/inno-agent/README.md](./apps/inno-agent/README.md)——后端 API 路由表。

## 贡献

欢迎 Issue 和 PR。提交 PR 前请先在本地运行 `npm run build`——TypeScript 构建兼作健全性检查(暂未配置 lint/测试流程)。保持改动聚焦,遵循现有代码风格,行为变更时同步更新文档。

## 社区

扫码加入微信用户群,提问、分享使用场景、关注更新:

<p align="center">
  <img src="./docs/assets/wechat-community-qr.png" alt="Inno Agent 微信社区群二维码" width="240" />
</p>

## 许可证

[MIT](./LICENSE)。本项目依赖 Pi SDK(`@earendil-works/pi-*`,作者 Mario Zechner),同为 MIT 许可,经 npm 引入。

## 引用

```bibtex
@misc{hao2026innoagent,
  author       = {Hao Hao, Ye Lu, Ruotong Yang, Yongheng Guo and Aimin Zhou},
  title        = {Inno Agent: An Open-Source Personal Learning Agent with Layered Memory, Educational Post-Training, and Local Deployment},
  year         = {2026},
  publisher    = {GitHub},
  journal      = {GitHub repository},
  howpublished = {\url{https://github.com/hhyqhh/inno-agent}}
}
```
