# 交付物结构

技能完成后在工作区根目录创建 `班级讲评/` 目录，内含下列产物。文件名用学科 + 考试标题，避免覆盖。

## 目录布局

```
班级讲评/
├── 班级讲评报告.html        # 由生成程序渲染，含五个页签的可交互页面
├── 班级讲评报告.json        # 生成程序的输入 JSON（也是完整结果留档）
├── 班级总体分析.md          # 班级概览（平均分/分数段/各题得分率/知识点/主要问题/补讲建议）
├── 题目分析/
│   └── 第{n}题.md           # 每题一份：原文/答案分布/错误原因/典型错误/讲评稿/补偿练习
├── 知识点分析.md            # 知识点得分率 + 薄弱项
├── 讲评方案.md              # 讲评顺序（四档）+ 重点题讲评稿合集
├── 补偿练习.md              # 五类补偿题，每题标原题号与知识点
└── 订正单/
    └── {学生编号}.md        # 每名学生一份（默认脱敏编号）
```

## 生成程序输入 JSON

`班级讲评报告.json` 的结构。生成程序 `scripts/shengcheng_jiangping_baogao.py` 据此渲染 HTML。

```json
{
  "meta": {
    "subject": "数学",
    "grade": "高二",
    "examTitle": "期中考试",
    "examDate": "2026-03-15",
    "fullScore": 100,
    "headcount": 42,
    "absent": 1
  },
  "classSummary": {
    "average": 71.4,
    "max": 96,
    "min": 38,
    "median": 73,
    "stddev": 12.6,
    "passRate": 0.81,
    "scoreBands": [
      { "band": "0-59",  "count": 5,  "ratio": 0.12 },
      { "band": "60-69", "count": 8,  "ratio": 0.19 },
      { "band": "70-79", "count": 14, "ratio": 0.33 },
      { "band": "80-89", "count": 11, "ratio": 0.26 },
      { "band": "90-100","count": 4,  "ratio": 0.10 }
    ],
    "mainIssues": ["函数性质理解不完整", "计算检验缺失"],
    "reviewFocus": ["重点讲第 8、12、17 题"]
  },
  "questions": [
    {
      "id": "8",
      "type": "single",
      "stem": "……",
      "score": 5,
      "correct": "A",
      "knowledge": ["充分条件与必要条件"],
      "difficulty": "medium",
      "related": ["12"],
      "accuracy": 0.31,
      "distribution": [
        { "option": "A", "count": 13, "ratio": 0.31 },
        { "option": "B", "count": 18, "ratio": 0.42 },
        { "option": "C", "count": 5,  "ratio": 0.12 },
        { "option": "D", "count": 7,  "ratio": 0.16 }
      ],
      "topWrong": { "option": "B", "count": 18, "ratio": 0.42 },
      "diagnosis": [
        { "option": "B", "ratio": 0.42, "reason": "疑似混淆充分条件与必要条件" },
        { "option": "D", "ratio": 0.16, "reason": "疑似忽略题干‘至少’" }
      ]
    },
    {
      "id": "17",
      "type": "subjective",
      "stem": "……",
      "score": 12,
      "rubric": { "points": [{ "desc": "设未知数", "score": 2 }], "total": 12 },
      "knowledge": ["函数零点"],
      "difficulty": "hard",
      "average": 5.6,
      "scoreRate": 0.47,
      "zeroCount": { "count": 3, "ratio": 0.07 },
      "scoreBuckets": [
        { "band": "0-25%",  "count": 9,  "ratio": 0.21 },
        { "band": "25-50%", "count": 14, "ratio": 0.33 },
        { "band": "50-75%", "count": 12, "ratio": 0.29 },
        { "band": "75-100%","count": 7,  "ratio": 0.17 }
      ],
      "diagnosis": [
        { "type": "condition_incomplete", "evidence": "得分段 25-50% 集中，未见定义域讨论", "ratio": 0.33 }
      ]
    }
  ],
  "knowledgeStats": [
    { "name": "函数零点",       "scoreRate": 0.47, "level": "薄弱", "questionCount": 3 },
    { "name": "充分条件与必要条件", "scoreRate": 0.52, "level": "薄弱", "questionCount": 2 }
  ],
  "reviewPlan": [
    {
      "id": "8",
      "tier": "must",
      "reviewValue": 0.74,
      "factors": {
        "errorPeople": 0.69,
        "knowledgeWeight": 1.0,
        "downstream": 0.7,
        "typical": 1.0,
        "estimatedMinutes": 2
      }
    }
  ],
  "reviewScripts": [
    {
      "id": "8",
      "performance": "正确率 31%，高频错误 B（42%）。",
      "goal": "区分函数零点与方程根的关系。",
      "steps": ["先问学生题目要求判断什么", "展示错项 B 思路", "指出遗漏", "规范书写", "总结易错点"],
      "board": "主错思路→漏洞；正确思路→关键步骤；易错点小结",
      "linkedExercise": "补偿练习第 1 题"
    }
  ],
  "typicalErrors": [
    {
      "id": "12",
      "category": "看似正确但有漏洞",
      "anonymousExcerpt": "（匿名化后的学生作答节选）",
      "comment": "方法对但未检验定义域。"
    }
  ],
  "remedialExercises": [
    {
      "id": "补-1",
      "category": "同类巩固",
      "sourceQuestion": "8",
      "knowledge": ["充分条件与必要条件"],
      "stem": "（改写情境后的新题）",
      "answer": "……"
    }
  ],
  "studentReports": [
    {
      "studentId": "S07",
      "focusQuestions": ["8", "12", "17"],
      "mainIssues": ["条件遗漏", "计算检验缺失"],
      "tasks": { "redoS": 2, "similar": 3, "review": 1 },
      "total": 78,
      "band": "70-79"
    }
  ]
}
```

## 校验规则

生成程序对输入 JSON 做以下校验，任一失败则中止并打印明确错误（不生成残缺 HTML）：

- `meta` 与 `questions` 必须存在；`meta.fullScore > 0`、`meta.headcount ≥ 0`。
- `questions[].id` 整份唯一且非空。
- `questions[].type ∈ {single, multiple, judge, subjective}`。
- 客观题必须有 `correct` 与非空 `distribution`；`distribution` 各 `ratio` 之和约等于 1（±0.02 容差）。
- 主观题必须有 `average` 与 `scoreBuckets`。
- `reviewPlan[].tier ∈ {must, brief, self, skip}`。
- `studentReports[].studentId` 唯一。

校验通过后生成 `班级讲评报告.html`，使用 `assets/report-template.html` 作为模板注入数据。不要手工拼装 HTML。
