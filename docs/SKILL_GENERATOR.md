# Inno Agent Skills 生成器

Skills 生成器把一次性的引导、会话操作轨迹和用户反馈沉淀为 PI SDK 可直接加载的 `SKILL.md`。它复用现有 skills 目录、L3 会话索引和 `ask_user_question`，不修改 PI SDK，也不引入额外运行时依赖。

## 使用方式

- 在「技能仓库 → 我的技能」点击 **生成技能**。
- 在 Web 或 CLI 中输入 `/skill-create`，也可以附加目标、方法或现有技能名，例如：
  - `/skill-create guided 帮我创建论文精读技能`
  - `/skill-create trace 总结当前会话的操作流程`
  - `/skill-create evolution paper-reading`
  - `/skill-create hybrid 把历史周报流程沉淀下来`

生成器先展示草案；只有用户在问题卡片中明确选择保存后，才会写入技能目录。

## 四种方法

| 方法 | 适用场景 | 核心过程 |
| --- | --- | --- |
| `guided` 引导式 | 从零创建、流程尚未演示 | 一次性收集目标、触发条件、输入输出、约束、示例、验收方式，再生成技能契约。 |
| `trace` Trace-to-Skill | 当前或历史会话已有可复用操作 | 提取用户意图、工具调用、结果和纠错；区分成功与失败证据，抽象重复流程并保留步骤引用。 |
| `evolution` 自演化 | 现有技能需要修复或增强 | 读取原技能和元数据，结合反馈/新轨迹形成修订；用户确认后备份旧版本并写入新版本。 |
| `hybrid` 混合式 | 轨迹不完整或质量要求较高 | 先用轨迹确定事实，再通过引导补齐边界、偏好和验收标准。 |

## 实现流程

1. **证据提取**：复用 `session-parser` 的活跃分支解析，只使用可见用户/assistant 文本和工具记录，不收集隐藏思考。常见凭据字段、Bearer token 和私钥会脱敏；长文本、工具结果和轨迹步数有上限。
2. **轨迹排序**：按工具证据、完成信号、失败调用和用户纠错计算 0–100 的启发式分数，优先分析证据更完整的会话。这个分数只用于排序，**不代表技能正确率**。
3. **经验归纳**：模型分别识别成功做法、失败原因和恢复条件；多条轨迹优先保留跨轨迹重复出现的模式，合并重复项并显式处理冲突。单条轨迹生成的技能视为待验证草案。
4. **技能契约**：生成参数化步骤、适用/不适用场景、前提、输出、完成检查、异常回退和工具边界，避免把一次性路径、个人数据或具体答案固化为规则。
5. **安全保存**：校验 YAML frontmatter、目录名、正文和符号链接边界。`revise` 先以独占写复制旧版本，再原子写入新 `SKILL.md`。
6. **试跑与演化**：结构校验不等于行为有效。用户应在一个新的具体任务上试跑，再通过 `evolution` 使用真实反馈迭代。

## 存储结构

```text
<skillsDir>/<skill-name>/
├── SKILL.md
├── generator.json          # 方法、版本、证据引用、反馈与修订摘要
└── history/                # 仅修订时生成
    └── <timestamp>-v1.md
```

`scope=workspace` 时根目录替换为当前工作区的 `.skills/`。历史关键词检索遵守 L3 开关；分析当前会话或明确指定的会话不依赖 L3 检索。服务器保存后通过现有 `scheduleSkillsReload` 排队重载；CLI 可执行 `/reload` 或重启加载。

## 研究与开源参考

本项目采用的是适合本地个人 agent 的轻量适配，不是这些框架的完整复刻：

- **[Trace2Skill](https://arxiv.org/abs/2603.25158)**（[官方代码](https://github.com/Qwen-Applications/Trace2Skill)，Apache-2.0）：成功/失败轨迹分别分析、局部 patch 提炼、跨轨迹去重与冲突合并。完整论文还包含并行 analyst、层级合并和基准集选择；当前实现保留其核心经验归纳方式，不运行大规模 patch 优化。
- **[Work2Skill](https://arxiv.org/abs/2610.12984)**（[代码与数据](https://github.com/china-qijizhifeng/Work2Skill)）：从人类 GUI 演示生成独立 `SKILL.md`，强调证据检查、步骤依赖、停止规则和完成检查。当前实现复用这些技能契约思想，但不包含屏幕录制、视频关键帧或 accessibility-tree 对齐。
- **[Skill-DisCo](https://arxiv.org/html/2606.26669v1)**：轨迹规范化、子目标抽象、参数化、前置/后置条件和验证。当前实现生成 Markdown 程序而非可执行 Python/PFSM，因此不会宣称具备其编译与执行验证能力。
- **[Voyager](https://arxiv.org/abs/2305.16291)**（[开源项目](https://github.com/MineDojo/Voyager)）：执行反馈、自我验证、技能存储与复用闭环。Inno Agent 增加人工发布闸门和版本备份，避免无监督写入污染技能库。
- **[session-to-skill](https://github.com/jeness/session-to-skill)**（MIT）：当前会话聚焦总结与标准技能包生成的轻量交互参考。Inno Agent 额外实现了历史检索、显式脱敏、保存确认、版本元数据和回滚备份。

## 边界与后续增强

- 当前生成与归纳由聊天模型完成；`trace.ts` 提供有界、脱敏的证据，不运行独立 LLM 评估服务。
- 当前没有自动行为基准、技能效用衰减或自动删除机制。只有在用户提供试跑反馈后，才应把“已验证”写入技能说明。
- 若后续需要 Work2Skill 的完整 GUI 能力，可在 computer-use 插件中增加用户主动启动的录制器，再将动作/截图证据接入同一生成流程。
- 若需要 Trace2Skill 的完整多 patch 选择，应新增独立评估任务集和候选版本比较，避免仅凭同一批训练轨迹判断收益。
