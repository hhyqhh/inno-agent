# Inno Agent 前端 — 使用与测试文档

> 适用目录：`apps/inno-agent/frontend/`（本站是产品前端的一次重写，纯静态 SPA）。
> 视觉基准：`prototype/*.png`（5 张原型图，需 1:1 对齐）。后端契约：`docs/backend-api.md`。

---

## 1. 这个前端是什么

一个 **Next.js 16 + TypeScript(strict) + Tailwind v4 + shadcn/ui** 的纯静态单页应用：

- `output: 'export'` → `npm run build` 只生成静态文件到 `out/`，**永远不 `next start`**、没有 SSR。
- 所有页面都是客户端组件（`'use client'`）。
- 默认跑在 **mock 模式**（`NEXT_PUBLIC_USE_MOCKS=1`），不依赖后端即可完整演示。
- 品牌：**启创 · InnoSpark**，主色 indigo `#6366F1`（映射到 shadcn `--primary`）。

页面与原型对应关系：

| 路由 | 原型 | 说明 |
|---|---|---|
| `/` | `首页（未登录）.png` / `首页（已登录）.png` / `首页（已登录）-2.png` | 未登录 = 侧栏 + 登录条 + hero 搜索 + 技能卡片；已登录 = 侧栏会话列表 + 默认权限 + 快速生成 + 头像菜单 |
| `/workspace` | `展开工作区.png` / `展开工作区-2.png` | 三栏：聊天 + 文档预览（可选）+ 产物/聊天记录面板 |

> **与 monorepo 的关系**：`frontend/` 是一个**独立 npm 包**（自带 `node_modules` 与嵌套 `.git`，由 create-next-app 初始化）。它**没有**注册进仓库根 `package.json` 的 `workspaces`——所以 **repo 根的 `npm run build`、`npm --workspace …`、Electron/打包脚本都不包含它**；本站自管依赖与构建，须在 `apps/inno-agent/frontend/` 内单独执行 `npm install` + `npm run …`。仓库根涉及 `apps/inno-agent/web`（`inno-agent-web`）的命令属于**旧前端**，与本站无关。按计划 §3.5，本站只交付「静态产物 `out/` + 可注入的 baseURL」，Electron 宿主壳另行搭建。

---

## 2. 快速开始

### 前置条件

- Node.js >= 20.9（当前项目用 20/22+），npm。
- 无需后端即可跑 mock 模式。

### 安装与启动（mock 模式，推荐）

```bash
cd apps/inno-agent/frontend
npm install
npm run dev            # Next dev，默认 http://localhost:3000（被占用会自动顺延），全部走 lib/mock/*
```

Mock 模式下后端接口由 `lib/mock/*` 提供（含 SSE 流式、文件树、Office/PPT 预览、会话列表），**不用起后端**，刷新页面即可看到与原型一致的界面。

---

## 3. 运行方式一览

| 目的 | 命令 | 端口 | 说明 |
|---|---|---|---|
| 开发（mock） | `npm run dev` | 3000 | Next dev，走 `lib/mock/*` |
| 类型检查 | `npm run typecheck` | — | `tsc --noEmit` |
| 静态构建 | `npm run build` | — | Turbopack + 类型检查，产出 `out/` |
| 预览静态构建 | `npm run serve:static`（或 `npm start`） | 4173 | 托管 `out/`，并把 `/api`、`/health` 代理到后端 |
| 代码检查 | `npm run lint` / `npm run lint:fix` | — | eslint |

### 预览静态构建（含 /api 代理）

`serve.mjs` 是一个零依赖 Node 静态服务器（Node >= 20 内置模块），作用和计划 §3.1 的“选项②”一致：托管 `out/`，同时把 `/api`、`/health` 代理到真实后端 `:3000`，从而**无需后端加 CORS** 也能从静态宿主打到真实接口。

代理**会逐块流式透传响应体**（不做整体缓冲），因此 `/chat/stream` 等 SSE 接口经此代理照样能收到**增量逐字输出**，而不会等整轮结束才一次性吐出。

```bash
npm run build
npm run serve:static        # http://127.0.0.1:4173
# 后端地址可用环境变量覆盖：
BACKEND_URL=http://127.0.0.1:3000 npm run serve:static
```

> 注意：这次“构建 + 静态托管”是命中真实接口的同源路径。`serve.mjs` 默认把 `/api` 代理到 `http://127.0.0.1:3000`（见 `BACKEND_URL`）。**后端必须先启动**，否则 `/api` 请求会失败（前端页面仍可加载）。

---

## 4. Mock 模式 ↔ 真实后端

由 `lib/api/config.ts` 统一决断。两个开关：

| 开关 | 取值 | 效果 |
|---|---|---|
| `NEXT_PUBLIC_USE_MOCKS` | `1`（默认） | 所有 API 调用走 `lib/mock/*`（含 SSE） |
| `NEXT_PUBLIC_USE_MOCKS` | `0` | 走真实后端，按 `NEXT_PUBLIC_BACKEND_URL` 解析 |

后端地址优先级（`lib/api/config.ts`）：

1. `window.__INNO_BACKEND_URL__` — 运行时注入（Electron 预加载）
2. `NEXT_PUBLIC_BACKEND_URL` — 构建时环境变量（独立静态托管）
3. `""` — 同源（后端或宿主机自己托管 `out/`，或 `serve.mjs` 代理）

```bash
# 在 .env.local 里切到真实后端：
NEXT_PUBLIC_USE_MOCKS=0
# 同源/代理（serve.mjs）时留空；跨域托管时填绝对地址：
# NEXT_PUBLIC_BACKEND_URL=http://127.0.0.1:3000
```

### 开发时用真实后端

- 后端在 `:3000`（`npm run server -- --home ./runtime --workspace ./workspace --port 3000`）。
- 由于 `next dev` 默认也占 3000，二者会冲突。建议改端口，例如 `npm run dev -- -p 5173`，并给独立静态托管或让后端 CORS 放行（计划明确“不依赖后端 CORS”，因此更推荐 `build + serve:static` 的代理路径）。

---

## 5. 功能点速览

### 首页 `/`

- **未登录**：左侧栏（Logo、新建任务、工作台：知识库/技能仓库/学习者画像；底部“登录后使用完整功能 + 登录”）。
- **Hero**：`格格，说出你的教育需求` + 圆形搜索框（+ 附件 / 发送）；下方 `新工作区`。
- **技能卡片**：备课 / 学习 / 评价 / 科研；右上方 `更多技能 ›`。
- **已登录**：新增 `默认权限`（自动/只读/读写）+ `快速生成`；侧栏出现 `工作区` 会话列表（点击跳转 `/workspace`）；底部头像菜单（账号管理/智能助手/启创官网/关于启创/意见反馈/退出登录）。

### 工作区 `/workspace`

- **顶栏**：会话标题 + 工作区 pill；右侧面板折叠按钮。
- **聊天列**：用户气泡（右对齐、靛蓝）、助手消息（头像 + 工具状态头部 + 工具行 + Markdown + 代码块 + 附件卡片 + 下一步建议）。
  - 工具行展示 `已浏览 121个搜索结果…` / `已运行 git status -short` 等，可点头部折叠。
  - 代码块：语言标签 + `复制` / `下载`（shiki 高亮）。
  - 附件卡片：`预览` / `下载`。
  - 流式出错或被后端中止时，聊天列显示**错误横幅**或`已停止生成`，并清除残余的流式文本。
- **底部 composer**：`继续对话，例如：把这节课延伸成群文阅读` + 发送；下方 `新工作区` / `默认权限` / `快速生成`。
- **右侧面板**：`聊天记录` ↔ `工作区产物` 切换；产物列出工作区文件（点击 → 打开文档预览列）。页脚显示 `工作区名 · 共 N MB`。

### 文档预览列

选中工作区文件（右侧产物或消息内的文件卡片）后在聊天与右侧面板之间展开：

- Word/Excel → 分页文本（`/workspace/office-preview`）
- PPT → 幻灯片 SVG（`/workspace/pptx-preview`）
- 图片 / PDF / HTML → 原始字节 iframe/img
- Markdown / 文本 / 代码 → 渲染内容

点右上 `×` 关闭预览，返回全宽聊天。

---

## 6. 手动测试清单

按下列步骤走一遍，核对预期结果（默认 mock 模式，无需后端）。

### A. 首页（未登录）

1. 打开 `http://localhost:3000/`。
   - [ ] 标题为 `格格，说出你的教育需求`，下方有圆形搜索框。
   - [ ] 左侧栏显示 Logo、`新建任务`、工作台三项、底部 `登录后使用完整功能 + 登录`。
   - [ ] 底部有备课/学习/评价/科研四张卡片，右侧 `更多技能 ›`。
2. 在搜索框随意输入，回车。
   - [ ] 跳转到 `/workspace?session=…`，进入三栏工作区（见 C）。

### B. 登录

1. 点击左下 `登录`。
   - [ ] 侧栏出现 `工作区` 会话列表（临时任务/我是8年级地理教师…等），底部变为头像菜单（`格` + 昵称）。
   - [ ] Hero 下出现 `默认权限`、右侧出现 `快速生成`。
2. 点击底部头像 → 下拉菜单。
   - [ ] 出现 账号管理/智能助手/启创官网/关于启创/意见反馈 及红色 `退出登录`。点 `退出登录` 回到未登录态。
3. 点击 `新工作区`。
   - [ ] 下拉出现 `已有工作区 >` / `新建工作区` / `临时工作区（用完即弃）`。
   - [ ] `已有工作区` 子菜单列出已登录会话。

### C. 工作区（三栏聊天）

1. 从首页发送任意提示（或点侧栏某会话），进入 `/workspace`。
   - [ ] 顶栏显示会话名 + `《小石潭记》备课` pill。
   - [ ] 聊天列默认展示 mock 会话历史：两个用户气泡、两个助手消息。
   - [ ] 第一条助手消息带 `已运行 2m15s` 头部与工具行（已浏览/已运行），可点击折叠。
   - [ ] 代码块带 `python` 标签与 `复制` / `下载`；点复制后提示“已复制”。
   - [ ] 底部是 composer + `新工作区` / `默认权限` / `快速生成`。
2. 右侧显示 `工作区产物`，列 N 个文件；切换 `聊天记录` 可见会话转写。
3. 点击右侧某个 docx 文件。
   - [ ] 中间展开 `文档预览` 列，显示《八年级地理…》分页内容；点 `×` 关闭。

### D. 流式对话（mock SSE）

1. 在 composer 输入内容并回车。
   - [ ] 顶部立即出现你的用户气泡（右对齐）。
   - [ ] 助手气泡出现“正在运行/排队中…”，随后工具状态逐条出现（已浏览/已运行），正文逐字打印。
   - [ ] 结束后调用 `refreshMessages` 拉取持久化消息，瞬态气泡沉淀为正式消息。
2. 若点右上 `收起右侧面板`。
   - [ ] 右侧面板（含文档预览列）折叠，聊天列占满。
3. 若再次发送，会话持续累积。

> **错误/中止（仅真实后端）**：当后端下发 `error` / `aborted` 信封时，聊天列显示错误横幅或`已停止生成`，瞬态流式内容清除；mock 模式不产出错误，正常走到 `done`。

### E. 构建与静态托管

```bash
npm run typecheck   # 应无输出（通过）
npm run lint        # 应无输出（0 errors, 0 warnings）
npm run build       # 输出 /  /_not-found  /workspace 三个静态路由
npm run serve:static
```

- [ ] 打开 `http://127.0.0.1:4173/` 与 `/workspace/` 均 200。
- [ ] 若后端在 `:3000` 且令 `NEXT_PUBLIC_USE_MOCKS=0` 重新构建，则 `/api/*` 通过代理命中真实后端。
- [ ] `Next.js ignored package.json … outside current Git repository` 的告警已通过 `next.config.ts` 的 `turbopack.root` 消除（构建不应再出现）。

---

## 7. 数据流与关键实现（便于排查或二次开发）

- **DTO 契约**：`lib/api/types.ts` 对齐 `docs/backend-api.md`。UI 从不 `import` 后端代码。
- **客户端**：`lib/api/client.ts`（`apiFetch`/`apiGet/Post/Patch/Put/Delete`，统一 `ApiError`）；`lib/api/config.ts`（地址/mock 开关）；`lib/api/chat.ts`、`workspace.ts`、`sessions.ts` 等域名模块。
- **SSE**：`lib/api/sse.ts` 的 `normalizeFrame` 兼容 `{ seq, event }` 与富重连包 `{ eventId, sessionId, turnId, clientRequestId, occurredAt, event }`。聊天流用 `openStream`，重连用 `openRawStream`。
- **状态**：Zustand。`chat-store` 是个 SSE case-reducer（`applyEvent`）；`workspace-store` 管当前会话/树/文件选择；`sessions-store` 管会话与工作区；`ui-store` 管左右侧栏折叠。
- **流式 turn**：`lib/hooks/use-chat-stream.ts` 迭代 `streamChat` → `applyEvent` → 结束后 `refreshMessages` + `resetTurn`；`lib/hooks/use-sse-reconnect.ts` 断线重连（`/chat/status` + `/chat/events`）。
- **Mock**：`lib/mock/handlers.ts` 路由 mock 接口；`lib/api/client.ts` 在 `NEXT_PUBLIC_USE_MOCKS !== '0'` 时转 `mockHandle`；`stream.ts` 产出假 SSE。`createSession` 会把新会话登记进 `MOCK_SESSIONS`，使侧栏/顶栏一致。

---

## 8. 常见问题

**Q：`next dev` 用真实后端时端口冲突？**
- `next dev` 默认 3000 与后端占用相同。请用 `npm run dev -- -p 5173`，并以 `build + serve:static`（代理）或后端 CORS 的方式访问 `/api`。

**Q：`serve:static` 页面能开，但 `/api` 报错？**
- 后端未启动，或 `BACKEND_URL` 与实际后端地址不符。先启动后端 `:3000`，或用 `BACKEND_URL=… npm run serve:static` 覆盖。

**Q：如何重新用真实后端？**
- `.env.local` 里 `NEXT_PUBLIC_USE_MOCKS=0`，且按要求设置 `NEXT_PUBLIC_BACKEND_URL`（同源/代理留空）。改动后需重新 `npm run dev` 或 `npm run build`。

**Q：改了 `lib/api/*` 或 DTO？**
- 同步修改对齐 `docs/backend-api.md`，并运行 `npm run typecheck && npm run lint`。

**Q：为什么构建时出现过 Turbopack root 告警？**
- 前端是独立 npm 包（自带嵌套 `.git/`）。`next.config.ts` 已设置 `turbopack.root: process.cwd()` 指向前端目录，避免 Next 回退到 monorepo 根而忽略本包 `package.json`。

---

## 9. 环境变量参考（前端）

| 变量 | 默认 | 说明 |
|---|---|---|
| `NEXT_PUBLIC_USE_MOCKS` | `1` | `1` 走 mock；`0` 走真实后端 |
| `NEXT_PUBLIC_BACKEND_URL` | 空（同源） | 跨域静态托管时的后端绝对地址 |
| `PORT`（serve.mjs） | `4173` | 静态服务器端口 |
| `BACKEND_URL`（serve.mjs） | `http://127.0.0.1:3000` | `/api`、`/health` 代理目标后端 |
