# Inno Agent 开发设计文档

## 1. 项目目标

Inno Agent 是一个基于 Pi SDK 的个人学习 agent。它不是重新实现一个 agent 框架，而是在 Pi 的模型调用、工具调用、会话管理和扩展机制之上，增加面向个人学习场景的长期记忆、知识归档、IM 接入和定时任务能力。

核心目标：

- 通过学习者画像持续理解用户的目标、能力状态、误区、偏好和复习节奏。
- 直接接入成熟的 Graphify 项目，将学习内容、项目知识、笔记和资料归档为可查询的 Wiki / graph 知识库。
- 复用 Pi 自带会话记录保存近期上下文、工具调用和分支历史。
- 接入个人 IM 消息源。第一阶段聚焦微信、飞书、QQ 三个私聊入口，不做群聊；具体落地方案见 `personal-im-channel-design.md`。
- 支持定时任务，用于学习复盘、知识库更新、画像反思和消息推送。

## 2. 总体架构

```text
用户入口
  ├── CLI
  ├── Web UI / 管理前端（预留）
  ├── 飞书私聊
  ├── QQ 私聊
  └── 微信私聊入口

        ↓

Inno Agent 应用层
  ├── Channel Adapter
  ├── API Server（预留给前端）
  ├── Pi Session Manager
  ├── Memory Orchestrator
  ├── Scheduler
  └── Notification Service

        ↓

Pi SDK
  ├── createAgentSession()
  ├── AgentSession
  ├── customTools
  ├── SessionManager
  └── extensions

        ↓

三层记忆系统
  ├── L1 学习者画像记忆
  ├── L2 Graphify Wiki 知识库
  └── L3 Pi 会话记录
```

设计原则：

- 不修改 Pi 内核，优先通过 SDK、extension、custom tools 组合能力。
- L1 存学习者状态，不存无边界聊天记录。
- L2 存知识内容和知识关系，不替代对话上下文。
- L3 交给 Pi SessionManager 管理。
- 当前按单用户系统设计，不做多用户权限、租户隔离和用户画像分片。
- 各 IM 平台通过统一 Channel 接口接入，但最终都映射到同一个个人 agent。IM 接入按个人私聊消息源设计，不做群聊。
- 定时任务作为独立长期运行服务，不依赖 CLI session 常驻。

## 3. 推荐目录结构

```text
inno-agent/
├── docs/
│   ├── learner-profile-memory-design.md
│   └── inno-agent-development-design.md
├── src/
│   ├── cli.ts
│   ├── config.ts
│   ├── agent/
│   │   ├── pi-session-manager.ts
│   │   ├── pi-runner.ts
│   │   └── system-prompt.ts
│   ├── memory/
│   │   ├── learner/
│   │   │   ├── learner-profile.ts
│   │   │   ├── learning-event.ts
│   │   │   ├── profile-updater.ts
│   │   │   ├── context-pack.ts
│   │   │   └── learner-tools.ts
│   │   ├── graphify/
│   │   │   ├── graphify-store.ts
│   │   │   ├── graphify-runner.ts
│   │   │   └── graphify-tools.ts
│   │   └── conversation/
│   │       └── pi-session-store.ts
│   ├── channels/
│   │   ├── channel.ts
│   │   ├── feishu.ts
│   │   ├── qq.ts
│   │   ├── wechat.ts
│   │   └── wecom.ts
│   ├── scheduler/
│   │   ├── scheduler.ts
│   │   ├── job-store.ts
│   │   ├── job-runner.ts
│   │   └── built-in-jobs.ts
│   ├── api/
│   │   ├── server.ts
│   │   ├── routes-memory.ts
│   │   ├── routes-wiki.ts
│   │   └── routes-jobs.ts
│   ├── storage/
│   │   ├── file-store.ts
│   │   └── schema.ts
│   └── extensions/
│       ├── learner-memory.ts
│       ├── graphify-memory.ts
│       ├── feishu-notifier.ts
│       ├── ollama-provider.ts
│       ├── tavily-search.ts
│       └── mcp-client.ts
└── data/
    ├── learner/
    ├── graphify/
    │   ├── input/
    │   └── out/
    ├── jobs/
    └── sessions/default/
```

## 4. Pi SDK 集成方式

### 4.1 Session 管理

Inno Agent 当前按单用户系统设计，只维护一个默认个人 session。飞书、CLI、未来 Web 前端都进入同一个个人学习上下文。后续如确实需要多用户，再把 session key 扩展为 channel/user/chat。

```text
default -> AgentSession
```

示例：

```ts
import {
	createAgentSession,
	SessionManager,
	type AgentSession,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

interface InnoSessionOptions {
	cwd: string;
	tools: ToolDefinition[];
}

export async function createInnoSession(options: InnoSessionOptions): Promise<AgentSession> {
	const sessionDir = "data/sessions/default";

	const { session } = await createAgentSession({
		cwd: options.cwd,
		sessionManager: SessionManager.create(options.cwd, sessionDir),
		customTools: options.tools,
	});

	await session.bindExtensions({});
	return session;
}
```

### 4.2 流式输出收集

飞书、微信等平台通常不适合逐 token 推送。第一版建议收集完整输出后回复：

```ts
export async function runPrompt(session: AgentSession, prompt: string): Promise<string> {
	let output = "";

	const unsubscribe = session.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			output += event.assistantMessageEvent.delta;
		}
	});

	await session.prompt(prompt);
	unsubscribe();

	return output.trim();
}
```

### 4.3 自定义工具注册

Inno Agent 的 L1、L2、通知、定时任务都应暴露为 Pi custom tools 或 extension tools：

```text
L1:
  get_learner_context
  record_learning_event
  update_learner_profile
  review_learner_profile

L2:
  archive_learning_note
  run_graphify_build
  query_graphify
  open_graphify_report

Scheduler:
  create_scheduled_job
  list_scheduled_jobs
  run_scheduled_job
  disable_scheduled_job

Channel:
  send_feishu_message
```

## 5. 三层记忆系统

## 5.1 L1 学习者画像记忆

L1 是 Inno Agent 的核心差异化能力。它不是简单的用户偏好文件，而是一个证据驱动、可解释、可修正、时间敏感的开放学习者模型。

L1 要回答：

- 学习者想学什么，目标优先级是什么。
- 学习者已经掌握什么，正在学习什么，容易误解什么。
- 学习者适合怎样的练习粒度、讲解方式和复习节奏。
- 当前最应该推荐什么学习行动。
- 每条画像判断来自哪些证据，可信度如何，是否已经过期。

### 5.1.1 L1 内部分层

```text
学习事件层 Episodic Learning Memory
  记录真实发生过什么

        ↓

画像抽取与更新 Profile Extraction & Update
  从事件中提取目标、概念、错因、偏好、情绪、自评等信号

        ↓

学习者画像层 Learner Profile Memory
  保存目标、知识状态、误区、行为、动机、偏好、证据和置信度

        ↓

教学决策层 Pedagogical Policy
  决定讲解、练习、复习、追问、反馈、资源推荐
```

### 5.1.2 LearnerProfile 数据模型

```ts
export interface LearnerProfile {
	learner_id: string;
	version: number;
	updated_at: string;
	constraints: LearnerConstraints;
	goals: LearningGoal[];
	knowledge_states: KnowledgeState[];
	misconceptions: Misconception[];
	learning_behaviors: LearningBehaviors;
	self_regulation: SelfRegulation;
	motivation_affect: MotivationAffect;
	preferences: LearnerPreferences;
	profile_summary: string;
	evidence_index: EvidenceIndexEntry[];
}
```

### 5.1.3 基本约束

```ts
export interface LearnerConstraints {
	available_time?: {
		weekday_minutes?: number;
		weekend_minutes?: number;
		preferred_sessions?: Array<"morning" | "afternoon" | "evening" | "night">;
	};
	language?: string[];
	device_context?: string[];
	privacy: {
		allow_long_term_memory: boolean;
		allow_sensitive_inference: boolean;
		retention_days: number;
	};
}
```

### 5.1.4 学习目标

```ts
export interface LearningGoal {
	goal_id: string;
	title: string;
	type: "skill" | "concept" | "project" | "exam" | "habit";
	priority: number;
	status: "active" | "paused" | "completed" | "archived";
	target_date?: string | null;
	success_criteria: string[];
	source: "user_declared" | "agent_inferred" | "imported";
	updated_at: string;
}
```

### 5.1.5 知识状态

知识状态应按概念维护，而不是只按课程或章节维护。

```ts
export interface KnowledgeState {
	concept_id: string;
	concept_name: string;
	domain: string;
	mastery: number;
	confidence: number;
	stability: number;
	last_practiced_at?: string;
	review_due_at?: string;
	evidence_ids: string[];
	diagnosis: string;
	next_actions: string[];
}
```

字段含义：

- `mastery`：当前掌握度，0 到 1。
- `confidence`：系统对掌握度判断的信心。
- `stability`：记忆稳定性，用于间隔复习。
- `review_due_at`：下次复习时间。
- `diagnosis`：面向教学决策的短诊断。

### 5.1.6 误区模型

```ts
export interface Misconception {
	misconception_id: string;
	concept_id: string;
	description: string;
	status: "active" | "repairing" | "resolved" | "stale";
	severity: number;
	confidence: number;
	first_seen_at: string;
	last_seen_at: string;
	evidence_ids: string[];
	repair_strategy: string;
}
```

误区模型比错题记录更有价值，因为它能指导 agent 主动生成针对性练习。

### 5.1.7 学习行为

```ts
export interface LearningBehaviors {
	session_pattern?: {
		average_session_minutes?: number;
		completion_rate?: number;
		preferred_time?: string;
	};
	help_seeking?: {
		asks_for_hints_before_solution?: boolean;
		tends_to_request_full_answer?: boolean;
	};
	persistence?: {
		retry_after_error_rate?: number;
		common_dropoff_points?: string[];
	};
}
```

### 5.1.8 自我调节学习能力

```ts
export interface SelfRegulationDimension {
	level: number;
	evidence_ids?: string[];
	notes?: string;
	next_action?: string;
}

export interface SelfRegulation {
	planning?: SelfRegulationDimension;
	monitoring?: SelfRegulationDimension;
	reflection?: SelfRegulationDimension;
	time_management?: SelfRegulationDimension;
	strategy_selection?: SelfRegulationDimension;
}
```

### 5.1.9 动机、情绪与偏好

```ts
export interface MotivationAffect {
	interests: string[];
	frustration_triggers: string[];
	self_efficacy: Record<string, number>;
}

export interface LearnerPreferences {
	explanation_style: string[];
	practice_style: string[];
	feedback_tone: string[];
	avoid: string[];
}
```

偏好要尽量写成可操作策略，例如：

```text
example_first
code_first
small_steps
immediate_feedback
avoid_full_answer_too_early
```

不要只写抽象标签，例如“实践型学习者”。

### 5.1.10 证据索引

```ts
export interface EvidenceIndexEntry {
	evidence_id: string;
	event_id: string;
	claim_type: "fact" | "inference" | "preference";
	target_path: string;
	confidence: number;
	created_at: string;
	expires_at?: string;
	summary: string;
}
```

原则：

- 事实通常不可变。
- 推断需要被新证据修正。
- 偏好允许用户直接编辑。
- 所有重要画像结论都要能追溯证据。

### 5.1.11 学习事件模型

```ts
export interface LearningEvent {
	event_id: string;
	learner_id: string;
	timestamp: string;
	event_type:
		| "goal_declared"
		| "explanation_given"
		| "exercise_attempt"
		| "self_assessment"
		| "note_uploaded"
		| "reflection"
		| "plan_changed"
		| "affect_signal";
	context: {
		goal_id?: string;
		concept_ids?: string[];
		session_id?: string;
		channel?: string;
	};
	payload: Record<string, unknown>;
	derived_signals?: {
		mastery_delta?: number;
		misconception_candidates?: string[];
		affect?: string;
		preference_candidates?: string[];
	};
}
```

事件层记录“发生了什么”，画像层记录“我们如何理解学习者”。不要把所有推断都直接混进事件事实里。

### 5.1.12 L1 更新流程

```text
学习交互结束
  ↓
生成 LearningEvent
  ↓
抽取目标、概念、正确性、错因、自评、偏好、情绪
  ↓
规则更新：
  - mastery
  - confidence
  - stability
  - review_due_at
  - completion_rate
  ↓
模型辅助更新：
  - 误区诊断
  - 阶段总结
  - 目标变化判断
  - 可读建议生成
  ↓
写入 LearnerProfile
```

### 5.1.13 对话前上下文包

不要把完整画像塞进每次 prompt。应生成短上下文包：

```ts
export interface LearnerContextPack {
	active_goal?: string;
	relevant_concepts: Array<{
		concept_id: string;
		mastery: number;
		confidence: number;
		diagnosis: string;
		review_due_at?: string;
	}>;
	active_misconceptions: Array<{
		concept_id: string;
		description: string;
		repair_strategy: string;
	}>;
	teaching_hints: string[];
	due_reviews: string[];
}
```

注入 system prompt 的内容应类似：

```text
## Learner Context

Active goal: 掌握 Python 后端开发基础
Relevant concepts:
- python.list_comprehension: mastery 0.72, diagnosis: 过滤条件位置仍不稳定
Teaching hints:
- 例子优先
- 先给提示，不要过早给完整答案
- 每次练习后要求用户写一句错因总结
```

### 5.1.14 L1 工具设计

```text
record_learning_event
  写入结构化学习事件。

get_learner_context
  根据当前用户问题和概念返回短上下文包。

update_learner_profile
  对目标、偏好、知识状态、误区等进行结构化更新。

review_learner_profile
  展示画像，支持用户确认、修正、删除。

disable_learner_memory
  关闭长期画像记忆。

delete_learner_memory
  删除长期画像记忆。
```

### 5.1.15 L1 存储建议

L1 是学习者画像状态，不交给 Graphify 管。MVP 可以先用本地文件实现，重点是数据模型、证据链和可编辑能力，而不是数据库选型。

```text
data/learner/
├── profile.json
├── events.jsonl
├── evidence.jsonl
└── context-cache.json
```

说明：

- `profile.json` 保存当前 LearnerProfile 快照。
- `events.jsonl` 保存 LearningEvent 事件流，用于画像更新和复盘。
- `evidence.jsonl` 保存画像判断的证据索引。
- 这些文件仅服务 L1 学习者画像，不用于 L2 知识内容归档。
- 后续可以替换为 SQLite 或其他存储，但第一版不必提前复杂化。

## 5.2 L2 Graphify Wiki 知识库
GitHub - safishamsi/graphify: AI coding assistant skill (Claude Code, Codex, OpenCode, Cursor, Gemin


L2 直接接入成熟的 Graphify 项目，不再自研一套 JSON / JSONL 知识库存储。Inno Agent 只负责把值得归档的学习内容交给 Graphify，并通过 Graphify 的 CLI / 输出文件 / 后续 MCP 能力查询知识。
https://github.com/safishamsi/graphify


L2 负责保存和检索知识内容，不负责保存学习者能力判断。能力判断仍属于 L1。

适合归档：

- 用户学习笔记。
- Agent 对某个知识点的总结。
- 项目源码结构说明。
- PDF、网页、课程资料摘要。
- 概念间关系。
- 学习路线和专题 Wiki。

推荐目录：

```text
data/graphify/
├── input/              # Inno Agent 整理后交给 Graphify 的 markdown / docs
└── out/                # Graphify 输出目录
    ├── GRAPH_REPORT.md
    ├── graph.json
    ├── graph.html
    └── wiki/
```

Graphify 接入方式：

```text
graphify data/graphify/input --wiki --output data/graphify/out
```

实际命令参数以 Graphify 当前版本为准，Inno Agent 应把它封装在 `graphify-runner.ts` 中，避免业务逻辑到处拼命令。

工具：

```text
archive_learning_note
  将当前对话、学习总结或用户提供内容整理为 Markdown，写入 data/graphify/input。

run_graphify_build
  调用 Graphify CLI 更新 Wiki / graph 输出。

query_graphify
  调用 Graphify 查询能力，或读取 Graphify 输出进行检索。

open_graphify_report
  返回 GRAPH_REPORT.md / graph.html 的位置，供用户或前端查看。
```

推荐流程：

```text
用户学习一个主题
  ↓
Agent 总结为 note
  ↓
写入 data/graphify/input
  ↓
定时任务或用户命令调用 Graphify
  ↓
更新 data/graphify/out
  ↓
后续回答时通过 Graphify 查询相关知识
```

## 5.3 L3 Pi 会话记录

L3 交给 Pi 原生 SessionManager 管理。

用途：

- 当前对话历史。
- 工具调用记录。
- 会话恢复。
- 分支与 fork。
- 上下文压缩。

当前是单用户系统，L3 固定保存到默认会话目录：

```text
data/sessions/default/
```

飞书、CLI、未来 Web 前端默认共享这份个人学习上下文。若后续需要多人使用，再扩展为按用户隔离。

L1、L2、L3 的边界：

```text
L1：这个学习者是谁，怎么学，掌握如何，误区在哪里
L2：学过什么知识，知识之间有什么关系
L3：最近聊了什么，agent 做过什么
```

## 6. 个人 IM 消息源接入设计

个人 IM 接入的详细设计见 `personal-im-channel-design.md`。本节只保留总体约束和与主架构的关系。

第一阶段只接入三个消息源：

- 微信私聊入口。
- 飞书私聊。
- QQ 私聊。

不做群聊，不做多人 session 隔离，不把 IM 平台当客服系统。所有入口都进入同一个个人 Pi session。

飞书作为第一优先级内置渠道，当前实现采用官方 Node SDK 的 WebSocket 模式。QQ 和微信优先通过 bridge sidecar 接入，避免把不稳定的平台连接逻辑深度耦合到 Inno 主进程。

### 6.1 消息流程

```text
用户从微信 / 飞书 / QQ 私聊发消息
  ↓
Channel Adapter
  ↓
过滤非私聊、非白名单用户、重复消息
  ↓
统一解析为 IncomingMessage
  ↓
PersonalChannelDispatcher
  ↓
构建 prompt 和图片输入
  ↓
调用 runPromptSerialized()
  ↓
收集输出
  ↓
channel.reply() 回复原渠道
```

### 6.2 Channel 接口方向

```ts
export interface IncomingMessage {
	channel: "feishu" | "qq" | "wechat" | "wecom" | "cli";
	messageId: string;
	chatId?: string;
	text: string;
	raw: unknown;
}

export interface PushTarget {
	channel: string;
	chatId?: string;
}

export interface ChatChannel {
	readonly name: string;
	verify(req: unknown): Promise<boolean>;
	parse(req: unknown): Promise<IncomingMessage | null>;
	reply(message: IncomingMessage, text: string): Promise<void>;
	push(target: PushTarget, text: string): Promise<void>;
}

export interface RealtimeChatChannel extends ChatChannel {
	onMessage(handler: (msg: IncomingMessage) => Promise<void> | void): void;
	start(): Promise<void> | void;
	stop?(): Promise<void>;
}
```

### 6.3 单用户映射策略

当前不做多用户 session 隔离。IM 消息只需要判断是否来自允许的个人私聊，然后进入同一个默认 Pi session。

```text
wechat / feishu / qq message -> default AgentSession
```

仍然保留 `chatId`，用于回复消息和后续推送，但不作为学习记忆分片。

## 7. QQ、微信扩展策略

先抽象 Channel 和 `PersonalChannelDispatcher`，不要为每个平台重写 agent 逻辑。

```text
FeishuChannel
BridgeChannel(qq)
BridgeChannel(wechat)
```

注意：

- 个人微信没有稳定官方机器人接口，优先使用公众号测试号 / 服务号作为稳定入口；个人微信扫码方案只作为 experimental。
- QQ 第一版优先通过 sidecar bridge 接入，稳定后再考虑原生 TypeScript `QQChannel`。
- QQ / 微信 sidecar 崩溃不能影响 Inno server、Web UI、定时任务和飞书。
- 三个消息源都必须支持白名单、去重、失败日志和默认推送目标。

## 8. 定时任务系统

定时任务应作为 Inno Agent 的长期后台服务，不依赖 Pi CLI 常驻。

### 8.1 Job 数据模型

```ts
export interface ScheduledJob {
	id: string;
	name: string;
	cron: string;
	timezone: string;
	enabled: boolean;
	channel?: "feishu" | "qq" | "wechat" | "wecom" | "cli";
	target?: PushTarget;
	taskType:
		| "daily_review"
		| "weekly_summary"
		| "graphify_update"
		| "learner_profile_reflection"
		| "spaced_review"
		| "push_reminder"
		| "custom_prompt";
	prompt: string;
	lastRunAt?: string;
	nextRunAt?: string;
	createdAt: string;
	updatedAt: string;
}
```

### 8.2 内置任务

```text
daily_review
  每天总结学习事件，更新画像摘要，生成明日建议。

weekly_summary
  每周总结目标进展、知识状态变化、活跃误区和下周计划。

graphify_update
  调用 Graphify 扫描 data/graphify/input，更新 data/graphify/out。

learner_profile_reflection
  从近期 LearningEvent 中生成画像更新建议。

spaced_review
  找出 review_due_at 到期的概念，推送复习任务。

push_reminder
  给指定 channel 发送提醒。
```

### 8.3 Job 执行流程

```text
Scheduler 到点
  ↓
加载 job
  ↓
获取系统或用户 Pi session
  ↓
注入 L1/L2 上下文
  ↓
执行 job.prompt
  ↓
根据 taskType 写 L1 / L2 / L3
  ↓
如配置 target，则推送结果
  ↓
更新 lastRunAt / nextRunAt
```

### 8.4 定时任务工具

```text
create_scheduled_job
list_scheduled_jobs
update_scheduled_job
disable_scheduled_job
run_scheduled_job
delete_scheduled_job
```

用户可以说：

```text
每天晚上 10 点帮我总结今天学了什么，并发到飞书。
```

Agent 应调用 `create_scheduled_job`，而不是只口头答应。

## 9. System Prompt 设计

Inno Agent 的系统提示词应表达三层记忆职责。

```text
你是一个个人学习 agent。

你有三层记忆：
1. L1 学习者画像记忆：保存目标、知识状态、误区、学习行为、自我调节能力、动机情绪、偏好、证据与置信度。
2. L2 Graphify Wiki 知识库：保存学习内容、项目知识、笔记和概念关系。
3. L3 Pi 会话记录：保存近期对话、工具调用和会话上下文。

工作原则：
- 先根据 L1 判断讲解深度、练习粒度、反馈方式和复习策略。
- 遇到稳定学习事实、目标、偏好、误区或自评时，记录为 LearningEvent。
- 重要画像结论必须证据驱动，不要无依据贴标签。
- 知识类内容应归档到 L2，而不是塞进 L1。
- 当前对话上下文由 L3 管理，不要把全部历史重复写入长期画像。
- 用户可以查看、修正、删除和关闭长期画像。
```

## 10. MVP 开发路线

### 阶段 1：L1 本地画像 MVP

目标：CLI 可用。

任务：

- 实现 `LearningEvent` 事件写入。
- 实现 `LearnerProfile` 本地快照。
- 实现 `record_learning_event`。
- 实现 `get_learner_context`。
- 实现 `/learner show`、`/learner reset`、`/learner disable`。
- 每次 agent 启动前注入短上下文包。

验收：

- 用户声明目标后，画像出现对应 goal。
- 用户做题错误后，能记录 event 和 misconception candidate。
- 下次相关问题能根据画像调整解释。

### 阶段 2：L2 Graphify Wiki

目标：知识内容可归档、可检索。

任务：

- 建立 `data/graphify/input` 和 `data/graphify/out`。
- 实现 `archive_learning_note`，将内容整理为 Graphify 可处理的 Markdown。
- 实现 `run_graphify_build`，直接调用 Graphify CLI。
- 实现 `query_graphify`，优先使用 Graphify 查询能力。
- 输出 `data/graphify/out`。

验收：

- 用户要求“把今天内容归档”时生成 Markdown。
- Graphify 能生成 wiki/report/graph。
- 后续问相关主题时，agent 能通过 Graphify 检索 L2 内容。

### 阶段 3：飞书接入

目标：飞书可对话。

任务：

- 实现 Feishu HTTP webhook。
- 实现 token / challenge / message parse。
- 实现 `FeishuChannel.reply()`。
- 实现飞书消息到默认 Pi session 的转发。
- 实现 `send_feishu_message` 工具。

验收：

- 飞书发消息，Inno Agent 回复。
- 单聊或指定群聊能进入同一个个人学习 agent。
- 后台任务可以主动推送到飞书。

### 阶段 4：定时任务

目标：后台周期运行。

任务：

- 实现 `ScheduledJob`。
- 实现 job store。
- 接入 node-cron 或 rrule。
- 实现内置 daily review、weekly summary、graphify update。
- 实现 job tools。

验收：

- 能创建每日复盘任务。
- 到点自动调用 Pi。
- 结果写入 L1/L2，并推送飞书。

### 阶段 5：开放画像界面

目标：用户能查看和修正画像。

任务：

- CLI `/learner review`。
- Web UI learner profile 页面。
- 支持确认、编辑、删除、禁用长期记忆。

验收：

- 用户能看到画像判断的证据。
- 用户能修正错误判断。
- 修正后后续教学策略改变。

## 11. 存储与前端预留

当前系统按单用户设计，存储策略保持简单：

```text
L1 学习者画像：本地 profile / event / evidence 文件，后续可替换。
L2 知识库：直接使用 Graphify 的 input / out，不自研 JSON 知识库存储。
L3 对话记录：Pi SessionManager，固定 data/sessions/default。
定时任务：jobs 文件或轻量数据库。
```

后续前端开发需要预留 API 边界，而不是直接让前端读写内部文件：

```text
GET  /api/learner/profile
POST /api/learner/profile/patch
GET  /api/learner/events
GET  /api/graphify/report
POST /api/graphify/build
POST /api/chat
GET  /api/jobs
POST /api/jobs
PATCH /api/jobs/:id
```

预留前端页面：

- Chat 页面。
- 学习者画像页面。
- Graphify Wiki / graph 查看页面。
- 定时任务管理页面。
- 飞书/渠道配置页面。

推荐先用文件存储，原因：

- 易调试。
- 易备份。
- 易观察 agent 写入是否合理。
- 个人学习场景初期数据量不大。

## 12. 隐私和安全要求

必须支持：

- 查看当前画像。
- 删除长期记忆。
- 关闭长期记忆。
- 修正错误画像。
- 查看关键判断的证据。
- 设置数据保留天数。

默认不保存：

- 医疗、财务、政治、宗教等敏感推断。
- 没有教学价值的情绪细节。
- 无证据来源的能力标签。
- 不必要的身份信息。

## 13. 关键开发决策

### 13.1 为什么不改 Pi 内核

Pi 已经提供：

- 模型适配。
- 工具调用。
- 会话管理。
- 扩展系统。
- SDK。

Inno Agent 应专注在学习场景的应用层。

### 13.2 为什么 L1 不直接存聊天摘要

聊天摘要容易混入噪声。L1 应保存对教学决策有用的结构化状态和证据。聊天历史由 L3 管。

### 13.3 为什么 Graphify 是 L2

Graphify 是成熟项目，适合直接作为 Wiki / graph 知识层接入。Inno Agent 不再为知识内容另建 JSON / JSONL 数据库，只负责生成输入、触发构建、查询输出。学习者能力判断仍属于 L1。

### 13.4 为什么定时任务不放 extension 常驻

extension 依赖 Pi 进程生命周期。CLI 退出后任务不会继续。定时任务应由 Inno Agent 后台服务负责。

## 14. 第一批实现清单

建议优先实现：

- `src/memory/learner/learning-event.ts`
- `src/memory/learner/learner-profile.ts`
- `src/memory/learner/context-pack.ts`
- `src/memory/learner/learner-tools.ts`
- `src/agent/pi-session-manager.ts`
- `src/memory/graphify/graphify-tools.ts`
- `src/channels/feishu.ts`
- `src/scheduler/job-store.ts`
- `src/scheduler/scheduler.ts`

第一版不要急着做复杂知识追踪模型。先用规则更新、证据链、置信度和时间衰减跑通闭环。
