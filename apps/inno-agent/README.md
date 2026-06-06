# Inno Agent

基于 PI SDK 的个人学习 Agent，支持多渠道交互（CLI / Web UI / 飞书 / QQ / 微信）、三层记忆系统（L1 学习者画像 + L2 Wiki 知识库 + L3 会话记录及跨对话检索）、定时任务调度、Practice Lab 网页终端。

> 本文档聚焦后端开发与运行细节。项目整体介绍、架构和定位见仓库根目录的 [README.md](../../README.md)。

## 前置条件

- Node.js >= 20.6.0
- 已 `npm install` 并 `npm run build`（在仓库根目录执行）
- `runtime/config/config.json` 已配置（参考 `config.example.json`，至少填好一个 provider 的 `apiKey`）

## 安装

```bash
# 后端依赖
npm install

# 前端依赖
cd web && npm install && cd ..
```

## 启动

### 开发模式（推荐）

需要两个终端：

```bash
# 终端 1：启动后端（先编译再运行）
npm run build && npm run server
# 后端监听 http://localhost:3000

# 终端 2：启动前端开发服务器
npm run web:dev
# 前端监听 http://localhost:5173，自动代理 /api 到后端
```

浏览器打开 **http://localhost:5173**

### 开发后重启

如果修改后刷新浏览器没有生效，先停掉旧的前后端进程：

```bash
pkill -f "node dist/server.js"
pkill -f "vite"
```

然后重新启动两个终端：

```bash
# 终端 1：后端
npm run build
npm run server

# 终端 2：前端
npm run web:dev
```

重启规则：

- 修改 `src/server.ts` 或后端 API：需要 `npm run build` 后重启后端。
- 修改 `web/vite.config.ts`：需要重启前端开发服务器。
- 只修改 `web/src/` 下的前端组件或样式：通常 Vite 会热更新，刷新页面即可。
- 上传接口、Wiki API、代理没有生效：优先完整重启前后端。

可以用下面的命令确认服务是否正常：

```bash
curl http://localhost:3000/health
curl http://localhost:5173/api/wiki/pages
```

### 生产模式

```bash
# 编译前端到 web/dist/
npm run web:build

# 编译后端并启动（自动托管 web/dist/ 静态文件）
npm run build && npm run server
```

浏览器打开 **http://localhost:3000**

### CLI 模式

```bash
npm run build && npm start
```

### 沙箱模式

通过 `--sandbox` 启用 OS 级沙箱（基于 [pi-sandbox](https://github.com/carderne/pi-sandbox)），对 Agent 执行的 bash 命令和文件操作进行权限控制。

前置要求：安装 `ripgrep`（`brew install ripgrep`）。

```bash
# CLI + 沙箱
npm run sandbox -- --home ./runtime --workspace ./workspace

# Server + 沙箱
npm run server:sandbox -- --home ./runtime --workspace ./workspace --port 3000

# 也可以直接传 --sandbox 标志
npm run start -- --sandbox
npm run server -- --sandbox
```

沙箱默认关闭，仅在传 `--sandbox` 时启用。启用后：

- bash 命令通过 `sandbox-exec`（macOS）/ `bubblewrap`（Linux）进行 OS 级隔离
- 文件读写/编辑操作按照策略检查路径权限
- 被拦截时弹出交互式提示，可选择允许本次/本项目/全局

沙箱配置文件：

- 全局：`<configDir>/sandbox.json`（即 `runtime/config/sandbox.json`）
- 项目级：`<workspaceDir>/.pi/sandbox.json`（优先级更高）

配置示例：

```json
{
  "enabled": true,
  "network": {
    "allowedDomains": ["github.com", "*.github.com"]
  },
  "filesystem": {
    "denyRead": ["/Users", "/home"],
    "allowRead": [".", "~/.config"],
    "allowWrite": [".", "/tmp"],
    "denyWrite": [".env", "*.pem", "*.key"]
  }
}
```

## 项目结构

```
src/                  # 后端 (Node.js)
├── cli.ts            # CLI 入口
├── server.ts         # HTTP Server + SSE + REST API
├── runtime.ts        # 运行时路径解析（CLI flag > env > 默认）
├── agent/            # PI SDK AgentSession 封装 + inno 扩展
├── channels/         # 飞书 / QQ / 微信等渠道
├── scheduler/        # 定时任务
├── memory/           # L1 学习者 + L2 Wiki + L3 跨对话检索记忆
│   ├── learner/      # L1 学习者画像
│   ├── l2/           # L2 Wiki 知识库
│   └── l3/           # L3 会话记录的 sqlite 索引与阈值召回
├── terminal/         # Practice Lab WebSocket 终端与运行记录
└── storage/          # 文件存储

.inno/skills/         # Inno Agent 实际加载的项目级 Skills 目录

web/                  # 前端 (React + Lit + Tailwind + Vite)
├── src/
│   ├── api/          # 纯 TS fetch 封装（无框架依赖）
│   ├── stores/       # EventEmitter 状态管理（无框架依赖）
│   ├── react/        # React 组件
│   ├── components/   # Lit Web Components
│   ├── types/        # 共享类型
│   └── utils/        # 工具函数
└── index.html
```

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查 |
| POST | `/api/chat` | 发送消息（完整响应） |
| POST | `/api/chat/stream` | 发送消息（SSE 流式） |
| GET | `/api/sessions` | 会话列表 |
| GET | `/api/sessions/:id` | 会话详情 |
| GET | `/api/wiki/pages` | Wiki 页面列表 |
| GET | `/api/wiki/page?path=` | 读取 Wiki 页面 |
| PUT | `/api/wiki/page` | 保存 Wiki 页面 |
| GET | `/api/wiki/graph` | 知识图谱数据 |
| GET | `/api/wiki/stats` | Wiki 统计 |
| GET | `/api/skills` | Skills 列表（读取 `.inno/skills/`） |
| POST | `/api/skills/upload` | 上传 `<skill-name>.zip` 并解压到 `.inno/skills/<name>/` |
| PATCH | `/api/skills/:name` | 启用/关闭 Skill |
| DELETE | `/api/skills/:name` | 删除 Skill |
| POST | `/api/skills/reload` | 重新加载 PI 资源 |
| GET | `/api/settings` | 配置信息 |
| GET/POST/PATCH/DELETE | `/api/jobs[/:id]` | 定时任务 CRUD |
| POST | `/api/jobs/:id/run` | 立即执行任务 |
| GET | `/api/jobs/status` | 定时任务总览状态 |
| GET | `/api/jobs/runs` | 最近任务执行记录 |
| GET | `/api/jobs/:id/runs` | 指定任务执行记录 |

## 定时任务运行时

后端启动时会加载 `data/jobs/jobs.json` 并补齐旧任务的运行状态字段：

- `nextRunAt`：根据 cron 和 timezone 计算的下一次触发时间。
- `lastStatus` / `lastError`：最近一次运行状态。
- `runCount` / `failureCount`：累计执行和失败次数。

每次任务执行都会追加一条 JSONL 记录到 `data/jobs/runs.jsonl`，包含 run id、开始/结束时间、耗时、触发来源、错误信息和输出摘要。任务可以由后台 cron 自动触发，也可以通过 `/api/jobs/:id/run` 或 agent 工具 `run_scheduled_job` 手动触发。
