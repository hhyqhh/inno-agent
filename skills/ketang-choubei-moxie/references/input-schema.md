# 输入格式

生成程序接受 UTF-8 JSON 文件。

```json
{
  "title": "七年级语文课堂抽背",
  "subtitle": "《木兰诗》与重点文言句",
  "settings": {
    "drawMode": "no-repeat",
    "timerSeconds": 5
  },
  "students": ["张同学", "李同学"],
  "questions": [
    {
      "id": "poem-001",
      "type": "古诗接句",
      "source": "《木兰诗》",
      "prompt": "万里赴戎机，__________。",
      "answer": "关山度若飞",
      "hint": "填写下一句",
      "keywords": ["关山", "度若飞"]
    }
  ]
}
```

## 字段

- `title`：必填，课堂活动标题。
- `subtitle`：选填，教材、章节或活动说明。
- `students`：字符串数组，可为空。
- `questions`：非空数组。
- `questions[].id`：必填且唯一。
- `questions[].type`：必填，例如“全文背诵”“文言翻译”“英译中”“政治思考”。
- `questions[].prompt`：必填，投屏时首先显示的内容。
- `questions[].answer`：必填；资料未给出且无法可靠确定时填“待教师确认”，并在生成前提醒教师。
- `questions[].source`、`hint`：选填字符串。
- `questions[].keywords`：选填字符串数组。
- `settings.drawMode`：`no-repeat` 或 `random`，默认 `no-repeat`。
- `settings.timerSeconds`：0 到 600 的整数，默认 5。

程序会拒绝空题库、重复题目编号、缺少题目或答案的输入，并自动去除完全重复的学生姓名。
