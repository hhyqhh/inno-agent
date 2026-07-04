# Inno Agent Bug 修复工作记录

## 项目信息
- **项目名称**: inno-agent (华师大周爱民团队教育智能体项目)
- **任务来源**: 开放式考核任务 - 本地运行、测试、定位并修复 Bug
- **提交形式**: PR 代码贡献 + 工作记录文档
- **完成日期**: 2026-07-04

---

## 修复的 Bug

### Bug 1: Session 渠道误判 (核心 Bug)

#### 问题描述
在 `apps/inno-agent/src/server.ts` 的 `parseSessionFile` 函数中，通过子串匹配原始 JSON 文本行来推断会话渠道，导致**正常中文对话内容**被误判为渠道标签。

#### 误判触发场景
| 场景 | 原始代码结果 | 期望结果 |
|---|---|---|
| 用户问"飞书的英文名是什么?" | `channels=['feishu','web']` | `channels=['web']` |
| 助手回复"飞书"（如回答办公软件问题） | `channels=['feishu','web']` | `channels=['web']` |
| 用户问"is this scheduled?" | `channels=['scheduler','web']` | `channels=['web']` |

#### 根因分析
原始代码使用 `entryText.includes()` 对整行 JSON 文本做子串匹配：

```typescript
// 原始代码 (apps/inno-agent/src/server.ts:1622-1649)
const entryText = line.toLowerCase();
if (entryText.includes('"channel":"feishu"') || entryText.includes("飞书") || entryText.includes("附件已下载到")) {
    channels.add("feishu");
}
if (entryText.includes('"tasktype"') || entryText.includes("scheduled")) {
    channels.add("scheduler");
}
```

**问题**: 这些匹配不仅针对系统标记字段，还包含**自然语言关键词**（"飞书"、"scheduled"等）。当用户在正常学习对话中提到这些词时（如询问"飞书怎么用"、"这个任务 scheduled 了吗"），会话会被错误地打上渠道标签。

#### 验证过程

**验证环境**:
- 后端: Node.js 24.13.0, TypeScript 5.9.2
- 模型: DeepSeek API (deepseek-chat)
- 测试方法: Python urllib 直接发送 UTF-8 请求，绕过终端编码问题

**原始代码测试结果**:
```python
# 实验 A2: 用户消息含"飞书"
channels: ['feishu', 'web']   # ❌ 误判

# 实验 B: 助手回复含"飞书"  
channels: ['feishu', 'web']   # ❌ 误判

# 实验 A (对照组): 不含关键词
channels: ['web']             # ✅ 正常
```

**修复后测试结果**:
```python
# 实验 A2: 用户消息含"飞书"
channels: ['web']   # ✅ 正确

# 实验 B: 助手回复含"飞书"
channels: ['web']   # ✅ 正确
```

#### 修复方案
改为**结构化字段匹配**，只检查系统写入的 `message.channel` / `message.source` / `message.api` / `message.model` 字段：

```typescript
// 修复后代码 (apps/inno-agent/src/server.ts:1622-1660)
const msgObj = entry.type === "message" && entry.message && typeof entry.message === "object"
    ? entry.message as Record<string, unknown>
    : undefined;
const channelField = typeof msgObj?.channel === "string" ? (msgObj.channel as string) : "";
const sourceField = typeof msgObj?.source === "string" ? (msgObj.source as string) : "";
const apiField = typeof msgObj?.api === "string" ? (msgObj.api as string) : "";
const modelField = typeof msgObj?.model === "string" ? (msgObj.model as string) : "";

if (channelField === "feishu") {
    channels.add("feishu");
    entryChannel = "feishu";
}
// ... 其他渠道同理
```

**修复原则**: 只匹配**结构化 JSON 字段值**，不再对自然语言文本做子串匹配。

#### 代码变更
- **文件**: `apps/inno-agent/src/server.ts`
- **行号**: 1617-1660
- **变更类型**: Bug 修复

---

## 发现并记录的其他问题

### 问题 2: i18n 缺失 17 个 key (待修复)

**发现方法**: 静态扫描 `t('key')` 调用与 locale 文件定义的 key 对比

**缺失的 key**:
```
common.clear
common.collapseSidebar
common.expandSidebar
files.confirmDelete
files.delete
files.download
files.downloadFolder
files.dropToUpload
files.editing
files.newFile
files.newFileHere
files.newFolder
files.newFolderHere
files.rename
files.uploadSkill
settings.editModel
settings.form.apiType
```

**影响**: 这些 UI 文案在界面会显示为 key 本身（如显示"files.newFile"而非"新建文件"）

**状态**: 已记录，建议在后续 PR 中修复

---

## 测试方法总结

### 问题发现
- 后端类型检查: `npx tsc -p apps/inno-agent/tsconfig.json --noEmit`
- 前端类型检查: `npx tsc -p apps/inno-agent/web/tsconfig.json --noEmit`
- 静态扫描: `grep` 提取 `t('key')` 调用与 locale 文件对比

### Bug 1 专项测试
使用 Python 绕过 Windows 终端 GBK 编码问题：
```python
import urllib.request, json

# 创建 session
req = urllib.request.Request("http://localhost:3000/api/sessions", ...)
sid = json.loads(urllib.request.urlopen(req).read().decode("utf-8"))["id"]

# 发送含"飞书"的中文 prompt
req2 = urllib.request.Request("http://localhost:3000/api/chat",
    data=json.dumps({"sessionId": sid, "prompt": "飞书的英文名是什么?"}).encode("utf-8"),
    headers={"Content-Type": "application/json"})

# 检查渠道标记
req3 = urllib.request.Request(f"http://localhost:3000/api/sessions/{sid}")
session = json.loads(urllib.request.urlopen(req3).read().decode("utf-8"))
print(session.get('channels'))  # 期望: ['web'], 修复前: ['feishu','web']
```

---

## 环境配置记录

### API 配置 (DeepSeek)
```json
{
  "defaultProvider": "deepseek",
  "defaultModel": "deepseek-chat",
  "providers": {
    "deepseek": {
      "baseUrl": "https://api.deepseek.com",
      "api": "openai-completions",
      "apiKey": "sk-...",
      "models": [
        {"id": "deepseek-chat", "name": "DeepSeek Chat (V3)"},
        {"id": "deepseek-reasoner", "name": "DeepSeek Reasoner (R1)"}
      ]
    }
  }
}
```

### 服务启动
```bash
npm run server -- --home ./runtime --workspace ./workspace --port 3000
```

---

## 提交信息建议

```
fix(server): remove natural-language substring matching for channel detection

Previously, parseSessionFile used entryText.includes("飞书") and similar
substring matches on the raw JSON line to detect session channels. This
false-positively tagged any session where "飞书", "scheduled", etc. appeared
in user/assistant text (e.g., a learner asking "飞书怎么注册?").

Fix: Parse the structured message.* fields (channel, source, api, model)
instead of substring-matching the raw line. Verified that sessions with
"飞书" in the conversation text no longer get mislabeled as feishu channel.

Fixes: Session channel mislabeling when learning content mentions
channel-related keywords.
```

---

## 备注

- 所有验证使用 UTF-8 编码的干净中文数据，排除终端编码干扰
- 原始代码已保留在 git history 中，可随时回退对比
- 修复通过 TypeScript 编译检查，服务正常启动
