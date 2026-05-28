# Inno Agent 个人 IM 消息源接入设计

## 1. 目标

Inno Agent 是个人软件，IM 接入不做通用客服、不做群聊运营、不做多人隔离。第一阶段只需要把三个个人消息源接入同一个个人 agent：

- 微信
- 飞书
- QQ

目标是形成一个小而可靠的个人 inbox：用户从任一 IM 私聊入口发消息，Inno Agent 接收、运行同一个 Pi session，并把结果回到原渠道；定时任务也可以推送到用户最近使用或显式设置的默认渠道。

## 2. 非目标

- 不支持群聊消息处理。
- 不按联系人创建独立 agent session。
- 不做客服坐席、多人租户、组织权限、群成员管理。
- 不在第一版内追求所有媒体类型完整支持。
- 不把微信、QQ 这类不稳定连接逻辑深度耦合到 Inno 主进程。

## 3. 当前代码基础

本项目已经具备基本 Channel 抽象：

- `src/channels/channel.ts`：`ChatChannel` 和 `ChannelRegistry`。
- `src/channels/types.ts`：统一的 `IncomingMessage`、`PushTarget`、`MessageAttachment`。
- `src/channels/feishu/`：飞书 WebSocket 接入，已支持文本、图片、文件、富文本解析、回复和主动推送。
- `src/channels/stubs.ts`：QQ、微信、企微仍是 stub。
- `src/server.ts`：启动时注册飞书，并把飞书消息转给 `runPromptSerialized`。
- `src/scheduler/`：定时任务可以通过 `ChannelRegistry` 主动 push。

所以第一步不是引入独立大 gateway，而是把飞书专用处理抽成通用个人消息 dispatcher，再接入 QQ / 微信。

## 4. 总体架构

```text
微信 / 飞书 / QQ 私聊消息
        ↓
Channel Adapter
        ↓
IncomingMessage
        ↓
PersonalChannelDispatcher
        ↓
PI Agent Session
        ↓
channel.reply() / channel.push()
```

各平台 adapter 只负责平台协议：

- 连接平台。
- 验证来源。
- 过滤非个人消息。
- 解析文本和附件。
- 回复或主动发送消息。

`PersonalChannelDispatcher` 负责 Inno 业务：

- 维护默认推送目标。
- 执行 `/new`、`新建会话` 等通用命令。
- 将图片附件转为 Pi multimodal input。
- 将文件附件路径追加到 prompt。
- 调用 `runPromptSerialized`。
- 统一错误回复和日志。

## 5. Channel 接口演进

当前 `ChatChannel` 保持为最小发送接口：

```ts
export interface ChatChannel {
	readonly name: string;
	verify(req: { headers: Record<string, string>; body: unknown }): Promise<boolean>;
	parse(body: unknown): Promise<IncomingMessage | null>;
	reply(message: IncomingMessage, text: string): Promise<void>;
	push(target: PushTarget, text: string): Promise<void>;
}
```

新增实时消息源接口：

```ts
export type MessageHandler = (msg: IncomingMessage) => Promise<void> | void;

export interface RealtimeChatChannel extends ChatChannel {
	onMessage(handler: MessageHandler): void;
	start(): Promise<void> | void;
	stop?(): Promise<void>;
}
```

飞书、QQ bridge、微信 bridge 都实现 `RealtimeChatChannel`。HTTP webhook 类渠道仍可只实现 `verify / parse / reply / push`。

## 6. PersonalChannelDispatcher

建议新增文件：

```text
src/channels/personal-dispatcher.ts
```

核心接口：

```ts
export interface PersonalChannelDispatcherOptions {
	channelRegistry: ChannelRegistry;
	runPrompt: (prompt: string, images?: ImageContent[]) => Promise<string>;
	createNewSession: () => Promise<string>;
	recordSessionChannel: (channel: ChannelName) => void;
}

export class PersonalChannelDispatcher {
	async handle(channel: ChatChannel, msg: IncomingMessage): Promise<void>;
}
```

处理流程：

```text
收到 IncomingMessage
  ↓
检查 text / attachments 是否为空
  ↓
保存 default target: { channel, chatId }
  ↓
处理通用命令：
  - /new
  - 新建对话
  - 新建会话
  ↓
转换附件：
  - image + base64 -> ImageContent
  - file + filePath -> prompt 追加附件路径
  ↓
runPromptSerialized(prompt, images)
  ↓
channel.reply(msg, output)
  ↓
记录 channel hint
```

错误处理：

- agent 执行失败：回复“这次处理失败，请稍后重试”，并写日志。
- 渠道回复失败：写 channel run log，不影响主进程。
- 附件下载失败：保留文本，追加“部分附件下载失败”提示。

## 7. 三个消息源策略

### 7.1 飞书

飞书作为内置原生渠道，继续使用官方 Node SDK `@larksuiteoapi/node-sdk` 的 WebSocket 模式。它不需要公网 webhook，更适合本地个人软件。

保留现有能力：

- 文本消息。
- 图片消息转 base64。
- 文件下载到 `data/downloads`。
- 富文本 `post` 提取为纯文本。
- `reply` 按 message id 回复。
- `push` 按 chat id 主动发送。

需要补齐：

- 只接受私聊，忽略群聊。
- `allowedUserIds` 白名单，默认只允许用户本人。
- 消息去重持久化，避免重启后重复回复。
- 可配置日志等级，避免 SDK 日志过吵。
- 发送失败重试一次，仍失败则写入 channel run log。

### 7.2 QQ

QQ 第一版推荐走 bridge sidecar，而不是立刻把 QQ Gateway 全部写进 Inno 主进程。

原因：

- QQ Bot 鉴权、Gateway、事件类型和媒体上传变化成本较高。
- sidecar 崩溃不会影响 Inno Web UI、定时任务和飞书。
- 后续如果 QQ 使用稳定，再把 bridge 逻辑替换为原生 TypeScript `QQChannel`。

第一版能力：

- 只处理私聊 / C2C 文本消息。
- 只响应 `allowedUserIds`。
- 支持 `reply`。
- 支持 `push` 到最近私聊目标。
- 图片、文件第二阶段再做。

推荐形态：

```text
QQ 平台
  ↓
qq-sidecar
  ↓ HTTP local bridge
Inno BridgeChannel
```

Sidecar 到 Inno 的本地投递协议见第 8 节。

### 7.3 微信

微信分稳定入口和实验入口，不把个人微信作为唯一方案。

稳定入口：

- 微信公众号测试号或服务号。
- 适合个人给 Inno 发消息。
- 接入方式是 webhook。
- 被动回复有时限，复杂任务应先快速确认，再异步推送。

实验入口：

- Wechaty sidecar。
- 适合个人微信扫码登录体验。
- 标记为 experimental。
- 不保证长期稳定，不作为主流程唯一依赖。

第一版建议：

- 默认实现 `WechatBridgeChannel`，由 sidecar 负责具体微信协议。
- 如果选择公众号，则 sidecar 可以很薄，只做微信签名验证、openid 解析、消息收发。
- 如果选择 Wechaty，则 sidecar 负责扫码登录、私聊过滤、消息转发。

## 8. BridgeChannel

QQ 和微信先通过统一 bridge 接入，避免为每个平台在主进程里引入复杂 SDK。

建议新增：

```text
src/channels/bridge/bridge-channel.ts
src/channels/bridge/bridge-server.ts
src/channels/bridge/types.ts
```

本地投递接口：

```text
POST /api/bridge/messages
Authorization: Bearer <bridge.token>
```

请求体：

```json
{
  "channel": "qq",
  "messageId": "qq-msg-123",
  "chatId": "qq-user-openid",
  "userId": "qq-user-openid",
  "text": "今天帮我复盘一下",
  "attachments": [],
  "raw": {}
}
```

Inno 返回：

```json
{
  "ok": true,
  "replyId": "local-run-id"
}
```

主动回复由 Inno 调 sidecar：

```text
POST <sidecar.baseUrl>/reply
Authorization: Bearer <bridge.token>
```

请求体：

```json
{
  "channel": "qq",
  "messageId": "qq-msg-123",
  "chatId": "qq-user-openid",
  "text": "复盘结果..."
}
```

主动推送：

```text
POST <sidecar.baseUrl>/push
Authorization: Bearer <bridge.token>
```

```json
{
  "channel": "wechat",
  "chatId": "wechat-openid",
  "text": "提醒时间到了。"
}
```

`BridgeChannel` 在 Inno 主进程中实现 `reply / push`，真正的平台发送由 sidecar 完成。

## 9. 配置模型

建议扩展 `InnoConfig`：

```ts
export interface InnoConfig {
	channels?: {
		feishu?: PersonalChannelConfig;
		qq?: PersonalBridgeChannelConfig;
		wechat?: PersonalBridgeChannelConfig;
	};
	feishu?: {
		appId: string;
		appSecret: string;
	};
	bridge?: {
		token: string;
		baseUrl?: string;
	};
}

export interface PersonalChannelConfig {
	enabled: boolean;
	personalOnly?: boolean;
	allowedUserIds?: string[];
}

export interface PersonalBridgeChannelConfig extends PersonalChannelConfig {
	mode: "bridge";
	sidecarBaseUrl: string;
}
```

示例：

```json
{
  "channels": {
    "feishu": {
      "enabled": true,
      "personalOnly": true,
      "allowedUserIds": ["ou_xxx"]
    },
    "qq": {
      "enabled": true,
      "mode": "bridge",
      "personalOnly": true,
      "allowedUserIds": ["qq_openid_xxx"],
      "sidecarBaseUrl": "http://127.0.0.1:4318"
    },
    "wechat": {
      "enabled": true,
      "mode": "bridge",
      "personalOnly": true,
      "allowedUserIds": ["wechat_openid_xxx"],
      "sidecarBaseUrl": "http://127.0.0.1:4319"
    }
  },
  "feishu": {
    "appId": "...",
    "appSecret": "..."
  },
  "bridge": {
    "token": "local-dev-secret"
  }
}
```

安全要求：

- `bridge.token` 必须存在才启用 bridge。
- bridge 默认只监听 `127.0.0.1`。
- 不在日志中打印 token、appSecret、sidecar auth header。

## 10. 存储与日志

建议目录：

```text
data/channels/
├── default-targets.json
├── dedupe.jsonl
├── runs.jsonl
└── bridge/
    ├── qq-health.json
    └── wechat-health.json
```

`dedupe.jsonl`：

```json
{"key":"feishu:om_xxx","seenAt":"2026-05-25T10:00:00.000Z","expiresAt":"2026-05-26T10:00:00.000Z"}
```

`runs.jsonl`：

```json
{
  "runId": "chrun_xxx",
  "channel": "qq",
  "messageId": "qq-msg-123",
  "status": "success",
  "startedAt": "2026-05-25T10:00:00.000Z",
  "finishedAt": "2026-05-25T10:00:12.000Z",
  "durationMs": 12000
}
```

日志原则：

- 记录 message id、channel、耗时、状态。
- 不记录完整用户消息到普通日志。
- 附件路径可以记录，但必须限制在 `data/downloads`。

## 11. 鲁棒性要求

消息入口：

- `channel + messageId` 去重，TTL 24 小时。
- 空文本且无附件的消息忽略。
- 非白名单用户忽略，并记录 debug 日志。
- 非私聊消息忽略。
- 单条文本长度限制，超长截断并提示。

Agent 执行：

- 沿用 `runPromptSerialized`，保证个人 agent 同一时间只处理一个 prompt。
- 每次 channel run 生成 `runId`。
- agent 报错时给用户明确短回复。
- 运行超时后回复用户稍后重试，并保留日志。

附件：

- 附件保存目录必须在 `data/downloads`。
- 文件名做路径清洗。
- MVP 仅支持图片和普通文件。
- 大文件先拒绝，默认上限 20 MB。

Sidecar：

- sidecar 健康检查失败不影响 Inno server 启动。
- `reply / push` 失败最多重试一次。
- bridge token 不匹配直接 401。
- sidecar 事件投递失败由 sidecar 自己重试，Inno 不保存未收到的远端消息。

推送：

- 每个渠道只保存一个默认 target。
- 用户从某渠道私聊成功后自动更新该渠道默认 target。
- 定时任务指定渠道时优先使用 job.target，其次使用该渠道默认 target。

## 12. API 端点

复用现有：

```text
GET  /api/channels
POST /api/channels/:name/default-target
POST /api/channels/:name/test
```

新增：

```text
POST /api/bridge/messages
GET  /api/channels/runs
GET  /api/channels/:name/health
```

`GET /api/channels` 返回：

```json
[
  {
    "name": "feishu",
    "enabled": true,
    "mode": "native",
    "hasDefaultTarget": true,
    "healthy": true
  },
  {
    "name": "qq",
    "enabled": true,
    "mode": "bridge",
    "hasDefaultTarget": false,
    "healthy": false
  }
]
```

## 13. 实施阶段

### 阶段 1：抽通用 dispatcher

目标：

- 飞书仍可正常收发。
- `server.ts` 不再直接写飞书业务逻辑。

任务：

- 新增 `RealtimeChatChannel` 类型。
- 新增 `PersonalChannelDispatcher`。
- 将飞书消息处理迁移到 dispatcher。
- 为 `/new`、附件转换、错误回复补基本测试。

验收：

- 飞书私聊发送文字，Inno 回复。
- 飞书发送图片，Inno 可收到 multimodal input。
- `/new` 能创建新会话。
- 定时任务仍可推送飞书。

### 阶段 2：飞书个人化加固

目标：

- 飞书成为可靠的个人入口。

任务：

- 私聊过滤。
- `allowedUserIds`。
- 持久化去重。
- channel run log。
- 发送失败重试。

验收：

- 非白名单用户消息被忽略。
- 重复 message id 不会重复回复。
- 重启后短期重复消息仍被去重。

### 阶段 3：BridgeChannel

目标：

- 主进程具备接收 QQ / 微信 sidecar 的统一能力。

任务：

- 新增 bridge 类型和 auth。
- 新增 `/api/bridge/messages`。
- 新增 `BridgeChannel.reply()` 和 `BridgeChannel.push()`。
- 新增 sidecar health 检查。

验收：

- 用 curl 模拟 QQ 消息，Inno 能执行并调用 sidecar `/reply`。
- bridge token 错误返回 401。
- sidecar 不在线时 Inno server 仍可启动。

### 阶段 4：QQ sidecar

目标：

- QQ 私聊文本可用。

任务：

- 用官方 QQ Bot API 或 botpy 实现 sidecar。
- 只转发私聊 / C2C。
- 映射 `messageId / chatId / userId / text`。
- 实现 `/reply` 和 `/push`。

验收：

- QQ 私聊发消息，Inno 回复。
- 非白名单用户被忽略。
- 定时任务可以推送到 QQ 默认 target。

### 阶段 5：微信 sidecar

目标：

- 微信入口可用。

优先路径：

- 微信公众号测试号 / 服务号 webhook。

实验路径：

- Wechaty sidecar。

验收：

- 微信私聊入口发消息，Inno 回复。
- 非白名单 openid 被忽略。
- 定时任务可以推送到微信默认 target。

## 14. 推荐文件结构

```text
src/channels/
├── channel.ts
├── types.ts
├── personal-dispatcher.ts
├── dedupe-store.ts
├── run-log.ts
├── feishu/
│   ├── feishu-api.ts
│   └── feishu-channel.ts
├── bridge/
│   ├── bridge-channel.ts
│   ├── bridge-client.ts
│   ├── bridge-server.ts
│   └── types.ts
└── stubs.ts
```

Sidecar 可以放在独立目录，避免主 app 依赖膨胀：

```text
integrations/
├── qq-sidecar/
└── wechat-sidecar/
```

## 15. 最终取舍

推荐路线：

```text
飞书：主进程原生接入
QQ：bridge sidecar 优先，稳定后再原生化
微信：公众号 bridge 优先，个人微信 Wechaty 作为 experimental
```

这个取舍符合 Inno 的个人软件定位：飞书可作为最稳定的内置通道，QQ / 微信用 bridge 隔离平台复杂性和账号风险。三个消息源最终都进入同一个个人 Pi session，不做群聊、不做多人隔离，保持系统小而可维护。
