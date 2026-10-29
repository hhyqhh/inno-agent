# Agent Instructions

## 核心原则

- 修改行为前先定位原因:结合源码、日志和运行时证据,区分已确认原因与待验证假设;用户未明确要求修改代码时只调查不修改。
- 单一所有者、单一写入路径:每份持久化状态(会话 sidecar、trace、workspace-activity、各类注册表)只允许一个组件写;不为已有职责新建平行的辅助实现。
- 保留与任务无关的本地改动;不顺手修复范围外的问题、不重构无关代码,除非用户明确要求。
- 修复 bug 时在注释中说明原因和依据;发现设计缺陷先与用户对齐,不持续堆兜底分支。

## 命令与仓库结构

以下命令从仓库根目录执行(npm workspaces):

| 用途             | 命令                    |
| ---------------- | ----------------------- |
| 构建(后端+前端) | `npm run build`         |
| 全量测试         | `npx vitest run`        |
| 单个测试文件     | `npx vitest run <path>` |
| 后端服务         | `npm run dev:server`    |
| 前端开发         | `npm run web:dev`       |
| 一键重启开发环境 | `bash restart-dev.sh`   |

- `apps/inno-agent/src/`:后端。`server/`(HTTP 路由,入口 `server.ts`,route 域在 `server/routes/`)、`agent/`(pi-runner 会话编排与工具装配)、`memory/`(l1/l2/l3 三层记忆,l3 用 sqlite)、`channels/`(飞书/微信渠道)、`scheduler/`、`checkins/`、`content-source/`、`workspace/`、`terminal/`、`storage/`(file-store,唯一的 JSON/JSONL IO 层,无对外依赖)、`utils/`(path-safety、process-fallback 等)。
- `apps/inno-agent/web/src/`:React 前端。共享控件在 `react/ui/`,统一从 `react/ui/index.ts` 导入;语义 token 与主题变量在 `app.css` / `themes.css`。
- `electron/`:桌面壳(main.js / preload.cjs);`apps/showcase/`:案例回放站。
- `design.md`:GUI 设计规范。修改 `web/src/` 下任何界面前先读它;复用共享组件与语义 token,不在业务组件手写按钮/输入/菜单样式,不新增裸色值和一次性字号,light/dark 两套主题都要验证。

## 实现与验证

- 代码改动完成后自动执行 `npm run build`,失败则修复后重跑,并如实报告最终结果。
- 行为有改动时补对应测试(`*.test.ts` 与源码同目录);报告真实测试结果,不把失败写成通过,未执行的验证如实说明。
- 请求路径与其他热路径禁止同步文件 API(`readFileSync` / `writeFileSync` / `spawnSync` / 递归 `rmSync` / 逐文件 `copyFileSync` 循环);使用 `fs/promises`,或将工作移出请求路径。
- JSON/JSONL 读写统一走 `storage/file-store.ts`,不直接调 node:fs;路径拼接必须经过 `utils/path-safety.ts` 的 safeJoin 系列。
- 跨模块依赖保持单向:`storage` 不依赖任何兄弟模块;`memory` / `agent` / `channels` / `scheduler` 不得新增对 `server/` 的依赖(存量例外:`memory/l3/indexer.ts` → `server/session-model`,待迁移到 `shared/`);新的跨模块共享逻辑放 `shared/` 或 `utils/`,不放 `server/`。
- 新增 SSE 端点必须带心跳、监听 `res` 的 close 与 error 并在断开时清理订阅和定时器;新增 WebSocket 端点必须在关闭时释放对应资源。
- 修改持久化文件时确认并发安全:同一文件的读-改-写只保留一条写入路径,Web 请求与渠道 dispatcher 不得各自直写同一 sidecar。

## 日志

- 统一使用 `src/logger` 导出的 logger(`debug` / `info` / `warn` / `fatal`),不直接用 `console.log`。
- `debug` 用于高频诊断(流式 chunk、逐条工具事件),生产不落盘;`info` 用于进程与会话生命周期、一次性初始化;`warn` 用于可恢复异常;`fatal` 仅用于进程无法继续的故障。
- 日志不写入凭据、用户内容明文或含用户名的本机绝对路径。
