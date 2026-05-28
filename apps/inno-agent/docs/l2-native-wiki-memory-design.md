# Inno Agent L2 原生 Wiki 记忆开发设计

## 1. 目标

L2 记忆用于保存学习内容、资料摘要、概念关系和综合分析。它不保存学习者能力判断，能力、目标、误区和偏好仍属于 L1 学习者画像。

本设计不再把 Graphify 作为外部 skill 接入，而是在 Inno Agent 内用 TypeScript 实现一套原生 Wiki 记忆层。Graphify 的思想可作为参考：把资料摄入、整理、链接、查询和复用做成可维护的知识库。

## 2. 文件结构

```text
data/l2/
├── raw/                 # 原始资料，只读，不修改
│   ├── uploads/
│   ├── web/
│   ├── conversations/
│   └── research/
├── extracted/           # raw 转换后的 Markdown 证据文本
├── wiki/                # 人类可读、agent 可查的知识库
│   ├── index.md
│   ├── log.md
│   ├── sources/
│   ├── entities/
│   ├── concepts/
│   └── analysis/
└── manifest.jsonl       # raw/extracted/wiki 的映射、hash、状态、权限
```

目录职责：

- `raw/`：保存原始证据，如 PDF、Word、图片、网页快照、对话片段和研究报告。永远不被修改。
- `extracted/`：机器转换后的 Markdown，尽量忠实于原始资料，用于后续生成 Wiki。
- `wiki/`：维护后的知识库，可被 agent 查询、链接和更新。
- `manifest.jsonl`：记录每个资料的来源、hash、权限、处理状态和产物路径。

## 3. 页面类型

Wiki 页面分为四类：

- `source-summary`：某份原始资料的摘要，放在 `wiki/sources/`。
- `entity`：人物、公司、项目等实体页面，放在 `wiki/entities/`。
- `concept`：技术概念、理论框架和方法论，放在 `wiki/concepts/`。
- `analysis`：对比分析、综合判断、学习路线和研究结论，放在 `wiki/analysis/`。

每个页面使用 YAML frontmatter：

```yaml
---
title: Graphify 作为 Inno Agent L2 记忆
type: source-summary
tags: [inno-agent, l2-memory]
sources:
  - raw/uploads/2026-05-12-graphify.pdf
source_ids:
  - l2src_20260512_xxx
updated: 2026-05-12
status: draft
confidence: medium
---
```

页面内链接使用 Obsidian 双链格式：

```text
[[Graphify]]
[[Inno Agent]]
[[L2 记忆]]
```

## 4. 摄入流程

当用户要求摄入资料，或 agent 判断某段内容值得长期保存时，执行：

```text
判断是否值得摄入
  ↓
保存原始资料到 raw/
  ↓
写入 manifest.jsonl
  ↓
转换 raw 为 extracted/*.md
  ↓
创建或更新 wiki/sources/ 摘要页
  ↓
更新 wiki/index.md
  ↓
检查并更新相关 entities/concepts/analysis
  ↓
标注矛盾、过期或低置信度内容
  ↓
追加 wiki/log.md
```

摄入策略：

- 用户明确说“归档”“保存到知识库”“帮我记下来”时，直接进入 L2。
- 用户上传资料并要求学习、总结、研究时，进入 L2。
- deepresearch 的最终报告进入 L2。
- agent 发现高价值但用户未明确要求的内容，应先询问用户是否归档。
- 临时闲聊、一次性命令输出、未确认的个人隐私和无来源推测不进入 L2。

## 5. 查询流程

回答知识库相关问题时：

```text
读取 wiki/index.md
  ↓
定位相关 source/entity/concept/analysis 页面
  ↓
读取相关页面
  ↓
综合回答，并附 [[页面名称]] 引用
  ↓
如果回答形成新判断，建议保存为 analysis 页面
```

L1/L2/L3 的使用边界：

- 问用户目标、能力状态、偏好和误区时，查 L1。
- 问学过的知识、资料、概念关系和研究结论时，查 L2。
- 问最近对话和工具调用时，用 L3。
- 做学习推荐时，组合 L1 学习者画像和 L2 Wiki。

## 6. TypeScript 模块

建议实现：

```text
src/memory/l2/
├── types.ts
├── ingest-policy.ts
├── manifest-store.ts
├── raw-store.ts
├── source-converter.ts
├── wiki-maintainer.ts
├── wiki-linker.ts
├── contradiction-checker.ts
├── wiki-query.ts
└── l2-tools.ts
```

模块职责：

- `ingest-policy.ts`：判断内容是否值得进入 L2。
- `raw-store.ts`：保存上传、网页、对话和研究原始资料。
- `source-converter.ts`：将 PDF、Word、图片、HTML、Markdown 和对话转换为 Markdown。
- `wiki-maintainer.ts`：创建和更新 Wiki 页面、索引和日志。
- `wiki-linker.ts`：识别实体和概念，维护双链。
- `contradiction-checker.ts`：发现与已有页面的冲突并标注。
- `wiki-query.ts`：按查询读取索引和相关页面。
- `l2-tools.ts`：向 Inno Agent 暴露归档、查询、构建和推荐工具。

## 7. MVP

第一阶段只实现可用闭环：

- 建立 `data/l2/raw`、`data/l2/extracted`、`data/l2/wiki` 和 `manifest.jsonl`。
- 支持文本、Markdown 和对话片段摄入。
- 支持 PDF/Word/图片的接口预留，先返回明确的未实现错误。
- 生成 `wiki/sources/*.md`、`wiki/index.md` 和 `wiki/log.md`。
- 查询时能读取 `wiki/index.md` 和相关页面回答。
- 用户明确要求归档时，agent 能调用 L2 工具完成写入。

后续阶段再加入：

- PDF、Word、图片 OCR 和网页正文抽取。
- entity/concept 自动更新。
- contradiction 标注。
- analysis 页面生成。
- 图谱 `graph.json` 和可视化。
- 基于 L1 + L2 的学习推荐。
