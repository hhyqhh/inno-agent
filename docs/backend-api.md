# 后端接口文档

本文档整理 Inno Agent 后端 HTTP API 与终端 WebSocket 协议。接口实现主要位于 `apps/inno-agent/src/server/routes/`，服务入口为 `apps/inno-agent/src/server.ts`。

## 通用约定

| 项目 | 说明 |
| --- | --- |
| 基础地址 | 开发默认 `http://localhost:3000`；Vite 前端开发服务会将 `/api/*` 代理到后端。 |
| 数据格式 | 除文件下载、SSE、WebSocket 外，请求与响应默认为 JSON，但本文使用表格描述结构。 |
| 错误格式 | 多数接口返回字段 `error:string`。 |
| 路径参数 | `:id`、`:name` 等需要 URL 编码。 |
| 文件路径 | 工作区和 Skill 文件接口均使用相对路径，后端会校验目录逃逸。 |
| 请求体上限 | 普通 JSON 约 32 MB；上传类接口约 192 MB。 |
| 自由字段 | `unknown` 表示源码按自由 JSON 透传，例如工具参数/结果、问卷定义、Wiki frontmatter 或原始渠道消息。 |

## 接口目录

按业务领域列出全部后端接口，点击接口路径可跳转到对应的详细说明。

| 分类 | 方法 | 接口路径 |
| --- | --- | --- |
| 健康检查 | GET | /health |
| 健康检查 | GET | /api/health |
| 聊天接口 | POST | /api/chat |
| 聊天接口 | POST | /api/chat/stream |
| 聊天接口 | POST | /api/chat/question-response |
| 聊天接口 | POST | /api/chat/abort |
| 聊天接口 | POST | /api/chat/:sessionId/:turnId/abort |
| 聊天接口 | GET | /api/chat/status/:sessionId |
| 聊天接口 | GET | /api/chat/events/:id |
| 会话接口 | GET | /api/sessions |
| 会话接口 | POST | /api/sessions |
| 会话接口 | GET | /api/sessions/:id |
| 会话接口 | PATCH | /api/sessions/:id |
| 会话接口 | DELETE | /api/sessions/:id |
| 会话接口 | POST | /api/sessions/:id/activate |
| 会话接口 | POST | /api/sessions/:id/archive |
| 会话接口 | POST | /api/sessions/:id/unarchive |
| 会话接口 | GET | /api/sessions/:id/export.md |
| 会话接口 | POST | /api/sessions/:id/showcase-export |
| 会话接口 | POST | /api/sessions/:id/generate-topic |
| 会话接口 | POST | /api/sessions/:id/branch-before-message |
| 会话接口 | GET | /api/sessions/:id/workspace |
| 会话接口 | PUT | /api/sessions/:id/workspace |
| Wiki 与 L2 原始资料 | GET | /api/wiki/pages |
| Wiki 与 L2 原始资料 | GET | /api/wiki/page |
| Wiki 与 L2 原始资料 | PUT | /api/wiki/page |
| Wiki 与 L2 原始资料 | DELETE | /api/wiki/page |
| Wiki 与 L2 原始资料 | GET | /api/wiki/reviews |
| Wiki 与 L2 原始资料 | GET | /api/wiki/graph |
| Wiki 与 L2 原始资料 | GET | /api/wiki/stats |
| Wiki 与 L2 原始资料 | POST | /api/l2/raw/upload |
| 工作区文件接口 | GET | /api/workspace/tree |
| 工作区文件接口 | GET | /api/workspace/file |
| 工作区文件接口 | GET | /api/workspace/raw |
| 工作区文件接口 | HEAD | /api/workspace/raw |
| 工作区文件接口 | GET | /api/workspace/download-folder |
| 工作区文件接口 | HEAD | /api/workspace/download-folder |
| 工作区文件接口 | GET | /api/workspace/office-preview |
| 工作区文件接口 | GET | /api/workspace/pptx-preview |
| 工作区文件接口 | PUT | /api/workspace/file |
| 工作区文件接口 | POST | /api/workspace/create |
| 工作区文件接口 | POST | /api/workspace/rename |
| 工作区文件接口 | POST | /api/workspace/delete |
| 工作区文件接口 | POST | /api/workspace/move |
| 工作区文件接口 | POST | /api/workspace/upload |
| 工作区文件接口 | POST | /api/workspace/skills/upload |
| 工作区注册表 | GET | /api/workspaces |
| 工作区注册表 | POST | /api/workspaces |
| 工作区注册表 | PATCH | /api/workspaces/:id |
| 工作区注册表 | DELETE | /api/workspaces/:id |
| 终端与运行记录 | POST | /api/terminal/sessions |
| 终端与运行记录 | POST | /api/terminal/sessions/:id/close |
| 终端与运行记录 | GET | /api/runs |
| 终端与运行记录 | GET | /api/runs/:id |
| 终端与运行记录 | POST | /api/runs/:id/archive |
| 终端与运行记录 | WS | /api/terminal/sessions/:id/ws |
| Skills 与远程技能库 | GET | /api/skills |
| Skills 与远程技能库 | POST | /api/skills/upload |
| Skills 与远程技能库 | POST | /api/skills/reload |
| Skills 与远程技能库 | PATCH | /api/skills/:name |
| Skills 与远程技能库 | DELETE | /api/skills/:name |
| Skills 与远程技能库 | GET | /api/skills/:name/content |
| Skills 与远程技能库 | PUT | /api/skills/:name/content |
| Skills 与远程技能库 | GET | /api/skills/:name/tree |
| Skills 与远程技能库 | GET | /api/skills/:name/file |
| Skills 与远程技能库 | PUT | /api/skills/:name/file |
| Skills 与远程技能库 | GET | /api/skills/:name/raw |
| Skills 与远程技能库 | GET | /api/skill-library |
| Skills 与远程技能库 | POST | /api/skill-library/import |
| 预设工作区 | GET | /api/presets |
| 预设工作区 | GET | /api/preset-library |
| 设置接口 | GET | /api/settings |
| 设置接口 | POST | /api/settings/model |
| 设置接口 | PUT | /api/settings/providers |
| 设置接口 | POST | /api/settings/providers |
| 设置接口 | PATCH | /api/settings/providers |
| 设置接口 | POST | /api/settings/providers/probe-models |
| 设置接口 | DELETE | /api/settings/providers/:providerId/models/:modelId |
| 设置接口 | DELETE | /api/settings/providers/:providerId |
| 设置接口 | PUT | /api/settings/channels |
| 设置接口 | PUT | /api/settings/memory |
| 设置接口 | PUT | /api/settings/simple-mode |
| 设置接口 | PUT | /api/settings/smart-input |
| 设置接口 | PUT | /api/settings/mcp |
| 设置接口 | PUT | /api/settings/github |
| 设置接口 | PUT | /api/settings/ocr |
| 设置接口 | PUT | /api/settings/tavily |
| 设置接口 | GET | /api/settings/web-access |
| 设置接口 | PUT | /api/settings/web-access |
| 设置接口 | PUT | /api/settings/content-hub |
| 设置接口 | PUT | /api/settings/theme |
| 设置接口 | PUT | /api/settings/close-behavior |
| MCP 接口 | GET | /api/mcp |
| MCP 接口 | PUT | /api/mcp/servers/:name |
| MCP 接口 | PATCH | /api/mcp/servers/:name |
| MCP 接口 | DELETE | /api/mcp/servers/:name |
| 渠道接口 | GET | /api/channels |
| 渠道接口 | POST | /api/channels/:name/default-target |
| 渠道接口 | POST | /api/channels/:name/test |
| 渠道接口 | GET | /api/channels/:name/health |
| 渠道接口 | POST | /api/bridge/messages |
| 渠道接口 | POST | /api/channels/feishu/qr-register |
| 渠道接口 | GET | /api/channels/feishu/qr-status |
| 渠道接口 | POST | /api/channels/wechat/qr-login |
| 渠道接口 | GET | /api/channels/wechat/qr-status |
| 渠道接口 | GET | /api/channels/wechat/status |
| 渠道接口 | GET | /api/channels/runs |
| 定时任务接口 | GET | /api/jobs |
| 定时任务接口 | POST | /api/jobs |
| 定时任务接口 | PATCH | /api/jobs/:id |
| 定时任务接口 | DELETE | /api/jobs/:id |
| 定时任务接口 | POST | /api/jobs/:id/run |
| 定时任务接口 | GET | /api/jobs/status |
| 定时任务接口 | GET | /api/jobs/runs |
| 定时任务接口 | GET | /api/jobs/:id/runs |
| 学习者画像接口 | GET | /api/learner/profile |
| 学习者画像接口 | PATCH | /api/learner/profile |
| 学习者画像接口 | POST | /api/learner/profile/goals |
| 学习者画像接口 | PATCH | /api/learner/profile/goals/:goalId |
| 学习者画像接口 | DELETE | /api/learner/profile/goals/:goalId |
| 学习者画像接口 | PATCH | /api/learner/profile/knowledge/:conceptId |
| 学习者画像接口 | PATCH | /api/learner/profile/misconceptions/:miscId |
| 命令接口 | GET | /api/commands |

## 公共数据结构

### `SessionSummary`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | string | 会话文件 ID。 |
| name | string | 会话标题或预览名。 |
| preview | string | 会话内容预览。 |
| messageCount | number | 消息数量。 |
| createdAt / updatedAt | string | ISO 时间。 |
| channels | string[] | 触达渠道。 |
| origin | string | 会话来源。 |
| hasTopic | boolean | 是否已有主题。 |
| archived | boolean | 是否已归档。 |

### `SessionMessageSummary`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| role | user 或 assistant | 消息角色。 |
| content | string | 消息文本。 |
| timestamp | number | 消息时间戳。 |
| entryId / parentEntryId | string / string|null | PI 会话树节点标识。 |
| thinking | string | 助手思考文本。 |
| tools | ToolCall[] | 工具调用及其参数、结果和错误状态。 |
| channel | string | 消息来源渠道。 |
| images | ImageRef[] | 图片预览信息。 |
| attachments | ChatAttachments | 结构化附件信息。 |

### `ChatAttachments`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| bindings | AttachmentBinding[] | 关键词气泡绑定的文件。 |
| loose | AttachmentRef[] | 普通附件文件。 |

### `AttachmentBinding`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| word | string | 用户消息中的关键词。 |
| wordIndex | number | 关键词出现位置，从 0 开始。 |
| files | AttachmentRef[] | 关键词绑定的文件列表。 |

### `AttachmentRef`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| path | string | 工作区相对路径。 |
| kind | pdf、doc、xls、ppt、image 或 file | 文件类型。 |
| source | workspace 或 upload | 文件来源。 |

### `PersistedQuestion`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| questionId | string | 问题 ID。 |
| sessionId | string | 所属会话 ID。 |
| turnId | string | 所属聊天轮次 ID。 |
| params | unknown | 问卷定义和参数。 |
| createdAt | string | 创建时间。 |

### `QuestionBridgeResult`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| answers | Answer[] | 用户回答列表。 |
| cancelled | boolean | 是否取消回答。 |
| error | string | 可选错误原因。 |

### `WorkspaceTreeNode`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| name | string | 文件或目录名称。 |
| path | string | 相对于工作区根目录的路径。 |
| type | file 或 directory | 节点类型。 |
| size | number | 文件或目录大小。 |
| updatedAt | string | 最后更新时间。 |
| children | WorkspaceTreeNode[] | 子节点列表，目录节点可用。 |

### `WorkspaceMeta`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | string | 工作区 ID。 |
| name | string | 工作区名称。 |
| relPath | string | 相对于工作区根目录的路径。 |
| createdAt | string | 创建时间。 |
| updatedAt | string | 更新时间。 |
| isTemp | boolean | 是否为临时工作区。 |

### `WorkspaceWithSessions`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id / name / relPath | string | 工作区基础信息。 |
| createdAt / updatedAt | string | 创建和更新时间。 |
| isTemp | boolean | 是否为临时工作区。 |
| sessionIds | string[] | 绑定到该工作区的会话 ID。 |

### `PublicStreamSnapshot`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| sessionId / turnId / clientRequestId | string | 聊天流定位字段。 |
| workspaceId | string | 当前工作区 ID。 |
| status | queued、running、completed、error 或 aborted | 聊天流状态。 |
| createdAt / startedAt / finishedAt | string | 流生命周期时间。 |
| inputSnapshot | object | 本轮 prompt、图片和附件快照。 |
| activeTools / completedTools | Tool[] | 正在运行和已完成的工具。 |
| pendingQuestion | object | 当前待回答问题。 |
| lastEventId | number | 最近事件序号。 |
| cancelRequested | boolean | 是否已请求取消。 |
| terminalReason | string | 可选终止原因。 |
| persisted | boolean | 本轮结果是否已持久化。 |
| finalMessageCount / finalSessionRevision | number / string | 完成后的消息数量和会话修订号。 |

### `RunRecord`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | string | 运行记录 ID。 |
| sessionId / workspaceId | string | 所属会话和工作区 ID。 |
| command | string | 执行的命令。 |
| cwd | string | 命令执行目录。 |
| startedAt / endedAt | string | 开始和结束时间。 |
| exitCode | number 或 null | 进程退出码。 |
| signal | string | 可选终止信号。 |
| sourceFile | string | 可选来源文件。 |
| logPath | string | 日志文件路径。 |
| outputBytes | number | 输出字节数。 |

### `ProjectSkill`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| name | string | Skill 名称。 |
| description | string | Skill 描述。 |
| category | string | 可选分类。 |
| enabled | boolean | 是否启用。 |
| loaded | boolean | 是否已加载。 |
| filePath | string | Skill 文件路径。 |
| size | number | Skill 文件大小。 |
| updatedAt | string | 最后更新时间。 |
| diagnostics | string[] | 加载或解析诊断信息。 |

### `SkillLibraryItem`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| name | string | 远程 Skill 名称。 |
| description | string | Skill 描述。 |
| installed | boolean | 是否已安装到本地。 |
| category | string | 可选分类。 |

### `PresetMeta`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | string | 预设 ID。 |
| name | string | 预设名称。 |
| description | string | 预设描述。 |
| icon | string | 可选图标。 |
| category | string | 可选分类。 |

### `SafeSettings`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| defaultProvider / defaultModel | string | 当前默认模型提供商和模型。 |
| providers | object | 模型提供商配置，API Key 和 header 值脱敏。 |
| configuredModels | RuntimeModel[] | 配置文件中的模型。 |
| availableModels | RuntimeModel[] | 当前运行时可用模型。 |
| server | object | 可选服务端配置。 |
| feishu | object | 可选飞书配置，appSecret 脱敏。 |
| channels | object | 各消息渠道配置。 |
| bridge / github | object | bridge 和 GitHub 配置，token 脱敏。 |
| contentHub | object | 远程内容中心配置，token 脱敏。 |
| memory / simpleMode | object | 记忆层和 Simple Mode 配置。 |
| smartInput | InnoSmartInputConfig | 便捷输入配置。 |
| mcp | object | MCP 开关配置。 |
| ui / scheduler | object | UI 和定时任务配置。 |
| ocrApi / tavily | object | OCR 和 Tavily 配置，凭据脱敏。 |

### `InnoSmartInputConfig`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| enabled | boolean | 是否启用便捷输入。 |
| allowDrag | boolean | 是否允许拖拽文件。 |
| allowRightClick | boolean | 是否允许右键绑定文件。 |
| allowAgentCommands | boolean | 是否将 Agent 命令转换为输入气泡。 |
| rules | SmartInputRule[] | 关键词与文件扩展名规则。 |

### `WebAccessSettingsView`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| defaultProvider | string | 默认搜索 provider。 |
| providers | ProviderView[] | provider 状态、类型和脱敏值。 |

### `McpOverview`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| enabled | boolean | MCP 是否启用。 |
| adapterLoaded | boolean | MCP adapter 是否成功加载。 |
| configPath | string | managed MCP 配置文件路径。 |
| configError | string | 可选配置解析错误。 |
| servers | McpServerView[] | 有效配置源合并后的服务器列表。 |
| status | McpStatusSnapshot|null | adapter 发布的运行态快照。 |

### `McpServerEntry`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| command / args | string / string[] | stdio 服务器启动命令和参数。 |
| socket | string | 可选 socket 传输地址。 |
| env / cwd | object / string | 环境变量和工作目录。 |
| url / headers | string / object | HTTP 服务器地址和请求头。 |
| auth / bearerToken / bearerTokenEnv | string或false / string | 认证方式和凭据配置。 |
| lifecycle | string | 服务器生命周期策略。 |
| idleTimeout / requestTimeoutMs | number | 空闲和请求超时时间。 |
| exposeResources | boolean | 是否暴露资源。 |
| directTools / includeTools / excludeTools | boolean或string[] | 工具暴露和筛选规则。 |
| approveTools / debug / disabled | boolean或string[] / boolean / boolean | 审批、调试和禁用配置。 |

### `McpServerStatus`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| name | string | 服务器名称。 |
| status | connected、cached、failed、needs-auth、not-connected 或 disabled | 运行状态。 |
| toolCount / resourceCount | number | 工具和资源数量。 |
| failedAgoSeconds | number | 失败距今秒数。 |
| disabled | boolean | 是否禁用。 |

### `McpStatusSnapshot`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| version | number | 状态快照版本。 |
| servers | McpServerStatus[] | 各 MCP 服务器状态。 |
| totalTools / totalResources | number | 工具和资源总数。 |
| connectedCount / disabledCount | number | 已连接和已禁用服务器数量。 |

### `ScheduledJob`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id / name | string | 任务 ID 和名称。 |
| cron / timezone | string | Cron 表达式和时区。 |
| enabled | boolean | 是否启用。 |
| channel / target | ChannelName / PushTarget | 可选推送渠道和目标。 |
| taskType | TaskType | 任务类型。 |
| prompt | string | 任务提示词。 |
| lastRunAt / nextRunAt | string | 上次和下次执行时间。 |
| lastStatus | running、success、error 或 skipped | 最近执行状态。 |
| lastError | string | 最近一次错误信息。 |
| runCount / failureCount | number | 执行次数和失败次数。 |
| createdAt / updatedAt | string | 创建和更新时间。 |

### `JobRunRecord`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id / jobId / jobName | string | 运行记录和所属任务信息。 |
| status | running、success、error 或 skipped | 本次运行状态。 |
| startedAt / finishedAt | string | 开始和结束时间。 |
| durationMs | number | 执行耗时。 |
| outputPreview | string | 输出预览。 |
| error | string | 可选错误信息。 |
| pushedToChannel | string | 实际推送渠道。 |
| pushSkippedReason | string | 未推送原因。 |
| trigger | scheduled、manual 或 api | 触发来源。 |

### `JobRunResult`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| jobId / runId | string | 任务和本次运行 ID。 |
| success | boolean | 是否执行成功。 |
| output | string | 成功时的任务输出。 |
| error | string | 失败时的错误信息。 |
| pushedToChannel | string | 实际推送渠道。 |

### `ChannelRun`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| runId / channel / messageId | string | 渠道运行、渠道和消息 ID。 |
| status | success 或 error | 处理状态。 |
| startedAt / finishedAt | string | 开始和结束时间。 |
| durationMs | number | 处理耗时。 |
| error | string | 可选错误信息。 |

### `SlashCommandItem`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| name | string | 命令名称，不含开头的斜杠。 |
| description | string | 可选命令描述。 |
| source | extension、prompt 或 skill | 命令来源。 |
| webSafe | boolean | 是否适合在 Web 输入框中使用。 |

### `LearnerProfile`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| learner_id | string | 学习者 ID。 |
| version | number | 画像版本。 |
| updated_at | string | 更新时间。 |
| goals | LearningGoal[] | 学习目标列表。 |
| knowledge_states | KnowledgeState[] | 概念知识状态列表。 |
| misconceptions | Misconception[] | 认知误区列表。 |
| preferences | LearnerPreferences | 学习偏好。 |
| profile_summary | string | 画像摘要。 |

### `LearnerPreferences`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| explanation_style | string[] | 讲解风格偏好。 |
| practice_style | string[] | 练习方式偏好。 |
| feedback_tone | string[] | 反馈语气偏好。 |
| avoid | string[] | 需要避免的表达或方式。 |

### `LearningGoal`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| goal_id | string | 目标 ID。 |
| title | string | 目标名称。 |
| type | skill、concept、project、exam 或 habit | 目标类型。 |
| priority | number | 目标优先级。 |
| status | active、paused、completed 或 archived | 目标状态。 |
| success_criteria | string[] | 成功标准。 |
| source | user_declared、agent_inferred 或 imported | 目标来源。 |
| updated_at | string | 更新时间。 |

### `KnowledgeState`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| concept_id / concept_name / domain | string | 概念 ID、名称和领域。 |
| mastery / confidence / stability | number | 掌握度、置信度和稳定性。 |
| diagnosis | string | 当前诊断。 |
| next_actions | string[] | 建议的下一步行动。 |
| evidence_ids | string[] | 相关证据 ID。 |
| state_label | string | 可选知识状态标签。 |
| last_evidence_at / review_due_at | string | 最近证据时间和复习时间。 |

### `Misconception`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| misconception_id | string | 误区 ID。 |
| concept_id | string | 关联概念 ID。 |
| description | string | 误区描述。 |
| status | active、repairing、resolved 或 stale | 误区状态。 |
| severity / confidence | number | 严重程度和置信度。 |
| first_seen_at / last_seen_at | string | 首次和最近发现时间。 |
| evidence_ids | string[] | 相关证据 ID。 |
| repair_strategy | string | 修复策略。 |

### `WikiGraph`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| nodes | WikiGraphNode[] | Wiki 页面节点。 |
| edges | WikiGraphEdge[] | 页面关系边。 |
| maintenance | WikiGraphMaintenance | 缺失链接、孤立页等维护信号。 |
| communities | WikiGraphCommunities | 社区数量、模块度和凝聚度。 |

### `WikiGraphNode`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | string | 节点 ID，通常为 Wiki 相对路径。 |
| title | string | 节点标题。 |
| type | string | 页面类型。 |
| tags | string[] | 页面标签。 |
| degree | number | 可选节点度数。 |
| community | number | 可选社区 ID。 |

### `WikiGraphEdge`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| source / target | string | 起点和终点节点 ID。 |
| type | link 或 tag | 关系类型。 |
| weight | number | 关系权重。 |

### `WikiIngestReview`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | string | 审核记录 ID。 |
| sourceId / sourcePath | string | 来源 ID 和来源路径。 |
| type | contradiction、duplicate、missing-page、suggestion 或 confirm | 审核类型。 |
| title / description | string | 审核标题和说明。 |
| pages / search | string[] | 相关页面和搜索词。 |
| options | object[] | 可执行操作，包含 label 和 action。 |
| createdAt | string | 创建时间。 |

## 接口说明

以下每个小节对应一个接口。请求字段表包含路径参数、查询参数、请求头、请求体或 WebSocket 客户端事件；返回字段表描述成功响应的顶层字段，复用的对象字段请参见上方同名公共数据结构表。

## 健康检查

### `GET /health`

检查后端服务是否已启动并可响应。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| — | 无 | — | — | 无请求参数或请求体。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | status | string，固定为 ok | 必填字段。 |

### `GET /api/health`

提供带 `/api` 前缀的健康检查接口，便于前端代理或 API 网关调用。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| — | 无 | — | — | 无请求参数或请求体。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | status | string，固定为 ok | 必填字段。 |

## 聊天接口

### `POST /api/chat`

发送一次非流式聊天请求，等待模型完整回复后返回。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 请求体 | prompt | string | 是 | 必填字段。 |
| 请求体 | sessionId | string | 否 | 可选字段。 |
| 请求体 | images | ImageContent[] | 否 | 可选字段。 |
| 请求体 | attachments | ChatAttachments | 否 | 可选字段。 |

#### JSON 请求示例

```json
{
  "prompt": "总结当前工作区的 README",
  "sessionId": "session-001",
  "images": [],
  "attachments": {
    "bindings": [],
    "loose": []
  }
}
```

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | response | string | 必填字段。 |

### `POST /api/chat/stream`

发起一次流式聊天请求，通过 SSE 持续返回文本、工具调用和终止事件。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 请求体 | prompt | string | 是 | 必填字段。 |
| 请求体 | sessionId | string | 是 | 必填字段。 |
| 请求体 | clientRequestId | string | 是 | 必填字段。 |
| 请求体 | images | ImageContent[] | 否 | 可选字段。 |
| 请求体 | attachments | ChatAttachments | 否 | 可选字段。 |

#### JSON 请求示例

```json
{
  "prompt": "分析这个项目的后端入口",
  "sessionId": "session-001",
  "clientRequestId": "req-20260903-001",
  "images": [],
  "attachments": {
    "bindings": [],
    "loose": []
  }
}
```

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| SSE 数据帧 | seq | number | 必填字段。 |
| SSE 数据帧 | event | stream_state、text_delta、thinking_delta、tool_call_delta、tool_start、tool_end、workspace_change、question、done、error 或 aborted | 必填字段。 |

### `POST /api/chat/question-response`

提交前端问答卡片的用户回答，唤醒等待中的 agent 工具调用。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 请求体 | sessionId | string | 是 | 必填字段。 |
| 请求体 | turnId | string | 是 | 必填字段。 |
| 请求体 | questionId | string | 是 | 必填字段。 |
| 请求体 | result | QuestionBridgeResult | 是 | 必填字段。 |

#### JSON 请求示例

```json
{
  "sessionId": "session-001",
  "turnId": "turn-001",
  "questionId": "question-001",
  "result": {
    "answers": [
      {
        "id": "choice-a",
        "value": "继续执行"
      }
    ],
    "cancelled": false
  }
}
```

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | accepted | boolean | 必填字段。 |
| 响应对象 | expired | boolean | 可选字段。 |
| 响应对象 | sessionId | string | 可选字段。 |

### `POST /api/chat/abort`

旧版未限定会话的中止入口；当前要求使用带 sessionId 和 turnId 的作用域接口。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| — | 无 | — | — | 无请求参数或请求体。 |

#### JSON 请求示例

无请求体时可省略请求体；如需传 JSON，可使用空对象。

```json
{}
```

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 错误字段 error | string，提示需要 scoped abort | 必填字段。 |

### `POST /api/chat/:sessionId/:turnId/abort`

取消指定会话中的指定流式聊天轮次。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 路径参数 | sessionId | string | 是 | URL 编码后的路径参数。 |
| 路径参数 | turnId | string | 是 | URL 编码后的路径参数。 |

#### JSON 请求示例

无请求体时可省略请求体；如需传 JSON，可使用空对象。

```json
{}
```

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | status | string | 必填字段。 |
| 响应对象 | cancelRequested | boolean | 必填字段。 |

### `GET /api/chat/status/:sessionId`

查询某个会话最近一次聊天流的公开状态快照。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 路径参数 | sessionId | string | 是 | URL 编码后的路径参数。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | found | boolean | 未找到时为 false；找到时为 true。 |
| 响应对象 | stream | PublicStreamSnapshot | 仅在 found 为 true 时返回。 |

### `GET /api/chat/events/:id`

从指定事件序号之后回放聊天流事件，用于前端重连恢复。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 路径参数 | id | string | 是 | sessionId。 |
| 查询参数 | turnId | string | 是 | 必填字段。 |
| 查询参数 | after | number | 是 | 必填字段。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| SSE 数据帧 | seq | number | 必填字段。 |
| SSE 数据帧 | 事件 | SSE | event 为聊天流事件 |
| SSE 数据帧 | 事件 | SSE | 结束帧为 [DONE] |

## 会话接口

### `GET /api/sessions`

列出所有可展示会话摘要，包含渠道、主题和归档状态。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| — | 无 | — | — | 无请求参数或请求体。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | SessionSummary[] | 字段定义参见公共数据结构 SessionSummary。 |

### `POST /api/sessions`

创建新会话，并绑定到现有工作区、新工作区、临时工作区或预设工作区。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 请求体 | workspaceId | string | 否 | 可选字段。 |
| 请求体 | presetId | string | 否 | 可选字段。 |
| 请求体 | newWorkspace | object | 否 | 嵌套对象。 |
| 请求体 | newWorkspace.name | string | 否 | 可选字段。 |
| 请求体 | newWorkspace.isTemp | boolean | 否 | 可选字段。 |

#### JSON 请求示例

```json
{
  "newWorkspace": {
    "name": "学习项目",
    "isTemp": false
  }
}
```

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | id | string | 必填字段。 |
| 响应对象 | active | true | 必填字段。 |
| 响应对象 | workspaceId | string | 必填字段。 |

### `GET /api/sessions/:id`

读取指定会话详情，包括消息、修订号和待回答问题。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 路径参数 | id | string | 是 | URL 编码后的路径参数。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 基础字段 | SessionSummary | 字段定义参见公共数据结构 SessionSummary。 |
| 响应对象 | messages | SessionMessageSummary[] | 必填字段。 |
| 响应对象 | messageCount | number | 必填字段。 |
| 响应对象 | sessionRevision | string | 必填字段。 |
| 响应对象 | pendingQuestion | PersistedQuestion | 可选字段。 |

### `PATCH /api/sessions/:id`

更新指定会话的主题名称。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 路径参数 | id | string | 是 | URL 编码后的路径参数。 |
| 请求体 | name | string | 是 | 必填字段。 |
| 请求体 | generated | boolean | 否 | 可选字段。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | SessionSummary | 字段定义参见公共数据结构 SessionSummary。 |

### `DELETE /api/sessions/:id`

删除指定会话，并在必要时切换当前活跃会话。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 路径参数 | id | string | 是 | URL 编码后的路径参数。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | id | string | 必填字段。 |
| 响应对象 | deleted | true | 必填字段。 |
| 响应对象 | newActiveId | string 或 null | 必填字段。 |

### `POST /api/sessions/:id/activate`

将后端运行时切换到指定会话。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 路径参数 | id | string | 是 | URL 编码后的路径参数。 |

#### JSON 请求示例

无请求体时可省略请求体；如需传 JSON，可使用空对象。

```json
{}
```

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | id | string | 必填字段。 |
| 响应对象 | active | boolean | 必填字段。 |

### `POST /api/sessions/:id/archive`

把指定会话标记为已归档。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 路径参数 | id | string | 是 | URL 编码后的路径参数。 |

#### JSON 请求示例

无请求体时可省略请求体；如需传 JSON，可使用空对象。

```json
{}
```

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | id | string | 必填字段。 |
| 响应对象 | archived | true | 必填字段。 |

### `POST /api/sessions/:id/unarchive`

取消指定会话的归档标记。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 路径参数 | id | string | 是 | URL 编码后的路径参数。 |

#### JSON 请求示例

无请求体时可省略请求体；如需传 JSON，可使用空对象。

```json
{}
```

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | id | string | 必填字段。 |
| 响应对象 | archived | false | 必填字段。 |

### `GET /api/sessions/:id/export.md`

将指定会话导出为 Markdown 文件。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 路径参数 | id | string | 是 | URL 编码后的路径参数。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应体 | 文件内容 | binary | text/markdown 文件下载，文件名来自会话主题或 ID |

### `POST /api/sessions/:id/showcase-export`

把指定会话及相关工作区内容导出为可回放 showcase 案例。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 路径参数 | id | string | 是 | URL 编码后的路径参数。 |
| 请求体 | id | string | 否 | 可选字段。 |
| 请求体 | title | string | 否 | 可选字段。 |
| 请求体 | titleEn | string | 否 | 可选字段。 |
| 请求体 | description | string | 否 | 可选字段。 |
| 请求体 | tags | string[] | 否 | 可选字段。 |
| 请求体 | maxUserTurns | number | 否 | 可选字段。 |
| 请求体 | workspaceName | string | 否 | 可选字段。 |
| 请求体 | excludePaths | string[] | 否 | 可选字段。 |

#### JSON 请求示例

```json
{
  "id": "case-agent-demo",
  "title": "Agent 演示案例",
  "titleEn": "Agent Demo Case",
  "description": "展示一次完整会话回放",
  "tags": [
    "demo",
    "agent"
  ],
  "maxUserTurns": 8,
  "workspaceName": "demo-workspace",
  "excludePaths": [
    "node_modules",
    "runtime"
  ]
}
```

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | ok | true | 必填字段。 |
| 响应对象 | caseId | string | 必填字段。 |
| 响应对象 | title | string | 必填字段。 |
| 响应对象 | casesDir | string | 必填字段。 |

### `POST /api/sessions/:id/generate-topic`

为指定会话生成或刷新自动主题。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 路径参数 | id | string | 是 | URL 编码后的路径参数。 |

#### JSON 请求示例

无请求体时可省略请求体；如需传 JSON，可使用空对象。

```json
{}
```

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | SessionSummary | 字段定义参见公共数据结构 SessionSummary。 |

### `POST /api/sessions/:id/branch-before-message`

将会话分支回指定用户消息之前，用于编辑历史提问后重新生成。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 路径参数 | id | string | 是 | URL 编码后的路径参数。 |
| 请求体 | entryId | string | 是 | 必填字段。 |

#### JSON 请求示例

```json
{
  "entryId": "entry-001"
}
```

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | sessionId | string | 必填字段。 |
| 响应对象 | replacedEntryId | string | 必填字段。 |
| 响应对象 | branchMarkerId | string | 必填字段。 |
| 响应对象 | sessionRevision | string | 必填字段。 |

### `GET /api/sessions/:id/workspace`

查询指定会话当前绑定的工作区。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 路径参数 | id | string | 是 | URL 编码后的路径参数。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | sessionId | string | 必填字段。 |
| 响应对象 | workspaceId | string | 必填字段。 |
| 响应对象 | workspace | WorkspaceMeta 或 null | 必填字段。 |

### `PUT /api/sessions/:id/workspace`

将指定会话重新绑定到另一个工作区。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 路径参数 | id | string | 是 | URL 编码后的路径参数。 |
| 请求体 | workspaceId | string | 是 | 必填字段。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | sessionId | string | 必填字段。 |
| 响应对象 | workspaceId | string | 必填字段。 |

## Wiki 与 L2 原始资料

### `GET /api/wiki/pages`

列出 L2 Wiki 中的页面摘要和来源信息。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| — | 无 | — | — | 无请求参数或请求体。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 数组项 | path | string | Wiki 页面路径。 |
| 数组项 | frontmatter | object | 页面 frontmatter。 |
| 数组项 | bodyPreview | string | 页面正文预览。 |
| 数组项 | sourceId | string | 来源资料 ID。 |

### `GET /api/wiki/page`

读取指定 Wiki 页面完整 Markdown 内容。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 查询参数 | path | string | 是 | 必填字段。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | path | string | 必填字段。 |
| 响应对象 | content | string | 必填字段。 |

### `PUT /api/wiki/page`

保存指定 Wiki 页面内容，并更新检索索引。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 请求体 | path | string | 是 | 必填字段。 |
| 请求体 | content | string | 是 | 必填字段。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | path | string | 必填字段。 |
| 响应对象 | saved | true | 必填字段。 |

### `DELETE /api/wiki/page`

删除指定 Wiki 页面，并从 manifest 与检索索引中移除。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 查询参数 | path | string | 是 | 必填字段。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | path | string | 必填字段。 |
| 响应对象 | deleted | true | 必填字段。 |

### `GET /api/wiki/reviews`

列出 L2 入库过程中产生的待审核建议或冲突记录。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| — | 无 | — | — | 无请求参数或请求体。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | WikiIngestReview[] | 字段定义参见公共数据结构 WikiIngestReview。 |

### `GET /api/wiki/graph`

构建 Wiki 页面关系图和维护诊断信息。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| — | 无 | — | — | 无请求参数或请求体。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | WikiGraph | 字段定义参见公共数据结构 WikiGraph。 |

### `GET /api/wiki/stats`

统计 Wiki 页面数量、总大小和 manifest 条目数量。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| — | 无 | — | — | 无请求参数或请求体。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | pageCount | number | 必填字段。 |
| 响应对象 | totalSize | number | 必填字段。 |
| 响应对象 | entryCount | number | 必填字段。 |

### `POST /api/l2/raw/upload`

上传原始资料文件到 L2 raw 区，供后续归档或解析使用。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 请求体 | fileName | string | 是 | 必填字段。 |
| 请求体 | mimeType | string | 否 | 可选字段。 |
| 请求体 | dataBase64 | string | 是 | 必填字段。 |

#### JSON 请求示例

```json
{
  "fileName": "notes.md",
  "mimeType": "text/markdown",
  "dataBase64": "IyBOb3Rlcw=="
}
```

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | fileName | string | 必填字段。 |
| 响应对象 | mimeType | string | 必填字段。 |
| 响应对象 | size | number | 必填字段。 |
| 响应对象 | rawPath | string | 必填字段。 |

## 工作区文件接口

### `GET /api/workspace/tree`

读取指定工作区的文件树。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 查询参数 | workspaceId | string | 否 | 可选字段。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | root | string | 工作区根目录路径。 |
| 响应对象 | workspaceId | string | 工作区 ID。 |
| 响应对象 | tree | WorkspaceTreeNode | 根节点结构，字段见公共数据结构。 |

### `GET /api/workspace/file`

读取工作区文件的预览信息；文本直接返回内容，二进制返回访问 URL。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 查询参数 | workspaceId | string | 否 | 可选字段。 |
| 查询参数 | path | string | 是 | 必填字段。 |
| 查询参数 | forceText | 1 | 否 | 可选字段。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 文本响应 | path | string | 工作区相对路径。 |
| 文本响应 | name | string | 文件名。 |
| 文本响应 | kind | string | 文件类型。 |
| 文本响应 | mimeType | string | MIME 类型。 |
| 文本响应 | size | number | 文件大小。 |
| 文本响应 | updatedAt | string | 最后更新时间。 |
| 文本响应 | content | string | 文本文件内容。 |
| 二进制响应 | path | string | 工作区相对路径。 |
| 二进制响应 | name | string | 文件名。 |
| 二进制响应 | kind | string | 文件类型。 |
| 二进制响应 | format | string | 预览格式。 |
| 二进制响应 | mimeType | string | MIME 类型。 |
| 二进制响应 | size | number | 文件大小。 |
| 二进制响应 | updatedAt | string | 最后更新时间。 |
| 二进制响应 | url | string | 原始文件访问地址。 |
| 二进制响应 | previewUrl | string | 预览访问地址。 |

### `GET /api/workspace/raw`

读取工作区文件原始字节，可选择作为附件下载。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 查询参数 | workspaceId | string | 否 | 可选字段。 |
| 查询参数 | path | string | 是 | 必填字段。 |
| 查询参数 | download | 1 | 否 | 可选字段。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应体 | 文件字节 | binary | 原始文件内容，Content-Type 根据文件类型推断。 |

### `HEAD /api/workspace/raw`

读取工作区原始文件的响应头，不返回文件内容。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 查询参数 | workspaceId | string | 否 | 可选字段。 |
| 查询参数 | path | string | 是 | 必填字段。 |
| 查询参数 | download | 1 | 否 | 可选字段。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应头 | Content-Type | string | 响应头字段。 |
| 响应头 | Content-Length | string | 响应头字段。 |
| 响应头 | Cache-Control | string | 响应头字段。 |
| 响应头 | Content-Disposition | string | 可选响应头。 |

### `GET /api/workspace/download-folder`

将工作区目录打包为 zip 下载。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 查询参数 | workspaceId | string | 否 | 可选字段。 |
| 查询参数 | path | string | 否 | 可选字段；空 path 表示整个工作区。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应体 | 文件内容 | binary | application/zip 文件字节 |

### `HEAD /api/workspace/download-folder`

读取工作区目录 zip 下载的响应头，不返回 zip 内容。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 查询参数 | workspaceId | string | 否 | 可选字段。 |
| 查询参数 | path | string | 否 | 可选字段。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应头 | Content-Type | string | zip 文件的 MIME 类型。 |
| 响应头 | Content-Length | string | zip 文件大小。 |
| 响应头 | Content-Disposition | string | 下载文件名。 |

### `GET /api/workspace/office-preview`

解析 Office 或文档文件，返回文本预览和页级文本。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 查询参数 | workspaceId | string | 否 | 可选字段。 |
| 查询参数 | path | string | 是 | 必填字段。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | name | string | 必填字段。 |
| 响应对象 | pageCount | number | 可选字段。 |
| 响应对象 | text | string | 必填字段。 |
| 响应对象 | pages | PageText[] | 可选字段。 |

### `GET /api/workspace/pptx-preview`

将 PPTX 转换为每页 SVG，供前端幻灯片预览。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 查询参数 | workspaceId | string | 否 | 可选字段。 |
| 查询参数 | path | string | 是 | 必填字段。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | name | string | 必填字段。 |
| 响应对象 | slideCount | number | 必填字段。 |
| 响应对象 | slides | SlideSvg[] | 必填字段。 |
| 响应对象 | canvasPx | [number,number] | 可选字段。 |

### `PUT /api/workspace/file`

保存已有工作区文本文件内容。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 请求体 | workspaceId | string | 否 | 可选字段。 |
| 请求体 | path | string | 是 | 必填字段。 |
| 请求体 | content | string | 是 | 必填字段。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | path | string | 必填字段。 |
| 响应对象 | saved | true | 必填字段。 |
| 响应对象 | size | number | 必填字段。 |
| 响应对象 | updatedAt | string | 必填字段。 |

### `POST /api/workspace/create`

在工作区内创建文件或目录。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 请求体 | workspaceId | string | 否 | 可选字段。 |
| 请求体 | path | string | 是 | 必填字段。 |
| 请求体 | type | file 或 directory | 否 | 可选字段。 |

#### JSON 请求示例

```json
{
  "workspaceId": "default",
  "path": "notes/today.md",
  "type": "file"
}
```

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | WorkspaceTreeNode | 字段定义参见公共数据结构 WorkspaceTreeNode。 |

### `POST /api/workspace/rename`

重命名或移动工作区内的文件/目录到新路径。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 请求体 | workspaceId | string | 否 | 可选字段。 |
| 请求体 | oldPath | string | 是 | 必填字段。 |
| 请求体 | newPath | string | 是 | 必填字段。 |

#### JSON 请求示例

```json
{
  "workspaceId": "default",
  "oldPath": "notes/today.md",
  "newPath": "notes/today-renamed.md"
}
```

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | WorkspaceTreeNode | 字段定义参见公共数据结构 WorkspaceTreeNode。 |

### `POST /api/workspace/delete`

删除工作区内的文件或目录。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 请求体 | workspaceId | string | 否 | 可选字段。 |
| 请求体 | path | string | 是 | 必填字段。 |

#### JSON 请求示例

```json
{
  "workspaceId": "default",
  "path": "notes/today-renamed.md"
}
```

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | deleted | true | 必填字段。 |
| 响应对象 | path | string | 必填字段。 |

### `POST /api/workspace/move`

将工作区内文件或目录移动到目标目录下。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 请求体 | workspaceId | string | 否 | 可选字段。 |
| 请求体 | sourcePath | string | 是 | 必填字段。 |
| 请求体 | targetDir | string | 否 | 可选字段。 |

#### JSON 请求示例

```json
{
  "workspaceId": "default",
  "sourcePath": "notes/today.md",
  "targetDir": "archive"
}
```

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | WorkspaceTreeNode | 字段定义参见公共数据结构 WorkspaceTreeNode。 |

### `POST /api/workspace/upload`

批量上传文件到工作区；上传到 `.skills` 的 skill 包会自动安装。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 请求体 | workspaceId | string | 否 | 可选字段。 |
| 请求体 | files | Array | 是 | 待上传文件数组。 |
| 请求体 | files[].path | string | 是 | 文件写入的工作区相对路径。 |
| 请求体 | files[].dataBase64 | string | 是 | 文件内容的 Base64 编码。 |

#### JSON 请求示例

```json
{
  "workspaceId": "default",
  "files": [
    {
      "path": "uploads/example.txt",
      "dataBase64": "SGVsbG8="
    }
  ]
}
```

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | uploaded | WorkspaceTreeNode[] | 必填字段。 |

### `POST /api/workspace/skills/upload`

安装工作区私有 Skill 包到该工作区的 `.skills` 目录。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 请求体 | workspaceId | string | 否 | 可选字段。 |
| 请求体 | fileName | string | 是 | 必填字段。 |
| 请求体 | dataBase64 | string | 是 | 必填字段。 |

#### JSON 请求示例

```json
{
  "workspaceId": "default",
  "fileName": "my-skill.zip",
  "dataBase64": "UEsDBAoAAAAAA=="
}
```

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | WorkspaceTreeNode | 字段定义参见公共数据结构 WorkspaceTreeNode。 |

## 工作区注册表

### `GET /api/workspaces`

列出工作区注册表及每个工作区绑定的会话 ID。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| — | 无 | — | — | 无请求参数或请求体。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | WorkspaceWithSessions[] | 字段定义参见公共数据结构 WorkspaceWithSessions。 |

### `POST /api/workspaces`

创建一个新工作区，或在 isTemp=true 时返回共享临时工作区。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 请求体 | name | string | 否 | 可选字段。 |
| 请求体 | isTemp | boolean | 否 | 可选字段。 |

#### JSON 请求示例

```json
{
  "name": "新工作区",
  "isTemp": false
}
```

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | WorkspaceMeta | 字段定义参见公共数据结构 WorkspaceMeta。 |

### `PATCH /api/workspaces/:id`

重命名指定工作区。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 路径参数 | id | string | 是 | URL 编码后的路径参数。 |
| 请求体 | name | string | 是 | 必填字段。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | WorkspaceMeta | 字段定义参见公共数据结构 WorkspaceMeta。 |

### `DELETE /api/workspaces/:id`

删除指定工作区，可选择同时删除工作区文件。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 路径参数 | id | string | 是 | URL 编码后的路径参数。 |
| 查询参数 | removeFiles | 1 或 true | 否 | 可选字段。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | id | string | 必填字段。 |
| 响应对象 | deleted | true | 必填字段。 |
| 响应对象 | removedFiles | boolean | 必填字段。 |

## 终端与运行记录

### `POST /api/terminal/sessions`

为指定会话创建一个后端终端会话。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 请求体 | sessionId | string | 是 | 必填字段。 |
| 请求体 | workspaceId | string | 否 | 可选字段。 |
| 请求体 | cols | number | 否 | 可选字段。 |
| 请求体 | rows | number | 否 | 可选字段。 |

#### JSON 请求示例

```json
{
  "sessionId": "session-001",
  "workspaceId": "default",
  "cols": 120,
  "rows": 30
}
```

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | id | string | 必填字段。 |
| 响应对象 | sessionId | string | 必填字段。 |
| 响应对象 | workspaceId | string | 必填字段。 |
| 响应对象 | cwd | string | 必填字段。 |
| 响应对象 | status | ready | 必填字段。 |

### `POST /api/terminal/sessions/:id/close`

关闭指定终端会话。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 路径参数 | id | string | 是 | URL 编码后的路径参数。 |

#### JSON 请求示例

无请求体时可省略请求体；如需传 JSON，可使用空对象。

```json
{}
```

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | closed | true | 必填字段。 |

### `GET /api/runs`

列出指定会话最近的终端运行记录。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 查询参数 | sessionId | string | 是 | 必填字段。 |
| 查询参数 | limit | number | 否 | 可选字段。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | RunRecord[] | 字段定义参见公共数据结构 RunRecord。 |

### `GET /api/runs/:id`

读取指定终端运行记录及输出尾部。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 路径参数 | id | string | 是 | URL 编码后的路径参数。 |
| 查询参数 | lines | number | 否 | 可选字段。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 基础字段 | RunRecord | 字段定义参见公共数据结构 RunRecord。 |
| 响应对象 | outputTail | string | 必填字段。 |

### `POST /api/runs/:id/archive`

将指定终端运行记录归档为 Wiki 分析页面。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 路径参数 | id | string | 是 | URL 编码后的路径参数。 |
| 请求体 | title | string | 否 | 可选字段。 |
| 请求体 | note | string | 否 | 可选字段。 |

#### JSON 请求示例

```json
{
  "title": "构建失败分析",
  "note": "记录本次命令输出中的关键错误。"
}
```

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | path | string | 必填字段。 |
| 响应对象 | title | string | 必填字段。 |
| 响应对象 | runId | string | 必填字段。 |

### `WS /api/terminal/sessions/:id/ws`

连接指定终端会话的 WebSocket，用于交互输入、窗口 resize 和命令运行。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 路径参数 | id | string | 是 | URL 编码后的路径参数。 |
| WebSocket 客户端事件 | input | 事件 | 否 | 客户端可发送的终端事件。 |
| WebSocket 客户端事件 | resize | 事件 | 否 | 客户端可发送的终端事件。 |
| WebSocket 客户端事件 | run | 事件 | 否 | 客户端可发送的终端事件。 |
| WebSocket 客户端事件 | close | 事件 | 否 | 客户端可发送的终端事件。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| WebSocket 服务端事件 | ready | 事件 | 服务端推送的终端状态或输出事件。 |
| WebSocket 服务端事件 | output | 事件 | 服务端推送的终端状态或输出事件。 |
| WebSocket 服务端事件 | run_started | 事件 | 服务端推送的终端状态或输出事件。 |
| WebSocket 服务端事件 | exit | 事件 | 服务端推送的终端状态或输出事件。 |
| WebSocket 服务端事件 | error | 事件 | 服务端推送的终端状态或输出事件。 |

## Skills 与远程技能库

### `GET /api/skills`

列出项目级 Skill 的安装、启用、加载和诊断状态。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| — | 无 | — | — | 无请求参数或请求体。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | ProjectSkill[] | 字段定义参见公共数据结构 ProjectSkill。 |

### `POST /api/skills/upload`

上传并安装项目级 Skill 包。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 请求体 | fileName | string | 是 | 必填字段。 |
| 请求体 | dataBase64 | string | 是 | 必填字段。 |

#### JSON 请求示例

```json
{
  "fileName": "project-skill.zip",
  "dataBase64": "UEsDBAoAAAAAA=="
}
```

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 成功响应 | 响应对象 | ProjectSkill | 字段定义参见公共数据结构 ProjectSkill。 |
| 降级响应 | name | string | name:string |

### `POST /api/skills/reload`

请求后端重新加载 Skill 和相关资源。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| — | 无 | — | — | 无请求参数或请求体。 |

#### JSON 请求示例

无请求体时可省略请求体；如需传 JSON，可使用空对象。

```json
{}
```

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | reloaded | true | 必填字段。 |
| 响应对象 | skills | ProjectSkill[] | 必填字段。 |

### `PATCH /api/skills/:name`

启用或禁用指定项目级 Skill。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 路径参数 | name | string | 是 | URL 编码后的路径参数。 |
| 请求体 | enabled | boolean | 否 | 可选字段。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | ProjectSkill | 可能为空 | 成功时返回对象；未找到时可为空。 |

### `DELETE /api/skills/:name`

删除指定项目级 Skill 目录。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 路径参数 | name | string | 是 | URL 编码后的路径参数。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应体 | 无 | — | 成功时不返回响应体。 |

### `GET /api/skills/:name/content`

读取指定 Skill 的 `SKILL.md` 内容。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 路径参数 | name | string | 是 | URL 编码后的路径参数。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | name | string | 必填字段。 |
| 响应对象 | content | string | 必填字段。 |

### `PUT /api/skills/:name/content`

保存指定 Skill 的 `SKILL.md` 内容。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 路径参数 | name | string | 是 | URL 编码后的路径参数。 |
| 请求体 | content | string | 是 | 必填字段。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | name | string | 必填字段。 |
| 响应对象 | saved | true | 必填字段。 |

### `GET /api/skills/:name/tree`

读取指定 Skill 目录的文件树。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 路径参数 | name | string | 是 | URL 编码后的路径参数。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | WorkspaceTreeNode | 字段定义参见公共数据结构 WorkspaceTreeNode。 |

### `GET /api/skills/:name/file`

读取指定 Skill 内文件的预览信息。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 路径参数 | name | string | 是 | URL 编码后的路径参数。 |
| 查询参数 | path | string | 是 | 必填字段。 |
| 查询参数 | forceText | 1 | 否 | 可选字段。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 文本响应 | path | string | Skill 内相对路径。 |
| 文本响应 | name | string | 文件名。 |
| 文本响应 | kind | string | 文件类型。 |
| 文本响应 | mimeType | string | MIME 类型。 |
| 文本响应 | size | number | 文件大小。 |
| 文本响应 | updatedAt | string | 最后更新时间。 |
| 文本响应 | content | string | 文本内容。 |
| 二进制响应 | path | string | Skill 内相对路径。 |
| 二进制响应 | name | string | 文件名。 |
| 二进制响应 | kind | string | 文件类型。 |
| 二进制响应 | mimeType | string | MIME 类型。 |
| 二进制响应 | size | number | 文件大小。 |
| 二进制响应 | updatedAt | string | 最后更新时间。 |
| 二进制响应 | url | string | 二进制文件访问地址。 |

### `PUT /api/skills/:name/file`

保存指定 Skill 内已有文本文件内容。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 路径参数 | name | string | 是 | URL 编码后的路径参数。 |
| 请求体 | path | string | 是 | 必填字段。 |
| 请求体 | content | string | 是 | 必填字段。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | path | string | 必填字段。 |
| 响应对象 | saved | true | 必填字段。 |
| 响应对象 | size | number | 必填字段。 |
| 响应对象 | updatedAt | string | 必填字段。 |

### `GET /api/skills/:name/raw`

读取指定 Skill 内文件的原始字节。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 路径参数 | name | string | 是 | URL 编码后的路径参数。 |
| 查询参数 | path | string | 是 | 必填字段。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应体 | 文件字节 | binary | 原始文件内容，Content-Type 根据文件类型推断。 |

### `GET /api/skill-library`

列出远程 Skill 库，并标记本地是否已安装。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 查询参数 | refresh | 1 | 否 | 可选字段。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | SkillLibraryItem[] | 字段定义参见公共数据结构 SkillLibraryItem。 |

### `POST /api/skill-library/import`

从远程 Skill 库下载安装到项目级 Skill 目录。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 请求体 | name | string | 是 | 必填字段。 |

#### JSON 请求示例

```json
{
  "name": "research-assistant"
}
```

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 成功响应 | 响应对象 | ProjectSkill | 字段定义参见公共数据结构 ProjectSkill。 |
| 降级响应 | name | string | name:string |

## 预设工作区

### `GET /api/presets`

列出本地缓存或内置的预设工作区。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| — | 无 | — | — | 无请求参数或请求体。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | PresetMeta[] | 字段定义参见公共数据结构 PresetMeta。 |

### `GET /api/preset-library`

列出远程内容中心提供的预设工作区。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 查询参数 | refresh | 1 | 否 | 可选字段。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | PresetMeta[] | 字段定义参见公共数据结构 PresetMeta。 |

## 设置接口

### `GET /api/settings`

读取当前应用设置，敏感字段会脱敏。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| — | 无 | — | — | 无请求参数或请求体。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | SafeSettings | 字段定义参见公共数据结构 SafeSettings。 |

### `POST /api/settings/model`

切换默认模型提供商和模型。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 请求体 | provider | string | 是 | 必填字段。 |
| 请求体 | model | string | 是 | 必填字段。 |

#### JSON 请求示例

```json
{
  "provider": "openai",
  "model": "gpt-4.1"
}
```

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | defaultProvider | string | 必填字段。 |
| 响应对象 | defaultModel | string | 必填字段。 |

### `PUT /api/settings/providers`

新增或更新模型提供商配置。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 请求体 | providerId | string | 是 | 必填字段。 |
| 请求体 | baseUrl | string | 是 | 必填字段。 |
| 请求体 | apiKey | string | 否 | 可选字段。 |
| 请求体 | api | string | 否 | 可选字段。 |
| 请求体 | headers | string map | 否 | 可选字段。 |
| 请求体 | authHeader | boolean | 否 | 可选字段。 |
| 请求体 | bypassProxy | boolean | 否 | 可选字段。 |
| 请求体 | models | InnoModelConfig[] | 是 | 必填字段。 |
| 请求体 | makeDefault | boolean | 否 | 可选字段。 |
| 请求体 | preserveApiKey | boolean | 否 | 可选字段。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | SafeSettings | 字段定义参见公共数据结构 SafeSettings。 |

### `POST /api/settings/providers`

新增或更新模型提供商配置，行为与 PUT 一致。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 请求体 | providerId | string | 是 | 必填字段。 |
| 请求体 | baseUrl | string | 是 | 必填字段。 |
| 请求体 | apiKey | string | 否 | 可选字段。 |
| 请求体 | api | string | 否 | 可选字段。 |
| 请求体 | headers | string map | 否 | 可选字段。 |
| 请求体 | authHeader | boolean | 否 | 可选字段。 |
| 请求体 | bypassProxy | boolean | 否 | 可选字段。 |
| 请求体 | models | InnoModelConfig[] | 是 | 必填字段。 |
| 请求体 | makeDefault | boolean | 否 | 可选字段。 |
| 请求体 | preserveApiKey | boolean | 否 | 可选字段。 |

#### JSON 请求示例

```json
{
  "providerId": "openai",
  "baseUrl": "https://api.openai.com/v1",
  "apiKey": "sk-***",
  "api": "openai",
  "headers": {},
  "authHeader": true,
  "bypassProxy": false,
  "models": [
    {
      "id": "gpt-4.1",
      "name": "GPT-4.1"
    }
  ],
  "makeDefault": true,
  "preserveApiKey": false
}
```

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | SafeSettings | 字段定义参见公共数据结构 SafeSettings。 |

### `PATCH /api/settings/providers`

新增或更新模型提供商配置，行为与 PUT 一致。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 请求体 | providerId | string | 是 | 必填字段。 |
| 请求体 | baseUrl | string | 是 | 必填字段。 |
| 请求体 | apiKey | string | 否 | 可选字段。 |
| 请求体 | api | string | 否 | 可选字段。 |
| 请求体 | headers | string map | 否 | 可选字段。 |
| 请求体 | authHeader | boolean | 否 | 可选字段。 |
| 请求体 | bypassProxy | boolean | 否 | 可选字段。 |
| 请求体 | models | InnoModelConfig[] | 是 | 必填字段。 |
| 请求体 | makeDefault | boolean | 否 | 可选字段。 |
| 请求体 | preserveApiKey | boolean | 否 | 可选字段。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | SafeSettings | 字段定义参见公共数据结构 SafeSettings。 |

### `POST /api/settings/providers/probe-models`

服务端探测提供商可用模型列表，避免浏览器直接暴露 API Key。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 请求体 | baseUrl | string | 是 | 必填字段。 |
| 请求体 | apiKey | string | 否 | 可选字段。 |
| 请求体 | api | string | 否 | 可选字段。 |
| 请求体 | providerId | string | 否 | 可选字段。 |

#### JSON 请求示例

```json
{
  "baseUrl": "https://api.openai.com/v1",
  "apiKey": "sk-***",
  "api": "openai",
  "providerId": "openai"
}
```

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | models | string[] | 必填字段。 |

### `DELETE /api/settings/providers/:providerId/models/:modelId`

从指定提供商配置中删除一个模型。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 路径参数 | providerId | string | 是 | URL 编码后的路径参数。 |
| 路径参数 | modelId | string | 是 | URL 编码后的路径参数。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | SafeSettings | 字段定义参见公共数据结构 SafeSettings。 |

### `DELETE /api/settings/providers/:providerId`

删除指定模型提供商配置。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 路径参数 | providerId | string | 是 | URL 编码后的路径参数。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | SafeSettings | 字段定义参见公共数据结构 SafeSettings。 |

### `PUT /api/settings/channels`

更新飞书、QQ、微信和 bridge 相关渠道配置。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 请求体 | feishu | object | 否 | 飞书应用配置对象。 |
| 请求体 | feishu.appId | string | 否 | 飞书应用 ID。 |
| 请求体 | feishu.appSecret | string | 否 | 飞书应用密钥。 |
| 请求体 | channels | object | 否 | 消息渠道配置对象。 |
| 请求体 | channels.feishu | object | 否 | 飞书渠道配置。 |
| 请求体 | channels.qq | object | 否 | QQ 渠道配置。 |
| 请求体 | channels.wechat | object | 否 | 微信渠道配置。 |
| 请求体 | bridge | object | 否 | bridge 配置对象。 |
| 请求体 | bridge.token | string | 否 | bridge sidecar 鉴权 token。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | SafeSettings | 字段定义参见公共数据结构 SafeSettings。 |

### `PUT /api/settings/memory`

更新 L1/L2/L3 记忆层开关。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 请求体 | l1Enabled | boolean | 否 | 可选字段。 |
| 请求体 | l2Enabled | boolean | 否 | 可选字段。 |
| 请求体 | l3Enabled | boolean | 否 | 可选字段。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | SafeSettings | 字段定义参见公共数据结构 SafeSettings。 |

### `PUT /api/settings/simple-mode`

开启或关闭 Simple Mode。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 请求体 | enabled | boolean | 是 | 必填字段。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | SafeSettings | 字段定义参见公共数据结构 SafeSettings。 |

### `PUT /api/settings/smart-input`

更新便捷输入规则和相关开关。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 请求体 | enabled | boolean | 是 | 是否启用便捷输入。 |
| 请求体 | allowDrag | boolean | 是 | 是否允许拖拽文件。 |
| 请求体 | allowRightClick | boolean | 是 | 是否允许右键绑定文件。 |
| 请求体 | allowAgentCommands | boolean | 是 | 是否将 Agent 命令转换为输入气泡。 |
| 请求体 | rules | SmartInputRule[] | 是 | 关键词与文件扩展名规则。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | SafeSettings | 字段定义参见公共数据结构 SafeSettings。 |

### `PUT /api/settings/mcp`

更新 MCP 总开关；通常需要重启后完全生效。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 请求体 | enabled | boolean | 是 | 必填字段。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | SafeSettings | 字段定义参见公共数据结构 SafeSettings。 |

### `PUT /api/settings/github`

更新 GitHub token，用于远程内容中心访问。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 请求体 | token | string | 是 | 传入 masked 值时保留已配置的 token。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | SafeSettings | 字段定义参见公共数据结构 SafeSettings。 |

### `PUT /api/settings/ocr`

更新 OCR API token、模型和 base URL。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 请求体 | token | string | 是 | 必填字段。 |
| 请求体 | model | string | 否 | 可选字段。 |
| 请求体 | baseUrl | string | 否 | 可选字段。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | SafeSettings | 字段定义参见公共数据结构 SafeSettings。 |

### `PUT /api/settings/tavily`

更新内置 Tavily web_search 工具的 API Key。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 请求体 | apiKey | string | 是 | 必填字段。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | SafeSettings | 字段定义参见公共数据结构 SafeSettings。 |

### `GET /api/settings/web-access`

读取 pi-web-access 的搜索/验证 provider 配置视图。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| — | 无 | — | — | 无请求参数或请求体。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | WebAccessSettingsView | 字段定义参见公共数据结构 WebAccessSettingsView。 |

### `PUT /api/settings/web-access`

更新 pi-web-access 默认 provider 和各 provider 凭据。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 请求体 | provider | string | 否 | 可选字段。 |
| 请求体 | values | 按 provider id 分组的 string map | 否 | 可选字段。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | WebAccessSettingsView | 字段定义参见公共数据结构 WebAccessSettingsView。 |

### `PUT /api/settings/content-hub`

更新远程内容中心配置，影响 Skill 库和预设工作区来源。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 请求体 | type | github 或 bundle | 否 | 可选字段。 |
| 请求体 | owner | string | 否 | 可选字段。 |
| 请求体 | repo | string | 否 | 可选字段。 |
| 请求体 | ref | string | 否 | 可选字段。 |
| 请求体 | skillsPath | string | 否 | 可选字段。 |
| 请求体 | presetsPath | string | 否 | 可选字段。 |
| 请求体 | baseUrl | string | 否 | 可选字段。 |
| 请求体 | token | string | 否 | 可选字段。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | SafeSettings | 字段定义参见公共数据结构 SafeSettings。 |

### `PUT /api/settings/theme`

更新 UI 主题偏好。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 请求体 | theme | light、warm、ocean 或 innospark | 是 | 枚举值。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | SafeSettings | 字段定义参见公共数据结构 SafeSettings。 |

### `PUT /api/settings/close-behavior`

更新桌面窗口关闭行为偏好。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 请求体 | closeBehavior | ask、hide 或 quit | 是 | 枚举值。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | SafeSettings | 字段定义参见公共数据结构 SafeSettings。 |

## MCP 接口

### `GET /api/mcp`

读取 MCP 总览，包括启用状态、配置来源、服务器定义和运行态快照。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| — | 无 | — | — | 无请求参数或请求体。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | McpOverview | 字段定义参见公共数据结构 McpOverview。 |

### `PUT /api/mcp/servers/:name`

新增或覆盖 managed MCP 配置中的一个服务器定义。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 路径参数 | name | string | 是 | URL 编码后的路径参数。 |
| 请求体 | 请求对象 | McpServerEntry | 是 | 请求体使用该公共数据结构。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | McpOverview | 字段定义参见公共数据结构 McpOverview。 |

### `PATCH /api/mcp/servers/:name`

启用或禁用 managed MCP 配置中的指定服务器。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 路径参数 | name | string | 是 | URL 编码后的路径参数。 |
| 请求体 | disabled | boolean | 是 | 必填字段。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | McpOverview | 字段定义参见公共数据结构 McpOverview。 |

### `DELETE /api/mcp/servers/:name`

从 managed MCP 配置中删除指定服务器。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 路径参数 | name | string | 是 | URL 编码后的路径参数。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | McpOverview | 字段定义参见公共数据结构 McpOverview。 |

## 渠道接口

### `GET /api/channels`

列出当前已注册并启用的消息渠道。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| — | 无 | — | — | 无请求参数或请求体。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 数组项 | name | ChannelName | 渠道名称。 |
| 数组项 | mode | native 或 bridge | 渠道运行模式。 |
| 数组项 | enabled | boolean | 是否启用。 |
| 数组项 | hasDefaultTarget | boolean | 是否已配置默认目标。 |

### `POST /api/channels/:name/default-target`

设置指定渠道的默认推送目标会话或聊天 ID。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 路径参数 | name | string | 是 | URL 编码后的路径参数。 |
| 请求体 | chatId | string | 是 | 必填字段。 |

#### JSON 请求示例

```json
{
  "chatId": "chat-001"
}
```

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | channel | string | 必填字段。 |
| 响应对象 | chatId | string | 必填字段。 |

### `POST /api/channels/:name/test`

向指定渠道的默认目标发送一条测试消息。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 路径参数 | name | string | 是 | URL 编码后的路径参数。 |
| 请求体 | text | string | 否 | 可选字段。 |

#### JSON 请求示例

```json
{
  "text": "这是一条测试消息"
}
```

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | channel | string | 必填字段。 |
| 响应对象 | chatId | string | 必填字段。 |
| 响应对象 | pushed | true | 必填字段。 |

### `GET /api/channels/:name/health`

检查指定渠道健康状态；bridge 渠道会探测 sidecar。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 路径参数 | name | string | 是 | URL 编码后的路径参数。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | channel | string | 必填字段。 |
| 响应对象 | mode | native 或 bridge | 必填字段。 |
| 响应对象 | healthy | boolean | 必填字段。 |
| 响应对象 | checkedAt | string | 必填字段。 |
| 响应对象 | sidecarUrl | string | 可选，bridge sidecar 地址。 |
| 响应对象 | error | string | 可选，健康检查失败原因。 |

### `POST /api/bridge/messages`

接收 QQ/微信 bridge sidecar 推送的入站消息，并异步交给个人渠道调度器处理。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| Header | Authorization | Bearer token | 是 | 用于 bridge sidecar 的鉴权。 |
| 请求体 | channel | qq 或 wechat | 是 | 必填字段。 |
| 请求体 | messageId | string | 是 | 必填字段。 |
| 请求体 | chatId | string | 是 | 必填字段。 |
| 请求体 | userId | string | 是 | 必填字段。 |
| 请求体 | text | string | 是 | 必填字段。 |
| 请求体 | attachments | BridgeAttachment[] | 否 | 可选字段。 |
| 请求体 | raw | unknown | 否 | 可选字段。 |

#### JSON 请求示例

```json
{
  "channel": "wechat",
  "messageId": "msg-001",
  "chatId": "chat-001",
  "userId": "user-001",
  "text": "帮我总结今天的学习内容",
  "attachments": [],
  "raw": {}
}
```

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 成功响应 | ok | true | 消息已接受。 |
| 失败响应 | ok | false | 消息处理失败。 |
| 失败响应 | error | string | 失败原因。 |

### `POST /api/channels/feishu/qr-register`

启动飞书设备码/二维码授权注册流程。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| — | 无 | — | — | 无请求参数或请求体。 |

#### JSON 请求示例

无请求体时可省略请求体；如需传 JSON，可使用空对象。

```json
{}
```

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | deviceCode | string | 必填字段。 |
| 响应对象 | qrUrl | string | 必填字段。 |
| 响应对象 | expiresIn | number | 必填字段。 |
| 响应对象 | interval | number | 必填字段。 |

### `GET /api/channels/feishu/qr-status`

轮询飞书设备码授权状态，确认后保存飞书配置。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 查询参数 | deviceCode | string | 是 | 必填字段。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | status | string | 必填字段。 |

### `POST /api/channels/wechat/qr-login`

生成微信 iLink 登录二维码。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| — | 无 | — | — | 无请求参数或请求体。 |

#### JSON 请求示例

无请求体时可省略请求体；如需传 JSON，可使用空对象。

```json
{}
```

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | qrId | string | 必填字段。 |
| 响应对象 | qrUrl | string | 必填字段。 |

### `GET /api/channels/wechat/qr-status`

轮询微信 iLink 二维码登录状态。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 查询参数 | qrId | string | 是 | 必填字段。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | status | string | 必填字段。 |
| 响应对象 | botId | string | 可选字段。 |

### `GET /api/channels/wechat/status`

查询微信渠道当前配置、连接和登录状态。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| — | 无 | — | — | 无请求参数或请求体。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | configured | boolean | 必填字段。 |
| 响应对象 | connected | boolean | 必填字段。 |
| 响应对象 | botId | string | 可选字段。 |
| 响应对象 | loggedIn | boolean | 可选字段。 |

### `GET /api/channels/runs`

列出个人渠道消息处理运行日志。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| — | 无 | — | — | 无请求参数或请求体。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | ChannelRun[] | 字段定义参见公共数据结构 ChannelRun。 |

## 定时任务接口

### `GET /api/jobs`

列出所有定时任务。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| — | 无 | — | — | 无请求参数或请求体。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | ScheduledJob[] | 字段定义参见公共数据结构 ScheduledJob。 |

### `POST /api/jobs`

创建一个新的定时任务。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 请求体 | name | string | 否 | 可选字段。 |
| 请求体 | cron | string | 是 | 必填字段。 |
| 请求体 | timezone | string | 否 | 可选字段。 |
| 请求体 | enabled | boolean | 否 | 可选字段。 |
| 请求体 | channel | ChannelName | 否 | 可选字段。 |
| 请求体 | target | PushTarget | 否 | 可选字段。 |
| 请求体 | taskType | TaskType | 否 | 可选字段。 |
| 请求体 | prompt | string | 是 | 必填字段。 |

#### JSON 请求示例

```json
{
  "name": "每日学习提醒",
  "cron": "0 9 * * *",
  "timezone": "Asia/Shanghai",
  "enabled": true,
  "channel": "feishu",
  "target": {
    "chatId": "chat-001"
  },
  "taskType": "push_reminder",
  "prompt": "生成今日学习计划"
}
```

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | ScheduledJob | 字段定义参见公共数据结构 ScheduledJob。 |

### `PATCH /api/jobs/:id`

更新指定定时任务配置。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 路径参数 | id | string | 是 | URL 编码后的路径参数。 |
| 请求体 | name | string | 否 | 可选更新字段。 |
| 请求体 | cron | string | 否 | 可选更新字段。 |
| 请求体 | timezone | string | 否 | 可选更新字段。 |
| 请求体 | enabled | boolean | 否 | 可选更新字段。 |
| 请求体 | channel | ChannelName | 否 | 可选更新字段。 |
| 请求体 | target | PushTarget | 否 | 可选更新字段。 |
| 请求体 | taskType | TaskType | 否 | 可选更新字段。 |
| 请求体 | prompt | string | 否 | 可选更新字段。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | ScheduledJob | 字段定义参见公共数据结构 ScheduledJob。 |

### `DELETE /api/jobs/:id`

删除指定定时任务。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 路径参数 | id | string | 是 | URL 编码后的路径参数。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应体 | 无 | — | 成功时不返回响应体。 |

### `POST /api/jobs/:id/run`

立即手动触发指定定时任务执行。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 路径参数 | id | string | 是 | URL 编码后的路径参数。 |

#### JSON 请求示例

无请求体时可省略请求体；如需传 JSON，可使用空对象。

```json
{}
```

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | JobRunResult | 字段定义参见公共数据结构 JobRunResult。 |

### `GET /api/jobs/status`

读取定时任务总体状态统计。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| — | 无 | — | — | 无请求参数或请求体。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | total | number | 必填字段。 |
| 响应对象 | enabled | number | 必填字段。 |
| 响应对象 | disabled | number | 必填字段。 |
| 响应对象 | running | number | 必填字段。 |
| 响应对象 | failed | number | 必填字段。 |
| 响应对象 | nextRunAt | string | 可选字段。 |

### `GET /api/jobs/runs`

列出所有定时任务的最近运行记录。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| — | 无 | — | — | 无请求参数或请求体。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | JobRunRecord[] | 字段定义参见公共数据结构 JobRunRecord。 |

### `GET /api/jobs/:id/runs`

列出指定定时任务的最近运行记录。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 路径参数 | id | string | 是 | URL 编码后的路径参数。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | JobRunRecord[] | 字段定义参见公共数据结构 JobRunRecord。 |

## 学习者画像接口

### `GET /api/learner/profile`

读取 L1 学习者画像。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| — | 无 | — | — | 无请求参数或请求体。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | LearnerProfile | 字段定义参见公共数据结构 LearnerProfile。 |

### `PATCH /api/learner/profile`

更新学习者画像摘要和偏好。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 请求体 | profile_summary | string | 否 | 可选字段。 |
| 请求体 | preferences | object | 否 | 学习偏好对象。 |
| 请求体 | preferences.explanation_style | string[] | 否 | 讲解风格偏好。 |
| 请求体 | preferences.practice_style | string[] | 否 | 练习方式偏好。 |
| 请求体 | preferences.feedback_tone | string[] | 否 | 反馈语气偏好。 |
| 请求体 | preferences.avoid | string[] | 否 | 需要避免的表达或方式。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | LearnerProfile | 字段定义参见公共数据结构 LearnerProfile。 |

### `POST /api/learner/profile/goals`

新增一个学习目标。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 请求体 | title | string | 否 | 可选字段。 |
| 请求体 | type | goal type | 否 | 可选字段。 |
| 请求体 | priority | number | 否 | 可选字段。 |
| 请求体 | status | goal status | 否 | 可选字段。 |
| 请求体 | success_criteria | string[] | 否 | 可选字段。 |

#### JSON 请求示例

```json
{
  "title": "掌握 TypeScript 类型系统",
  "type": "skill",
  "priority": 2,
  "status": "active",
  "success_criteria": [
    "完成泛型练习",
    "能解释条件类型"
  ]
}
```

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | LearningGoal | 字段定义参见公共数据结构 LearningGoal。 |

### `PATCH /api/learner/profile/goals/:goalId`

更新指定学习目标。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 路径参数 | goalId | string | 是 | URL 编码后的路径参数。 |
| 请求体 | title | string | 否 | 可选更新字段。 |
| 请求体 | type | skill、concept、project、exam 或 habit | 否 | 可选更新字段。 |
| 请求体 | priority | number | 否 | 可选更新字段。 |
| 请求体 | status | active、paused、completed 或 archived | 否 | 可选更新字段。 |
| 请求体 | success_criteria | string[] | 否 | 可选更新字段。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | LearningGoal | 字段定义参见公共数据结构 LearningGoal。 |

### `DELETE /api/learner/profile/goals/:goalId`

删除指定学习目标。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 路径参数 | goalId | string | 是 | URL 编码后的路径参数。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | deleted | true | 必填字段。 |

### `PATCH /api/learner/profile/knowledge/:conceptId`

人工更新指定概念的知识状态。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 路径参数 | conceptId | string | 是 | URL 编码后的路径参数。 |
| 请求体 | mastery | number | 否 | 可选字段。 |
| 请求体 | confidence | number | 否 | 可选字段。 |
| 请求体 | stability | number | 否 | 可选字段。 |
| 请求体 | diagnosis | string | 否 | 可选字段。 |
| 请求体 | next_actions | string[] | 否 | 可选字段。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | KnowledgeState | 字段定义参见公共数据结构 KnowledgeState。 |

### `PATCH /api/learner/profile/misconceptions/:miscId`

人工更新指定误区记录。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 路径参数 | miscId | string | 是 | URL 编码后的路径参数。 |
| 请求体 | status | string | 否 | 可选字段。 |
| 请求体 | severity | number | 否 | 可选字段。 |
| 请求体 | repair_strategy | string | 否 | 可选字段。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | 响应对象 | Misconception | 字段定义参见公共数据结构 Misconception。 |

## 命令接口

### `GET /api/commands`

列出 Web 输入框可补全或可发送的 slash commands。

#### 请求字段

| 位置 | 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| — | 无 | — | — | 无请求参数或请求体。 |

#### 返回字段

| 响应位置 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 响应对象 | commands | SlashCommandItem[] | 必填字段。 |
