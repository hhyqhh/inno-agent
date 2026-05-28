# 个人学习 Agent 的学习者画像记忆层设计

## 1. 背景与目标

个人学习 Agent 需要长期理解学习者，而不是只在单次对话里回答问题。本设计将用户画像层定义为 **学习者画像记忆层**，也可以称为 learner profile memory 或 learner model memory。它的核心职责不是给用户贴静态标签，而是持续维护一组可解释、可校正、可用于教学决策的学习者状态。

学习者画像需要回答以下问题：

- 学习者想学什么，目标优先级是什么。
- 学习者已经掌握什么、正在学习什么、容易误解什么。
- 学习者适合怎样的练习粒度、讲解方式和复习节奏。
- 当前最应该推荐什么学习行动。
- 每条画像判断来自哪些证据，可信度如何，是否已经过期。

本设计面向个人学习场景，优先支持 MVP 落地：先用结构化事件、规则更新、置信度和时间衰减建立可靠记忆，再逐步引入知识追踪、学习路径推荐和更复杂的教学策略。

## 2. 设计原则

### 2.1 证据驱动，而非标签驱动

学习者画像中的每个重要结论都应该能追溯到学习证据。例如，不应只记录“数学较弱”，而应记录“在最近 5 次链式法则练习中，有 3 次漏掉外层函数导数”。画像结论需要保存来源、时间、置信度和更新原因。

### 2.2 区分事实、推断与偏好

学习者画像至少要区分三类信息：

- 事实：用户在 2026-05-11 完成了 10 道 Python 列表推导式练习。
- 推断：用户可能混淆了输出表达式和过滤条件。
- 偏好：用户自述更喜欢通过项目案例学习。

这三类信息的更新策略不同。事实通常不可变；推断需要随新证据修正；偏好需要允许用户直接编辑。

### 2.3 开放学习者模型

学习者应能查看、修正、删除自己的画像。Agent 可以展示“我认为你目前在这些概念上更需要练习”，并允许用户反馈“这个判断不准确”。这种开放学习者模型可以增强透明度，也能把画像维护本身变成元认知训练的一部分。

### 2.4 时间敏感

知识掌握会遗忘，兴趣和目标也会改变。因此画像不能只保存静态分数，需要包含最近练习时间、更新时间、过期状态和复习到期时间。

### 2.5 最小充分记忆

长期记忆应避免无边界保存聊天内容。MVP 阶段建议保留三层：

- 原始或半结构化学习事件。
- 从事件抽取的学习者画像状态。
- 用于对话上下文的短摘要。

只有对未来学习决策有价值的信息才沉淀到画像层。

## 3. 总体架构

```text
学习交互、测验、作业、笔记、自评、资源使用
        |
        v
学习事件层 Episodic Learning Memory
记录真实发生过什么
        |
        v
画像抽取与更新 Profile Extraction & Update
诊断概念、错因、偏好、情绪、目标变化
        |
        v
学习者画像层 Learner Profile Memory
目标、知识状态、误区、行为、动机、偏好、证据
        |
        v
教学决策层 Pedagogical Policy
讲解、练习、复习、追问、计划、反馈、资源推荐
        |
        v
对话与学习体验层 Agent Interface
```

### 3.1 学习事件层

事件层记录“发生了什么”。它是画像更新的证据来源，也是后续复盘、调试和模型评估的基础。

典型事件包括：

- 用户提出学习目标。
- Agent 讲解某个概念。
- 用户完成一道题或一组题。
- 用户回答错误并暴露错因。
- 用户上传笔记或总结。
- 用户自评掌握程度。
- 用户中断学习、延期计划或表达挫败。

### 3.2 学习者画像层

画像层记录“我们目前如何理解这个学习者”。它不是完整日志，而是经过抽取和合并后的结构化状态。

主要模块包括：

- 基本约束。
- 学习目标。
- 知识状态。
- 误区模型。
- 学习行为。
- 自我调节学习能力。
- 动机与情绪。
- 内容与交互偏好。
- 证据、置信度与可解释信息。

### 3.3 教学决策层

教学决策层使用画像决定下一步行动，例如：

- 当前是否该讲新知识、做练习、复习旧知识或追问诊断。
- 练习难度应该提升、降低还是保持。
- 讲解应使用文字、代码、图示、类比、案例还是苏格拉底式提问。
- 是否需要提醒用户复盘、制定计划或拆分任务。

## 4. 数据模型

### 4.1 LearnerProfile

```json
{
  "learner_id": "user_001",
  "version": 1,
  "updated_at": "2026-05-11T20:30:00+08:00",
  "constraints": {},
  "goals": [],
  "knowledge_states": [],
  "misconceptions": [],
  "learning_behaviors": {},
  "self_regulation": {},
  "motivation_affect": {},
  "preferences": {},
  "profile_summary": "",
  "evidence_index": []
}
```

### 4.2 基本约束

```json
{
  "available_time": {
    "weekday_minutes": 45,
    "weekend_minutes": 90,
    "preferred_sessions": ["evening"]
  },
  "language": ["zh-CN", "en"],
  "device_context": ["laptop", "mobile"],
  "privacy": {
    "allow_long_term_memory": true,
    "allow_sensitive_inference": false,
    "retention_days": 365
  }
}
```

### 4.3 学习目标

```json
{
  "goal_id": "goal_python_backend",
  "title": "掌握 Python 后端开发基础",
  "type": "skill",
  "priority": 0.8,
  "status": "active",
  "target_date": null,
  "success_criteria": [
    "能独立实现一个带数据库的 API 服务",
    "能解释路由、中间件、ORM、鉴权的基本原理"
  ],
  "source": "user_declared",
  "updated_at": "2026-05-11T20:30:00+08:00"
}
```

### 4.4 知识状态

知识状态是学习者画像的核心。推荐以概念为粒度维护掌握度，而不是只按课程或章节维护。

```json
{
  "concept_id": "python.list_comprehension",
  "concept_name": "Python 列表推导式",
  "domain": "programming.python",
  "mastery": 0.72,
  "confidence": 0.64,
  "stability": 0.48,
  "last_practiced_at": "2026-05-11T20:10:00+08:00",
  "review_due_at": "2026-05-14T20:00:00+08:00",
  "evidence_ids": ["evt_1001", "evt_1002"],
  "diagnosis": "基本语法已掌握，但过滤条件位置仍不稳定",
  "next_actions": [
    "给 2 道从 for 循环改写为列表推导式的练习",
    "加入 1 道包含 if 条件的变式题"
  ]
}
```

字段说明：

- `mastery`：当前掌握度，范围 0 到 1。
- `confidence`：系统对掌握度判断的信心，取决于证据数量、证据新鲜度和题目质量。
- `stability`：记忆稳定性，可用于间隔重复和遗忘预测。
- `review_due_at`：下次复习时间。
- `diagnosis`：面向教学决策的短诊断。

### 4.5 误区模型

```json
{
  "misconception_id": "misc_python_lc_if_position",
  "concept_id": "python.list_comprehension",
  "description": "把 if 过滤条件写在 for 子句之前",
  "status": "active",
  "severity": 0.6,
  "confidence": 0.7,
  "first_seen_at": "2026-05-10T21:00:00+08:00",
  "last_seen_at": "2026-05-11T20:10:00+08:00",
  "evidence_ids": ["evt_1002"],
  "repair_strategy": "通过错误代码对比和改写练习强化语法槽位"
}
```

误区模型比单纯错题记录更有价值。它帮助 Agent 主动生成针对性练习，而不是机械重复同一题型。

### 4.6 学习行为

```json
{
  "session_pattern": {
    "average_session_minutes": 38,
    "completion_rate": 0.74,
    "preferred_time": "evening"
  },
  "help_seeking": {
    "asks_for_hints_before_solution": true,
    "tends_to_request_full_answer": false
  },
  "persistence": {
    "retry_after_error_rate": 0.68,
    "common_dropoff_points": ["multi-step exercises"]
  }
}
```

### 4.7 自我调节学习能力

自我调节学习可以覆盖计划、监控、反思、策略选择和求助行为。

```json
{
  "planning": {
    "level": 0.55,
    "evidence_ids": ["evt_0901"]
  },
  "monitoring": {
    "level": 0.42,
    "notes": "用户较少主动判断自己是否真正理解"
  },
  "reflection": {
    "level": 0.36,
    "next_action": "每次练习后加入一句错因总结"
  },
  "time_management": {
    "level": 0.61
  }
}
```

### 4.8 动机、情绪与偏好

```json
{
  "motivation_affect": {
    "interests": ["构建真实项目", "AI 工具"],
    "frustration_triggers": ["连续抽象解释", "一次性给太多概念"],
    "self_efficacy": {
      "programming.python": 0.58
    }
  },
  "preferences": {
    "explanation_style": ["example_first", "code_first"],
    "practice_style": ["small_steps", "immediate_feedback"],
    "feedback_tone": ["direct", "encouraging"],
    "avoid": ["过早给完整答案"]
  }
}
```

偏好应尽量写成可操作策略，而不是抽象人格判断。例如“例子优先”比“实践型学习者”更好。

## 5. 学习事件模型

```json
{
  "event_id": "evt_1002",
  "learner_id": "user_001",
  "timestamp": "2026-05-11T20:10:00+08:00",
  "event_type": "exercise_attempt",
  "context": {
    "goal_id": "goal_python_backend",
    "concept_ids": ["python.list_comprehension"],
    "session_id": "sess_20260511"
  },
  "payload": {
    "question_id": "q_lc_003",
    "answer": "[if x > 3 for x in nums x * 2]",
    "is_correct": false,
    "error_type": "syntax_order",
    "hint_used": true
  },
  "derived_signals": {
    "mastery_delta": -0.08,
    "misconception_candidates": ["misc_python_lc_if_position"],
    "affect": "mild_frustration"
  }
}
```

事件层应尽量保持原始事实，不把所有推断都混进去。推断可以放在 `derived_signals`，并在画像更新时作为候选证据使用。

## 6. 更新流程

### 6.1 写入事件

每次学习交互结束后生成一个或多个学习事件。事件应包含时间、场景、概念、任务结果和可复用证据。

### 6.2 抽取信号

从事件中抽取以下信号：

- 目标变化。
- 涉及概念。
- 正确性和解题质量。
- 错因和误区。
- 用户自评。
- 情绪或动机变化。
- 学习策略表现。
- 新偏好或旧偏好的反例。

### 6.3 更新画像

画像更新可以分为规则更新和模型辅助更新。

规则更新适合：

- 做题正确率。
- 最近练习时间。
- 复习到期时间。
- 完成率和学习时长。

模型辅助更新适合：

- 从自然语言解释中诊断误区。
- 总结阶段性画像。
- 判断用户是否表达了目标变化。
- 生成可读的学习建议。

### 6.4 冲突处理

当新证据与旧画像冲突时，不应直接覆盖。推荐策略：

- 保留旧证据。
- 降低旧判断置信度。
- 标记画像为需要确认。
- 在合适时机向用户询问或开放编辑。

例如，用户过去说喜欢详细讲解，但最近多次要求“直接给练习”，系统可以将偏好更新为“当前任务下更喜欢练习优先”，而不是简单删除旧偏好。

## 7. 检索与使用策略

### 7.1 对话前检索

每次 Agent 回复前，从画像层检索与当前任务相关的信息：

- 当前目标。
- 当前概念掌握度。
- 活跃误区。
- 近期学习事件摘要。
- 与当前领域相关的偏好。
- 复习到期项。

### 7.2 避免过度注入

不要把完整画像塞进上下文。推荐生成一个短上下文包：

```json
{
  "active_goal": "掌握 Python 后端开发基础",
  "relevant_concepts": [
    {
      "concept_id": "python.list_comprehension",
      "mastery": 0.72,
      "diagnosis": "过滤条件位置仍不稳定"
    }
  ],
  "teaching_hints": [
    "例子优先",
    "先给提示，不要过早给完整答案",
    "每次练习后要求用户写一句错因总结"
  ]
}
```

### 7.3 教学动作选择

可用以下简单规则启动 MVP：

- `mastery < 0.4`：先讲解和示例，再给低难度练习。
- `0.4 <= mastery < 0.75`：以针对性练习为主，穿插短讲解。
- `mastery >= 0.75`：给变式题、迁移题或项目任务。
- `confidence < 0.5`：优先诊断，不急于推进。
- 存在活跃误区：先修复误区，再进入新内容。
- `review_due_at <= now`：插入短复习。

## 8. 隐私、安全与用户控制

学习者画像包含长期行为和能力推断，需要默认谨慎。

必须支持：

- 用户查看当前画像。
- 用户删除长期记忆。
- 用户关闭长期记忆。
- 用户修正错误画像。
- 敏感推断默认不保存。
- 每条画像记录来源和更新时间。

不建议保存：

- 不必要的身份信息。
- 医疗、财务、政治、宗教等敏感推断。
- 没有教学价值的情绪细节。
- 无法解释来源的能力标签。

## 9. MVP 实施建议

第一阶段建议实现以下能力：

1. 结构化学习事件日志。
2. 概念级知识状态表。
3. 活跃误区表。
4. 用户可编辑的学习目标和偏好。
5. 每日或每节课后的画像摘要。
6. 简单掌握度更新、置信度更新和复习到期计算。
7. 对话前生成短上下文包。

暂不建议第一版引入复杂深度知识追踪模型。原因是个人学习 Agent 初期数据量较小，深度模型很难稳定训练；规则加证据链更透明，也更容易调试。

## 10. 评估指标

### 10.1 画像质量

- 准确性：用户是否认可画像判断。
- 可解释性：每个判断是否能找到证据。
- 新鲜度：画像是否及时反映近期变化。
- 稳定性：画像是否避免被单次异常交互过度影响。

### 10.2 学习效果

- 概念掌握度提升。
- 复习后保持率。
- 错误类型减少。
- 独立完成任务比例提升。
- 学习计划完成率。

### 10.3 体验指标

- 用户是否愿意开启长期记忆。
- 用户是否主动修正画像。
- 用户是否觉得推荐内容更贴合自己。
- Agent 是否减少重复讲解和无关建议。

## 11. 后续演进

### 11.1 引入知识追踪

当事件数据足够多时，可以从简单规则升级到 Bayesian Knowledge Tracing、Deep Knowledge Tracing 或注意力知识追踪模型，用于更细粒度地估计概念掌握度。

### 11.2 引入知识图谱

将概念组织为前置依赖图。例如“列表推导式”依赖“for 循环”“条件表达式”“列表”。这样可以支持学习路径规划和补缺推荐。

### 11.3 引入开放画像界面

提供一个“我的学习画像”页面，展示：

- 当前目标。
- 掌握度热力图。
- 待复习概念。
- 常见误区。
- Agent 推荐的下一步。
- 用户可编辑的偏好和约束。

### 11.4 引入反思机制

类似 LLM agent 的 reflection 机制，定期从学习事件中生成阶段性总结。例如每周总结“本周最主要的进步、反复出现的误区、下周建议策略”。

## 12. 参考文献

1. Böck, R., et al. (2025). Learner models: design, components, structure, and modelling. *User Modeling and User-Adapted Interaction*. https://link.springer.com/article/10.1007/s11257-025-09434-4

2. Corbett, A. T., & Anderson, J. R. (1994). Knowledge tracing: Modeling the acquisition of procedural knowledge. *User Modeling and User-Adapted Interaction, 4*, 253-278. https://doi.org/10.1007/BF01099821

3. Pardos, Z. A., & Heffernan, N. T. (2010). Modeling individualization in a Bayesian networks implementation of knowledge tracing. *User Modeling, Adaptation, and Personalization*. https://www.ischool.berkeley.edu/research/publications/2010/modeling-individualization-bayesian-networks-implementation-knowledge

4. Piech, C., Bassen, J., Huang, J., Ganguli, S., Sahami, M., Guibas, L. J., & Sohl-Dickstein, J. (2015). Deep Knowledge Tracing. *Advances in Neural Information Processing Systems*. https://arxiv.org/abs/1506.05908

5. Liu, Q., et al. (2022). A survey on deep learning based knowledge tracing. *Knowledge-Based Systems*. https://www.sciencedirect.com/science/article/pii/S0950705122011297

6. Bull, S. (2016). Negotiated learner modelling to maintain today's learner models. *Research and Practice in Technology Enhanced Learning*. https://link.springer.com/article/10.1186/s41039-016-0035-3

7. Long, Y., & Aleven, V. (2017). Enhancing learning outcomes through self-regulated learning support with an Open Learner Model. *User Modeling and User-Adapted Interaction*. https://link.springer.com/article/10.1007/s11257-016-9186-6

8. Panadero, E. (2017). A review of self-regulated learning: Six models and four directions for research. *Frontiers in Psychology, 8*, 422. https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2017.00422/full

9. Park, J. S., et al. (2023). Generative Agents: Interactive Simulacra of Human Behavior. *Proceedings of the ACM Symposium on User Interface Software and Technology*. https://arxiv.org/abs/2304.03442

10. Packer, C., et al. (2023). MemGPT: Towards LLMs as Operating Systems. https://arxiv.org/abs/2310.08560

11. Hatalis, K., et al. (2024). Memory Matters: The Need to Improve Long-Term Memory in LLM-Agents. *AAAI Spring Symposium*. https://ojs.aaai.org/index.php/AAAI-SS/article/view/27688

12. Wu, T., et al. (2024). LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory. https://arxiv.org/abs/2410.10813

