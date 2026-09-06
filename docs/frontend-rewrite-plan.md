# Inno Agent 前端重构实施方案

> 目标：在 `apps/inno-agent/frontend/` 下，用 **TypeScript(strict) + Next.js 16.3.4（纯静态 SPA，`output: 'export'`，构建产物为静态文件，**不启动 Next server**、无 SSR/rewrites）+ Tailwind CSS v4 + shadcn/ui** 重写产品前端，纯前端、只通过 HTTP 调用后端（`apps/inno-agent/src`，`:3000`，前缀 `/api`）。
>
> **当前状态**：本方案只作书面文档，**未落地任何实现代码**。`apps/inno-agent/frontend/` 目前是 create-next-app 原始脚手架（仅含 `app/`、`public/`、配置文件与 `prototype/` 5 张设计原型图），供后续按本方案执行。

---

## 1. 背景与需求

`apps/inno-agent/web`（旧 Vite + React + Lit 前端）正在被替换。本次在 `apps/inno-agent/frontend` 下重写，视觉唯一来源是 `frontend/prototype/` 下的 5 张原型图，**必须 1:1 还原**，不臆造 UI/色值。

5 张原型对应的界面状态：

| 文件 | 状态 | 关键内容 |
|---|---|---|
| `首页（未登录）.png` | 未登录首页 | 左侧抽屉导航 + 大标题「格格，说出你的教育需求」+ 搜索/命令输入 + 4 张技能卡（备课/学习/评价/科研）+「更多技能→」+ 底部登录 |
| `首页（已登录）.png` | 已登录首页 | 左侧展示工作区/会话列表 + 底部头像「格格」+ 设置；hero 区出现「新工作区」下拉与「默认权限/快速生成」 |
| `首页（已登录）-2.png` | 头像菜单展开 | 头像下拉菜单（账号管理/智能助手/启创官网/关于启创/意见反馈/退出登录） |
| `展开工作区.png` | 工作区三栏聊天 | 左栏收纳为图标栏；中间流式聊天（工具状态指示、可复制代码块、文件卡、下一步建议、右栏 tab）；底部输入 |
| `展开工作区-2.png` | 文档预览 | 点击文件卡/产物项 → 中间预览区（按 kind 渲染）；右栏=工作区产物 |

品牌：**启创 · InnoSpark**；用户示例名「格格」。主色 indigo/violet（~`#6366F1`），映射到 shadcn `--primary`。

---

## 2. 硬性约束（红线）

- **只改 `apps/inno-agent/frontend/`**。不动 `apps/inno-agent/src`（后端）、`apps/inno-agent/web`（旧前端）。
- **绝不 `import` 后端代码**。前端只能通过 HTTP 调后端 `/api/*`（`:3000`）。
- **纯 SPA，无 Next server**：`next.config.ts` 设 `output: 'export'`，`next build` 产出静态文件到 `out/`，用任意静态服务器托管，**从不运行 `next start`**、无 SSR、无 `rewrites`（没有服务端可代理）；`next dev` 只在开发期作为 HMR/构建单元。
- **跨端通信**：浏览器经 `lib/api/config.ts` 解析的 `baseURL` 访问后端——**默认同源**（相对 `/api`，用于 SPA 由后端/宿主同源托管的形态，见 §3.5）；**跨源**（独立静态托管）时 `baseURL = http://127.0.0.1:3000`，需 `NEXT_PUBLIC_BACKEND_URL` 明示。后端 `server.ts` 现未发 CORS 头（`server.ts` 无 `Access-Control-*`），故**跨源**时 dev/托管侧需把 `/api` 代理到 `:3000`（Vite/静态 dev server 代理或托管侧反向代理），**或**由后端托管 `out/` 实现同源；**不要**依赖 Next rewrites。
- **全程客户端渲染**：页面一律客户端组件（加 `'use client'`），`sessionId` 用 `useParams()`/`useSearchParams()`（`next/navigation` 客户端版）读取，**无 `await props.params`、`PageProps`、`LayoutProps`**；Next 16 已移除 `next lint`（用 `npm run lint` = `eslint`）。**编码前先读 `node_modules/next/dist/docs/...version-16.md`，勿依赖训练数据约定（尤其 `output: 'export'` 与客户端导航）。**
- **Electron 打包边界**：`apps/inno-agent/frontend/` 只产出「静态产物 `out/` + 可注入/可解析的 baseURL（§3.5）」；宿主（Electron 壳，**全新搭建，不沿用任何旧打包逻辑**）负责 spawn 后端、注入 `window.__INNO_BACKEND_URL__`、加载静态包。该壳在 `apps/inno-agent/frontend/` 之外，属**单独工作**（见 §3.5）。

---

## 3. 架构

### 3.1 数据通路 / 代理
- **纯 SPA 静态导出**：`next.config.ts` 设 `output: 'export'`。后端地址统一经 `lib/api/config.ts` 单一解析（见 §3.5）：默认**同源空串 `''`**（SPA 由后端/宿主同源托管时即用相对 `/api`，如 Electron 宿主同源加载），显式设 `NEXT_PUBLIC_BACKEND_URL` 才切跨源（独立静态部署 + 远端后端）。`next build` 产出 `out/`，静态托管即可，**不运行 `next start`**。
- **无 Next rewrites**（没有服务端可代理）。浏览器直接请求 `baseURL + '/api'`（同源时即相对 `/api`）。后端当前未发 CORS 头，故跨源场景需有 `/api → :3000` 一层代理（Vite/静态 dev server 代理，或托管侧反向代理），**或**由后端/宿主同源托管 `out/`（此时无需代理）。
- `lib/api/client.ts`：统一 `fetch` 封装（指向 config.ts 解析出的 `baseURL`，JSON、错误处理、query 序列化）。当 `NEXT_PUBLIC_USE_MOCKS === '1'`（默认）路由到 `lib/mock/*`；`=== '0'` 走真实后端（不受 baseURL 影响）。
- 不做 `middleware.ts` / `proxy.ts`（`output: 'export'` 下二者均不生效）。
- **开发期联调路径（mock 默认，切真实 API 需闭环）**：`NEXT_PUBLIC_USE_MOCKS=1`（默认）走 `lib/mock/*`，`next dev` 无后端依赖直接可用。切 `=0` 真实接口时，因无 rewrites 且 `baseURL=''` 会把 `/api` 打到 `next dev` 自身（404），必须二选一：① 设 `NEXT_PUBLIC_BACKEND_URL=http://127.0.0.1:3000`（跨源）＋后端 CORS（后端 `server.ts` 现无 CORS 头）；② **（推荐，零后端改动）** 用带 `/api → :3000` 代理的静态 dev server 托管 `out/`，作为 frontend 内 dev 脚本。

### 3.2 目录结构
```
apps/inno-agent/frontend/
  app/
    layout.tsx                     # 字体、ThemeProvider、globals、中文兜底
    page.tsx                       # Home：客户端渲染 <HomeApp/>
    workspace/page.tsx              # 工作区三栏（客户端，`useSearchParams()` 读 `?session=` → <WorkspaceApp/>）
    globals.css                    # Tailwind v4 `@import "tailwindcss";` + `@theme` 品牌 token
  components/
    ui/                            # shadcn 生成组件
    layout/  sidebar.tsx  topbar.tsx
    home/    hero.tsx  skill-card.tsx  new-workspace-menu.tsx  home-app.tsx
    workspace/ chat-view.tsx  message.tsx  tool-status.tsx  code-block.tsx
               file-card.tsx  markdown.tsx  artifacts-panel.tsx  chat-records.tsx
               right-panel.tsx  composer.tsx  doc-preview.tsx  workspace-app.tsx
  lib/
    api/   client.ts  config.ts  chat.ts  sessions.ts  workspaces.ts  workspace.ts
           settings.ts  learner.ts  skills.ts  presets.ts  types.ts   # DTO 对齐 docs/backend-api.md
    mock/  data.ts  handlers.ts
    store/ auth-store.ts  settings-store.ts  sessions-store.ts  workspace-store.ts  chat-store.ts
    hooks/ use-chat-stream.ts  use-sse-reconnect.ts
    utils.ts                  # cn()
  next.config.ts
  package.json
```

### 3.3 主题 / 设计 token
- `globals.css` 用 `@theme` 把品牌色 `--primary` 映射为 indigo 系 `#6366F1`；浅灰白背景；`rounded-xl` 卡片、轻边框、柔和阴影；登录区底部浅紫渐变。
- Geist 字体已配，补中文字体 fallback。
- 视觉唯一来源是原型图，不臆造色值。

### 3.4 状态管理（zustand）
- `auth-store`：登录态（纯前端 localStorage 持久化，后端无鉴权）。
- `settings-store`：defaultProvider/defaultModel/theme。
- `sessions-store`：sessions/workspaces/activeSessionId；`createSession` 只发一次。
- `workspace-store`：workspaceId/name/path/tree/selectedPath。
- `chat-store`：当前轮瞬态（streamingText/streamingThinking/activeTools/completedTools/pendingQuestion/streamingError），`applyEvent` 为 SSE 归约器。

---

### 3.5 后端 URL 配置 + Electron 打包

**后端 URL 可配置（唯一解析入口 `lib/api/config.ts`）**
- 解析优先级：`window.__INNO_BACKEND_URL__`（运行时注入，Electron 主进程经 preload 写入，或宿主页面设） → `process.env.NEXT_PUBLIC_BACKEND_URL`（构建期 env） → **同源空串 `''`**。
- `baseURL === ''` 表示**同源**（请求走相对 `/api`）：即默认形态，由后端自身托管 SPA（Electron 打包后、或生产同源反向代理）时用，**无 CORS 问题**。
- `baseURL` 为绝对地址时走**跨源**（独立静态托管 + 远端/本地后端），此时才需要后端 CORS 或 `/api` 代理。
- `client.ts` 统一拼接 `baseURL + '/api/...'`，因此「同源/跨源」两种形态**切换零代码改动**，只改解析优先级的一端即可。`config.ts` 保持单纯：只解析 base URL，不承担状态/缓存等其它职责。

**与后端打包成 Electron 客户端 app（宿主全新搭建，不沿用旧打包逻辑）**

- **职责契约**：单独一个 Electron 宿主壳（新目录，如 `electron/`，与旧打包逻辑无关）。主进程负责四件事——① spawn 后端（`apps/inno-agent` 的 `dist/server.js`，Node 20+ 内嵌）；② 解析**后端 base URL**；③ 经 preload `contextBridge` 注入 `window.__INNO_BACKEND_URL__`；④ 加载前端静态产物并 `createWindow`。
- **base URL = 唯一交接点（可配置的关键）**：主进程用**动态端口**启动后端（不写死 3000，选一个可用端口），得到 `http://127.0.0.1:<port>`，注入 renderer。前端 §3.5 的解析链**优先读 `window.__INNO_BACKEND_URL__`**，故前端与宿主**零耦合**——要换成远端/自托管后端，只改注入值或设 `NEXT_PUBLIC_BACKEND_URL` 即可，前端代码不动。
- **加载前端的方式（二选一）**：
  - **同源**：后端同时托管前端静态产物 `out/`，窗口加载 `http://127.0.0.1:<port>`，无 CORS，最简单（推荐默认）。
  - **直接载入静态包**：窗口加载包内 `out/index.html`（`file://` 或自定义 `app://` 协议），需在后端/协议侧放行 CORS 以访问 `http://127.0.0.1:<port>` 的 `/api`。
  无论哪种，前端都只认注入的 baseURL，宿主怎么挂载它对前端透明。
- **打包**：`electron-builder` 一并纳入 后端 `dist/` + 生产 `node_modules` + 前端 `out/` + `electron/main` + `preload`；`main` 先启后端（等待就绪，可轮询 `/health` 或直接读 base URL）再 `createWindow`。
- **改动边界**：宿主壳属独立工作，不在 `apps/inno-agent/frontend/` 内。本方案只要求前端做到「静态产物 `out/` + baseURL 可注入/可解析」即无缝接入；前端 `settings-store` 等不感知宿主。

---

## 4. 关键流程 ↔ 接口（含 mock 对应）

### 4.1 首页·未登录
左侧抽屉导航 + 大标题 + 搜索/命令输入 + 4 张静态品牌技能卡 +「更多技能→」+ 底部登录。「登录」按钮 → `auth.login()` 设置 `{ name: '格格' }`。

### 4.2 首页·已登录
- 底部头像「格格」+ 设置；左侧「工作区」展示会话列表（`GET /api/sessions`、`GET /api/workspaces`）。
- 欢迎态「新工作区」下拉（已有工作区 / 新建工作区 / 临时工作区）——**仅为草稿态**，真正的会话在**首次发送**时创建：先 `POST /api/workspace/upload` 上传本地附件，再 `POST /api/sessions`（`{newWorkspace:{name,isTemp}}` 或 `{workspaceId}`），成功后清空输入、刷新 `GET /api/workspaces`+`GET /api/sessions`、跳转 `/workspace?session=<id>`；409 `session_busy` 时提示「中断堵塞轮并重试」。
- 输入区加「默认权限」select +「快速生成」；头像菜单（账号管理/智能助手/启创官网/关于启创/意见反馈/退出登录，官网为外链，其余占位）。

### 4.3 工作区 `/workspace?session=<id>`（三栏核心）
- **挂载**：`GET /api/sessions/:id`（消息）、`GET /api/workspace/tree?workspaceId=<id>`（workspace meta·name/root + 产物文件树，一次拿全；`workspaceId` 新建时取 `POST /api/sessions` 响应，**重开已有会话**时按 sessionId 在 `GET /api/workspaces` 各项的 `sessionIds` 反查所在工作区）、`GET /api/chat/status/:sessionId`（若 queued/running 则续流）。
- **发送**：`use-chat-stream` → `POST /api/chat/stream`（SSE，请求体 `{ prompt, sessionId, clientRequestId, images?, attachments? }`）。SSE 帧为信封 `{ eventId, sessionId, turnId, clientRequestId, traceId?, occurredAt?, event }`；`event` 是判别联合，含 `stream_state`、`text_start|delta|end`、`thinking_start|delta|end`、`tool_call_start|delta|end`、`tool_start`、`tool_update`、`tool_end`、`workspace_change`、`question`、`question_resolved`、`done`、`error`、`aborted`，以及 trace-only `skill_loaded`/`skill_invoked`/`system_event`。
- **渲染**：流式文本/思考按 `delta` 增量合并（~40ms 合并 flush）；`tool_*` → 工具状态行（摘要 `toolName · target · 部分末行`，状态 chip 准备调用/执行中/等待你的回答/失败/已完成）；`workspace_change` → 打开改动文件；`question` → 问答卡片；`done` → `GET /api/sessions/:id` 拉取持久化历史替换瞬态轮，`error/aborted` → 终态。
- **重连**：`openSession` 时若 `stream.status ∈ {queued,running}`，`resumeStream` 开 `GET /api/chat/events/:sessionId?turnId=<turn>&after=<lastAppliedEventId>`（`turnId`、`after` **均必填**，`after` 为非负整数）；`reconnectOwner` 用退避 250/500/1000/2000ms 轮询 `GET /api/chat/status/:sessionId` 直到 `clientRequestId` 匹配再重放。`cancel` → `POST /api/chat/:sessionId/:turnId/abort`。
- **中间消息区**：工具状态指示、代码块（复制/下载/折叠/全屏/运行）、文件卡（预览/下载）、「下一步建议」链接。
- **右栏 tabs**（按原型，非旧 web 的 tabs）：**聊天记录**（会话附件文件卡：`ChatAttachments.bindings`→关键词气泡、`loose`→文件 chip；来源 tag 工作区/本地）与**工作区产物**（工作区文件树列表，目录 `GET /api/workspace/tree?workspaceId=<id>`）。
- **文件卡预览**（按 kind 调度，机制参照旧 web）：Markdown 渲染；html 沙箱 `srcDoc`；pdf `iframe src=<file.url>#view=FitH`；image `<img src=<file.url>>`；docx `docx-preview`、xlsx `XlsxPreview`（客户端）；pptx `GET /api/workspace/pptx-preview`→`{name,slideCount,slides:[{index,svg}],canvasPx}`；office 文本 `GET /api/workspace/office-preview`→`{name,pageCount,text,pages}`；text/csv 只读 CodeMirror。下载→`GET /api/workspace/raw?download=1`；整目录→`GET /api/workspace/download-folder`。数据源 `GET /api/workspace/file?path&workspaceId`→`WorkspaceFileDetail{path,name,kind,format?,mimeType,size,updatedAt,content?,url?,previewUrl?}`。
- **Markdown/代码块**：`react-markdown` + `rehype` + **Shiki** 高亮 + KaTeX；流式模式（未闭合 markdown 修复 + 淡入）。代码块工具条：复制 / 下载(`downloadBlob`→`inno-code.<ext>`)/ 折叠(默认 ~350px)/ 全屏 / run(把源码送终端)。
- **底部**：「继续对话」输入 + 新工作区/默认权限/快速生成。

### 4.4 文档预览（展开工作区-2）
点击文件卡/产物项 → 中间预览区（kind 调度同上）；右栏=**工作区产物**；右下角「《小石潭记》备课工作区 共 18.6 MB」（**递归累加 `workspace/tree` 各节点 `children[].size`**——根节点 `size` 只是目录元数据，非累计值）。

---

## 5. 实施顺序

1. **脚手架与基建**：`npx shadcn@latest init`（`-b radix` + preset）+ 添加组件（button/input/dropdown-menu/popover/select/tabs/dialog/avatar/tooltip/separator/scroll-area/card/badge/skeleton）。`lib/utils`(cn)、`globals.css` 主题 token、`next.config.ts`（`output: 'export'`）、`lib/api/config.ts`（baseURL 解析，见 §3.5）、`package.json` scripts、`.env.local`（含 `NEXT_PUBLIC_BACKEND_URL` 与 dev/托管侧 `/api → :3000` 代理）。建 `lib/api/types.ts` + `client.ts` + 领域模块 + mock 层（fixtures 对齐 DTO）。
2. **首页·未登录**：sidebar + hero + 技能卡 + 登录按钮。
3. **首页·已登录**：会话列表、新工作区下拉、默认权限/快速生成、头像菜单。
4. **工作区三栏**：topbar、左栏收纳为图标栏、流式聊天（use-chat-stream）、工具状态、代码块、文件卡、下一步建议、右栏 tabs、底部输入。
5. **文档预览**：中间预览区 + 右栏工作区产物 + 右下角 workspace 大小。
6. **打磨与验证**：build/lint、markdown/KaTeX/代码高亮、响应式、主题。
7. **Electron 适配**（前端侧）：产出 `out/`，按 §3.5 验证 baseURL 注入链——宿主注入 `window.__INNO_BACKEND_URL__` 或设 `NEXT_PUBLIC_BACKEND_URL`，`client.ts` 沿解析链取到正确后端；前端只需保证「静态产物 + baseURL 可解析」，宿主壳单独搭。

---

## 6. 验证

- `npm run build` 通过（`output: 'export'` 静态导出 + typecheck）；`npm run lint` 通过（Next 16 无 `next lint`）；静态托管 `out/`（无需 `next start`）。
- 本地开发默认 mock（`NEXT_PUBLIC_USE_MOCKS=1`）→ 逐张对照 `prototype/*.png` 验证 5 个状态。
- 后端跑起来（repo 根 `npm run server` :3000）后 `NEXT_PUBLIC_USE_MOCKS=0`，按 §2「跨端通信」/§3.1 联调路径二选一（后端 CORS 跨源，或前端静态 dev server `/api → :3000` 代理），验证真实接口：建会话、流式聊天、文件树/预览。
- SSE 重连：流式进行中跳走再回 `/workspace?session=<id>`，确认 `chat/status` + `chat/events` 恢复。
- Electron（宿主壳单独搭，非旧打包逻辑）：`main` 启动后端于动态端口 → 注入 `window.__INNO_BACKEND_URL__` → 加载 `out/`；前端同源（相对 `/api`）或自定义协议（注入的 baseURL）均打到后端；打包产物含 后端 `dist/` + 生产 `node_modules` + 前端 `out/`。

---

## 7. 风险 / 注意

- 客户端 SSE 需用 `fetch` + `ReadableStream` 解析、正确处理 `done`/`[DONE]`；复用旧 web 行为而非代码。
- mock fixtures 字段形状必须与 `docs/backend-api.md` 的 DTO（`SessionSummary`、`SessionMessageSummary`、`WorkspaceTreeNode`、`ChatAttachments`、`ToolCall` 等）一致，保证切真实 API 无缝。
- 后端无 CORS 头 + 无 Next 代理 → 必须保证 `/api` 在 dev/托管侧有一层代理或同源托管，否则浏览器直连会被跨域拦截（应在切真实 API 前先解决）。
- 所有改动仅在 `apps/inno-agent/frontend/`，不碰 `src` 与 `web`。

---

## 附录：与旧前端的行为差异（仅供实现参照，不抄代码）

- 旧 `web` 无任何鉴权/用户/头像，「登录→格格」是原型**新增的纯前端 UI 特性**（后端无对应接口），本地 localStorage 持久化。
- `POST /api/sessions` 在**首次发送**时创建会话（新工作区/临时/已有只是草稿态），完整顺序：`POST /api/workspace/upload` 上传本地附件 → `POST /api/sessions` 创建会话并返回 `workspaceId` → 跳转 `/workspace?session=<id>` → `POST /api/chat/stream`（以 §4.2 为准）。`POST /api/workspaces`（`{name,isTemp}`）用于**新建工作区**，切换/绑定工作区在 `POST /api/sessions` 的 `{workspaceId}` / `{newWorkspace}`；`POST /api/sessions/:id/activate` 仅用于打开已有会话。
- 原型右栏「聊天记录 / 工作区产物」tabs 是原型**新要求**（旧 web tabs 为 工作区/笔记本/画像/技能/定时任务）；布局以原型为准，渲染机制复用旧 web 的按 kind 预览。
