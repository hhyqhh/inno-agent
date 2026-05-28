**整体方向**

基于当前代码，我建议把 UI 做成 `inno-agent` 的独立 Web 前端包，但复用 `pi/packages/web-ui` 的组件能力，尤其是 `AgentInterface`、`MessageList`、附件、工具渲染、Artifact 预览和设置组件。当前后端已有 `/api/chat` 与 `/api/jobs`，L2 Wiki 模块也已存在，所以前端第一版应围绕“单用户个人学习工作台”设计，而不是另起一个通用 ChatGPT 壳子。

参考代码位置：
[Pi Web UI SDK](/Users/haohao/local%20path/project/PI-agent-learn/pi/packages/web-ui/src/index.ts)、[Inno Server](/Users/haohao/local%20path/project/PI-agent-learn/inno-agent/src/server.ts)、[L2 Wiki 工具](/Users/haohao/local%20path/project/PI-agent-learn/inno-agent/src/memory/l2/l2-tools.ts)。

**推荐布局**

主界面采用固定三栏：

```text
┌──────────────┬──────────────────────────────┬──────────────────────────────┐
│ Session / Nav │ Chat                         │ Workspace                    │
│              │                              │                              │
│ 会话列表      │ Pi 对话流                      │ 文件 / Artifact / Wiki / Graph │
│ Wiki入口      │ 输入框 / 附件 / 工具状态          │ 预览、编辑、知识图谱、设置        │
│ Jobs入口      │                              │                              │
│ Settings入口  │                              │                              │
└──────────────┴──────────────────────────────┴──────────────────────────────┘
```

左栏是“管理区”，中间是“交互区”，右栏是“工作区”。右栏不是单一预览器，而是带 tabs 的 Workspace：

- `Preview`：显示 workspace 下的 HTML、Markdown、PDF、图片、文本、Pi artifacts。
- `Wiki`：Wiki 页面树、Markdown 预览、编辑器、frontmatter 信息。
- `Graph`：Wiki 双链和知识关系图谱。
- `Jobs`：定时任务面板。
- `Settings`：核心配置、模型、渠道、记忆、数据保留策略。

**Pi UI SDK 使用方式**

不建议直接使用完整 `ChatPanel` 作为主界面，因为 `ChatPanel` 内部已经把聊天和 Artifacts 做成二栏布局，会和你的“三栏结构”冲突。更合适的是：

- 中间栏使用 `AgentInterface` 或拆分后的 `MessageList` + `MessageEditor`。
- 右栏复用 `ArtifactsPanel`、`MarkdownArtifact`、`HtmlArtifact`、`SandboxIframe` 等预览能力。
- 设置弹窗可以复用 `SettingsDialog`、`ProviderKeysStore`、`SessionsStore` 里的模式，但数据源要逐步接回 Inno Agent 后端。
- 附件能力复用 SDK 的 `loadAttachment`、附件 tile、文档抽取工具。

也就是说：用 Pi UI SDK 做“聊天基础设施和渲染能力”，Inno Agent 自己负责“三栏工作台、Wiki、Graph、Jobs、Settings”。

**前后端关系**

当前后端是 Node HTTP server，建议扩展成 Web API 层：

```text
GET  /api/sessions
GET  /api/sessions/:id
POST /api/sessions
POST /api/chat/stream
GET  /api/workspace/tree
GET  /api/workspace/file?path=
PUT  /api/workspace/file
GET  /api/wiki/pages
GET  /api/wiki/page?path=
PUT  /api/wiki/page
GET  /api/wiki/graph
POST /api/wiki/archive
GET  /api/jobs
POST /api/jobs
PATCH /api/jobs/:id
DELETE /api/jobs/:id
GET  /api/settings
PATCH /api/settings
```

现在的 `/api/chat` 是完整返回，UI 体验会偏硬。建议新增 `/api/chat/stream`，用 SSE 或 fetch stream 把 Pi session 的事件推给前端，这样中间栏可以显示流式输出、工具调用、任务状态。

**核心页面模块**

1. `AppShell`
负责三栏布局、响应式折叠、全局命令、当前 session/workspace 状态。

2. `SessionSidebar`
显示会话列表、搜索、新建会话、归档、重命名。当前项目是单用户，但 UI 上仍然可以管理多条 session 历史。

3. `ChatCenter`
基于 Pi UI SDK 的聊天组件。支持文本、附件、图片、PDF、工具调用状态、停止生成、重试、保存到 Wiki。

4. `WorkspacePanel`
右栏总容器，用 tabs 承载 Preview/Wiki/Graph/Jobs/Settings。Chat 生成 artifact 或用户点文件时，自动切到对应 tab。

5. `RichPreview`
统一预览 HTML、MD、PDF、图片、纯文本。HTML 用 sandbox iframe，Markdown 用 SDK markdown/artifact 渲染，PDF 用 SDK 已依赖的 `pdfjs-dist`。

6. `WikiWorkbench`
左侧 Wiki 页面树，中间 Markdown 预览/编辑切换，顶部展示 title/type/tags/status/confidence。保存时调用 `/api/wiki/page`。

7. `KnowledgeGraph`
第一版用 Wiki 双链生成节点和边：page、tag、source、concept/entity。后续再接 graphify 或原生 `graph.json`。

8. `JobsPanel`
复用当前 `JobStore` 的 `/api/jobs`。支持启停、立即运行、查看 lastRun/nextRun、失败原因、任务类型筛选。

9. `SettingsPanel`
覆盖模型、Pi provider、Feishu 渠道、记忆开关、长期记忆保留天数、workspace 路径、定时任务默认策略。

**数据状态设计**

前端建议用轻量 store，不必一开始引入复杂状态库：

```text
appState:
  currentSessionId
  selectedWorkspaceFile
  selectedWikiPage
  rightPanelTab
  chatStreamingState

stores:
  sessionsStore
  workspaceStore
  wikiStore
  jobsStore
  settingsStore
```

Pi Web UI SDK 里的 IndexedDB session 存储适合纯浏览器 demo；本项目更应该以后端文件为准，因为 CLI、飞书、定时任务、Web UI 都要共享同一套 Inno Agent 状态。

**实施阶段**

第一阶段：先搭三栏壳子  
实现 `web/` 前端、左 session mock/基础列表、中间接 `/api/chat`、右边能预览 Markdown/HTML/PDF 文件。

第二阶段：接真实 session 和 streaming  
新增 `/api/chat/stream`，把 Pi 事件映射到前端消息流；左栏接真实 session metadata。

第三阶段：Wiki 工作台  
接 `data/l2/wiki`，实现页面列表、预览、编辑、保存、归档入口。

第四阶段：Graph 和 Jobs  
从 Wiki 双链生成图谱；接现有 `/api/jobs` 完成定时任务管理。

第五阶段：设置和记忆治理  
配置模型、渠道、L1/L2 开关、隐私、数据保留、画像修正。

我的建议是：第一版不要追求“大而全设置中心”，先把三栏工作台的空间关系做准。只要 Chat、Workspace Preview、Wiki Preview/Edit 三件事顺滑，这个产品的骨架就立住了。

**Codex 风格视觉规范**

2026-05-23 的静态 demo 已确认采用“参考 Codex 自身设计风格”的版本。目标不是做营销页或科技大屏，而是做一个能长时间停留的工程工作台：安静、清楚、分区明确、低噪声。

设计参考文件：
[design-color-demo.html](/Users/haohao/local%20path/project/inno-agent-project/apps/inno-agent/web/design-color-demo.html)

三栏必须有清晰的颜色和语义分区：

```text
┌─────────────────────┬──────────────────────────────┬──────────────────────────────┐
│ Sidebar             │ Chat                         │ Workspace                    │
│ Codex-like nav      │ Clean white conversation      │ Browser-like work surface    │
│ #eceff3 / #dde2e8   │ #ffffff                      │ #f8fafc / #f1f5f9 chrome     │
└─────────────────────┴──────────────────────────────┴──────────────────────────────┘
```

左栏 `Sidebar`：

- 背景使用 `#eceff3`，选中项使用 `#dde2e8`，不要用大面积蓝色选中态。
- 视觉气质参考 Codex 侧栏：浅灰、紧凑、低对比、列表可扫描。
- 顶部不使用模拟 macOS 三色窗口点，保留产品名、简短副标题和折叠按钮即可。
- 会话条目使用 6-8px 圆角，hover 为轻灰，不加厚重阴影。
- 折叠态保持图标/首字母可识别，不改变中间与右侧的空间语义。
- 会话条目支持自定义显示话题，用户可直接编辑；也支持通过当前配置模型自动生成话题标题。生成后的标题只作为 session metadata 保存，不写入聊天历史。

中栏 `Chat`：

- 背景保持白色 `#ffffff`，是主要阅读区域。
- 消息气泡使用细边框和白/浅灰底，不使用强渐变、强阴影或彩色大块。
- 用户消息可以稍微靠右，并使用极浅灰或浅蓝灰；助手消息保持白底。
- 输入框参考 Codex 底部 composer：白底、细边框、轻阴影，操作按钮紧凑。
- 中栏可以有非常轻的网格或纹理，但透明度要低，不能影响文本阅读。
- 模型 thinking 与工具调用记录在生成结束后必须保留，默认折叠存放在对应助手消息顶部，便于复盘但不打断阅读流。

右栏 `Workspace`：

- 背景使用 `#f8fafc`，顶部 chrome 使用 `#f1f5f9`，明显区别于中栏白底。
- 顶部加一个类似浏览器地址条的路径 pill，用来表达“工作区/预览器”语义。
- tabs 使用浅灰 chrome 背景，active tab 用浅蓝底或蓝色文字，不使用粗下划线。
- 内容卡片保持白底、细边框、8px 以内圆角；卡片之间留 12-16px 间距。
- 右栏可保留少量科技感：细网格、知识图谱扫描线、终端预览，但都应服务于工具状态，不做装饰性大光效。

核心颜色 token：

```css
--background: #f7f8fa;
--surface: #ffffff;
--surface-muted: #f3f4f6;
--surface-raised: #fafafa;
--sidebar-bg: #eceff3;
--sidebar-active: #dde2e8;
--chat-bg: #ffffff;
--workspace-bg: #f8fafc;
--workspace-chrome: #f1f5f9;
--border: #e5e7eb;
--border-strong: #c9d0d9;
--text: #171a1f;
--text-muted: #667085;
--text-subtle: #8a94a3;
--accent: #2563eb;
--accent-soft: #dbeafe;
--tech: #06b6d4;
--success: #16a34a;
--warning: #d97706;
--danger: #dc2626;
```

交互规则：

- 所有 hover/active/focus 都使用短动画，建议 `120-180ms`。
- 操作按钮优先使用图标或短标签，不铺满整行。
- 右侧工作区在窄屏也不要直接消失，应优先压缩为窄栏，除非进入明确的移动单栏模式。
- 面板切换、侧栏折叠、工作区半屏/全屏切换要保持空间稳定，避免布局跳动。
- 右侧工作区除收起、半屏、全屏外，还支持横向拖拽自定义宽度；宽度本地持久化，建议限制在 `320px` 到 `920px`。
- 文本密度要接近 Codex：信息足够紧凑，但按钮和输入框保留 30-40px 的可点击高度。

开发落地优先级：

1. 先落全局 CSS token、三栏背景、边框、响应式列宽。
2. 再调整 `SessionSidebar`，让真实左栏接近 demo 中的 Codex 侧栏。
3. 再调整 `ChatCenter` 的消息容器、消息气泡、composer。
4. 再调整 `WorkspacePanel` 和 `TabBar`，加入 workspace chrome 与 browser pill。
5. 最后逐步美化 `WorkspaceBrowser`、`WikiWorkbench`、`JobsPanel` 等具体面板。

**React 迁移记录**

2026-05-23 开始将前端从 Lit/Web Components 迁移到 React + Vite。迁移策略是“React 壳优先，业务 store/API 复用，深层面板渐进替换”：

- `index.html` 入口改为 `#root` + `/src/main.tsx`。
- `vite.config.ts` 接入 `@vitejs/plugin-react`。
- `tsconfig.json` 启用 `jsx: react-jsx`。
- 新增 `src/react/`，React 版 `App`、`SessionSidebar`、`ChatCenter`、`WorkspacePanel`、`WorkspaceBrowser` 已承载核心三栏体验。
- `app-store`、`chat-store`、`sessions-store`、`workspace-store` 暂时保持框架无关，React 通过 `useStoreSnapshot` 订阅。
- 右侧 `Wiki/Graph/Skills/Jobs/Settings` 已迁成 React 组件，旧 custom elements 不再由 React 壳引用。
- 旧 Lit 组件暂时保留，用作兼容和逐步迁移参考；迁完对应面板后再删除。
