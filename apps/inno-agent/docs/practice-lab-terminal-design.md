# Inno Practice Lab 与 Web Terminal 开发设计文档

## 1. 背景与目标

Inno Agent 当前 Web UI 已经形成三栏布局：

```text
左侧：会话列表 / Session 管理
中间：主对话 / Agent 引导
右侧：工作区 / 文件、笔记、画像、任务、技能、设置
```

右侧工作区的 `预览` tab 已经具备文件树、PDF/HTML/Markdown/代码预览、CodeMirror 编辑能力。这为“对话生成学习材料，右侧实践运行”的场景打好了基础。

本设计目标是把右侧工作区升级为面向学习的 `Practice Lab`：

- 用户在对话中提出学习或实验需求，例如“生成一个 Python 数据统计 demo”。
- Inno 在 workspace 中创建脚本、数据、说明文档。
- 右侧工作区自动打开对应文件。
- 用户点击运行按钮或手动输入命令，在内嵌终端中运行脚本。
- 终端输出可回流给 Inno，用于解释结果、分析报错、引导下一步实验。

核心定位：`xterm.js` 不是独立功能，而是 Practice Lab 的运行层。Inno 的价值在于把对话、文件、代码、数据、终端输出和学习引导串成闭环。

## 2. 产品体验

### 2.1 推荐交互流程

```text
用户：帮我写一个 pandas 数据统计 demo

Inno：
  1. 创建 practice/pandas-stats-demo/
     - main.py
     - sample.csv
     - README.md
  2. 在对话中解释实验目标和运行方式
  3. 右侧工作区切到实践目录并打开 main.py
  4. 展示 Run 按钮

用户点击 Run

右侧终端：
  $ python main.py
  ...运行输出...

用户：解释一下刚才的输出

Inno：
  读取最近一次 run record
  解释统计指标、代码路径和可修改参数
```

### 2.2 右侧工作区布局

不建议在顶层工作区增加第七个 tab。当前顶层 tab 已经包含：

```text
笔记本 / 预览 / 学习者画像 / 定时任务 / 技能 / 设置
```

继续增加 `终端` 会造成横向拥挤，也会把“文件、代码、运行”拆散。更合适的方式是将现有 `预览` 演进为 `实践工作区`。

第一阶段仍可保留 tab 名称 `预览`，内部加入终端抽屉：

```text
右侧工作区：预览
├── 左侧：文件树
└── 右侧：文件内容区
    ├── 顶部：文件名、路径、编辑、保存、Run、终端开关
    ├── 中部：CodeMirror / Markdown / PDF / HTML / Image 预览
    └── 底部：xterm.js 终端抽屉
```

当打开可运行文件时，例如 `.py`、`.js`、`.sh`：

- 显示 `Run` 按钮。
- 点击后自动展开终端。
- 命令在当前 workspace 或 practice 目录下执行。
- 输出结束后保存为 run record。

当打开 PDF、图片、HTML 阅读材料时：

- 默认隐藏终端。
- 用户可以手动展开终端。
- 不打断阅读体验。

### 2.3 后续命名

当实践能力成熟后，可以把 `预览` 改名为：

- `实验台`
- `实践`
- `工作区`

推荐中文名：`实验台`。它比“终端”更能表达学习场景，也比“预览”更符合未来能力范围。

## 3. 技术架构

### 3.1 总体架构

```text
Inno Web UI
  ├── ChatCenter
  └── WorkspacePanel
      └── Practice Lab
          ├── WorkspaceBrowser / 文件树
          ├── CodeMirror / 代码编辑
          ├── Preview / 文档预览
          └── xterm.js / 终端 UI

        WebSocket
            ↓

Inno Server
  ├── Terminal Session Manager
  ├── Run Record Store
  ├── Local Pty Backend
  ├── Container Backend
  └── K8s Exec Backend

        ↓

Runtime
  ├── 本地 macOS: zsh/bash + node-pty
  ├── Linux 服务: shell process 或容器
  └── K8s 生产: practice pod/container
```

### 3.2 前端依赖

建议依赖：

```text
@xterm/xterm
@xterm/addon-fit
@xterm/addon-web-links
@xterm/addon-search
@xterm/addon-serialize
```

用途：

- `@xterm/xterm`：终端模拟器核心。
- `addon-fit`：根据容器尺寸自适应列数和行数。
- `addon-web-links`：让输出中的 URL 可点击。
- `addon-search`：搜索终端输出。
- `addon-serialize`：保存和恢复终端内容，用于重连和复盘。

### 3.3 后端依赖

本地开发和桌面版优先使用：

```text
node-pty
```

作用：

- 创建真实 pseudo terminal。
- 支持交互式输入、ANSI 输出、窗口 resize。
- 兼容 macOS、Linux、Windows。

生产部署时不要把后端写死为 node-pty，应抽象 Terminal Backend。

```ts
export interface TerminalBackend {
	createSession(input: CreateTerminalSessionInput): Promise<TerminalSession>;
	resize(sessionId: string, cols: number, rows: number): Promise<void>;
	write(sessionId: string, data: string): Promise<void>;
	close(sessionId: string): Promise<void>;
}
```

第一阶段实现：

```text
LocalPtyBackend
```

后续实现：

```text
ContainerBackend
K8sExecBackend
```

## 4. 前端模块设计

### 4.1 组件结构

建议新增：

```text
apps/inno-agent/web/src/react/practice/
├── PracticeLab.tsx
├── PracticeToolbar.tsx
├── TerminalDrawer.tsx
├── TerminalView.tsx
├── RunCommandButton.tsx
└── RunRecordsPanel.tsx
```

现有 `WorkspaceBrowser` 可以逐步拆分：

```text
WorkspaceBrowser
├── WorkspaceFileTree
├── FileContentPane
├── FilePreview
├── FileEditor
└── PracticeTerminalDrawer
```

第一版不必大拆。可以先在 `FileContentPane` 下方加入 `TerminalDrawer`，等交互稳定后再重构。

### 4.2 TerminalView 行为

`TerminalView` 负责：

- 初始化 xterm。
- 加载 addons。
- 连接 WebSocket。
- 处理输入、输出、resize。
- 断线后显示状态。
- 在组件 unmount 时关闭连接或保持 session。

基本状态：

```ts
type TerminalStatus =
	| "idle"
	| "connecting"
	| "connected"
	| "running"
	| "disconnected"
	| "error";
```

### 4.3 运行按钮

对可运行文件提供默认命令：

```ts
function defaultRunCommand(path: string): string | null {
	if (path.endsWith(".py")) return `python ${quotePath(path)}`;
	if (path.endsWith(".js")) return `node ${quotePath(path)}`;
	if (path.endsWith(".sh")) return `bash ${quotePath(path)}`;
	return null;
}
```

运行按钮行为：

- 若终端未连接，先连接。
- 自动展开终端抽屉。
- 将命令写入终端并执行。
- 建立 run record。
- 运行完成后保存 exit code、stdout/stderr 摘要和时间。

### 4.4 与 ChatCenter 的联动

需要支持从对话中触发工作区动作：

```ts
interface WorkspaceAction {
	type: "open_file" | "run_command" | "open_practice_lab";
	path?: string;
	command?: string;
	cwd?: string;
}
```

初期可以通过前端 store 调用：

```ts
appStore.setRightPanelTab("preview");
workspaceStore.selectFile("practice/pandas-stats-demo/main.py");
terminalStore.runCommand("python practice/pandas-stats-demo/main.py");
```

后续可以把 Agent 工具调用映射为结构化事件：

```text
tool_call: create_practice_lab
tool_result:
  files:
    - practice/pandas-stats-demo/main.py
    - practice/pandas-stats-demo/sample.csv
  suggestedCommand: python practice/pandas-stats-demo/main.py
```

## 5. 后端 API 与 WebSocket 协议

### 5.1 HTTP API

建议新增：

```text
POST /api/terminal/sessions
GET  /api/terminal/sessions/:id
POST /api/terminal/sessions/:id/close
GET  /api/runs
GET  /api/runs/:id
POST /api/runs
```

创建终端 session：

```json
{
  "cwd": "practice/pandas-stats-demo",
  "shell": "default",
  "cols": 100,
  "rows": 24
}
```

返回：

```json
{
  "id": "term_abc123",
  "cwd": "practice/pandas-stats-demo",
  "status": "created"
}
```

### 5.2 WebSocket

路径：

```text
GET /api/terminal/sessions/:id/ws
```

客户端发送：

```ts
type ClientTerminalEvent =
	| { type: "input"; data: string }
	| { type: "resize"; cols: number; rows: number }
	| { type: "run"; command: string; runId?: string }
	| { type: "close" };
```

服务端发送：

```ts
type ServerTerminalEvent =
	| { type: "ready"; sessionId: string; cwd: string }
	| { type: "output"; data: string }
	| { type: "status"; status: "running" | "idle" | "closed" }
	| { type: "exit"; code: number | null; signal?: string }
	| { type: "error"; message: string };
```

### 5.3 Run Record

每次点击 `Run` 建议保存一条记录：

```ts
interface RunRecord {
	id: string;
	sessionId: string;
	command: string;
	cwd: string;
	startedAt: string;
	endedAt?: string;
	exitCode?: number | null;
	outputPreview: string;
	outputPath?: string;
	sourceFile?: string;
}
```

存储位置建议：

```text
data/runs/YYYY-MM-DD/*.json
data/runs/YYYY-MM-DD/*.log
```

这样 Inno 可以读取最近一次运行输出，回答：

- “解释刚才的报错”
- “这个结果是什么意思”
- “下一步我应该改哪个参数”

## 6. Agent 工具设计

### 6.1 create_practice_lab

让 Agent 用结构化工具创建实验目录，而不是只在聊天里贴代码。

```ts
interface CreatePracticeLabInput {
	title: string;
	slug: string;
	description?: string;
	files: Array<{
		path: string;
		content: string;
	}>;
	suggestedCommand?: string;
}
```

工具行为：

- 在 workspace 下创建 `practice/<slug>/`。
- 写入文件。
- 返回文件列表和建议命令。
- 前端自动打开主文件。

### 6.2 explain_last_run

让 Agent 读取最近一次运行记录。

```ts
interface ExplainLastRunInput {
	runId?: string;
	focus?: "error" | "result" | "performance" | "next_step";
}
```

第一阶段可以不做独立工具，先由后端把最近 run record 注入对话上下文；但长期建议工具化，避免上下文无限膨胀。

## 7. 安全设计

### 7.1 基本原则

Web Terminal 等同于给用户提供系统命令执行能力，不能按普通前端组件处理。必须默认收紧权限。

第一阶段本地开发：

- 只允许绑定到当前 `INNO_WORKSPACE_DIR`。
- `cwd` 必须在 workspace 内。
- 禁止通过 API 指定任意宿主路径。
- 不注入敏感环境变量。
- WebSocket 必须和当前 Web session 绑定。

服务端校验：

```ts
function assertWorkspacePath(workspaceDir: string, inputPath: string): string {
	const resolved = resolve(workspaceDir, inputPath);
	if (!resolved.startsWith(workspaceDir)) {
		throw new Error("Path is outside workspace");
	}
	return resolved;
}
```

### 7.2 K8s 生产建议

生产环境不要让用户终端直接运行在 Inno 主服务 Pod 中。推荐：

```text
每个用户/session/lab 一个 practice pod
```

或至少：

```text
每个 lab 一个短生命周期 job/container
```

K8s 安全基线：

- `runAsNonRoot: true`
- `readOnlyRootFilesystem: true`
- workspace/data 使用受控 volume。
- 配置 CPU/memory limits。
- 配置 NetworkPolicy。
- 不挂载宿主 Docker socket。
- 不使用 privileged container。
- 使用短生命周期和空闲超时清理。

`pi-sandbox` 可以作为增强层，但不应作为 K8s 生产的唯一隔离边界。

### 7.3 命令执行策略

建议区分两类命令：

```text
用户输入命令：允许在实践终端中执行，受 workspace/container 限制。
Agent 建议命令：必须用户点击确认后执行。
```

第一版不建议让 Agent 完全自动控制交互式终端。更好的学习体验是：

- Agent 生成命令。
- 用户确认运行。
- Inno 解释结果。

## 8. 实施阶段

### Phase 1: 本地 Practice Terminal

目标：在现有 `预览` tab 中加入可折叠终端。

范围：

- 前端引入 xterm.js。
- 后端引入 node-pty。
- 新增 terminal session manager。
- 支持 WebSocket 输入输出。
- 支持 resize。
- 支持打开文件后点击 Run。

验收：

- 打开 `.py` 文件能看到 Run 按钮。
- 点击 Run 后终端自动展开。
- 能执行 `python path/to/file.py`。
- stdout/stderr 实时显示。
- 切换文件后终端不误清空。

### Phase 2: 对话与实验联动

目标：Inno 能创建实验目录并自动打开。

范围：

- 新增 `create_practice_lab` 工具。
- 工具返回结构化文件列表和 suggested command。
- 前端监听 tool result，自动切到工作区。
- 保存 run record。
- Chat 支持“解释最近一次运行”。

验收：

- 用户一句话生成 Python demo。
- 文件自动出现在工作区文件树。
- 主文件自动打开。
- 点击 Run 后能运行。
- 用户追问报错时，Inno 能引用最近输出。

### Phase 3: 实验记录与学习复盘

目标：把运行过程变成可复盘学习材料。

范围：

- RunRecordsPanel。
- 每次运行保存命令、退出码、输出摘要。
- 支持把一次运行保存到 Notebook / L2 Wiki。
- 支持 Inno 基于 run record 生成学习总结。

验收：

- 用户能查看历史运行。
- 能一键让 Inno 总结某次运行。
- 可将代码、输出、解释归档到学习笔记。

### Phase 4: K8s Practice Runtime

目标：生产环境安全运行实验。

范围：

- 抽象 TerminalBackend。
- 实现 K8sExecBackend。
- 为每个 lab 创建隔离 pod。
- 支持镜像选择，例如 Python、Node、Data Science。
- 空闲超时和资源限制。

验收：

- 终端不运行在 Inno 主服务 Pod。
- 每个 lab 有隔离工作目录。
- 超时后自动清理。
- 网络和文件权限符合策略。

## 9. 文件与代码改造建议

前端：

```text
apps/inno-agent/web/src/react/WorkspaceBrowser.tsx
  - 短期加入 TerminalDrawer
  - 长期拆分为文件树、内容区、实践终端

apps/inno-agent/web/src/stores/terminal-store.ts
  - 管理 terminal session、状态、run command

apps/inno-agent/web/src/types/terminal.ts
  - WebSocket event 类型

apps/inno-agent/web/src/api/terminal.ts
  - 创建 session、连接 ws、关闭 session
```

后端：

```text
apps/inno-agent/src/server.ts
  - 增加 terminal HTTP API 和 WebSocket upgrade

apps/inno-agent/src/terminal/
  ├── terminal-types.ts
  ├── terminal-session-manager.ts
  ├── local-pty-backend.ts
  ├── run-record-store.ts
  └── path-policy.ts
```

Agent 工具：

```text
apps/inno-agent/src/practice/
  ├── practice-tools.ts
  ├── practice-store.ts
  └── practice-template.ts
```

## 10. 设计取舍

### 不做独立顶层 Terminal tab

原因：

- 当前右侧顶层 tab 已经较多。
- 终端脱离文件和代码后，学习场景会被拆散。
- 用户真正需要的是“当前代码的运行环境”，不是一个孤立 shell。

### 不让 Agent 默认自动执行终端命令

原因：

- 学习场景需要用户知道自己在运行什么。
- 安全上更可控。
- 用户确认动作可以成为理解命令的学习节点。

### 不把生产终端跑在主服务 Pod

原因：

- 命令执行能力风险高。
- 主服务 Pod 挂载配置、密钥、数据目录，暴露面过大。
- K8s practice pod 更适合资源限制、网络隔离和生命周期管理。

## 11. MVP 验收清单

```text
[ ] 右侧预览区底部出现可折叠终端抽屉
[ ] xterm.js 能显示 shell 输出
[ ] 支持输入命令并实时返回结果
[ ] 支持 resize
[ ] 打开 Python 文件时出现 Run 按钮
[ ] 点击 Run 自动展开终端并执行命令
[ ] 终端 cwd 被限制在 workspace 内
[ ] WebSocket 断开后 UI 有明确状态
[ ] 运行输出保存为 run record
[ ] 用户可让 Inno 解释最近一次运行输出
```

## 12. 推荐第一步

第一步不要大改右侧布局。直接在现有 `WorkspaceBrowser` 的文件内容区下方加入 `TerminalDrawer`：

```text
FileContentPane
├── Toolbar
├── Preview / Editor
└── TerminalDrawer
```

这样改动最小，也最容易验证学习闭环。等本地 Python demo 跑通后，再把 `预览` 正式升级为 `实验台`。
