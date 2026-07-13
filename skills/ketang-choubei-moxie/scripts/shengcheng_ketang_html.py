#!/usr/bin/env python3
"""根据经过校验的资料生成可离线使用的课堂抽背与默写网页。"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def require_text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} 必须是非空文字")
    return value.strip()


def validate(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("输入最外层必须是对象")

    title = require_text(raw.get("title"), "title")
    subtitle = raw.get("subtitle", "")
    if not isinstance(subtitle, str):
        raise ValueError("subtitle 必须是文字")

    students_raw = raw.get("students", [])
    if not isinstance(students_raw, list):
        raise ValueError("students 必须是数组")
    students: list[str] = []
    seen_students: set[str] = set()
    for index, student in enumerate(students_raw, 1):
        name = require_text(student, f"students[{index}]")
        if name not in seen_students:
            students.append(name)
            seen_students.add(name)

    questions_raw = raw.get("questions")
    if not isinstance(questions_raw, list) or not questions_raw:
        raise ValueError("questions 必须是非空数组")
    questions: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for index, item in enumerate(questions_raw, 1):
        if not isinstance(item, dict):
            raise ValueError(f"questions[{index}] 必须是对象")
        question_id = require_text(item.get("id"), f"questions[{index}].id")
        if question_id in seen_ids:
            raise ValueError(f"题目编号重复：{question_id}")
        seen_ids.add(question_id)
        keywords = item.get("keywords", [])
        if not isinstance(keywords, list) or any(not isinstance(x, str) for x in keywords):
            raise ValueError(f"questions[{index}].keywords 必须是文字数组")
        questions.append({
            "id": question_id,
            "type": require_text(item.get("type"), f"questions[{index}].type"),
            "source": str(item.get("source", "")).strip(),
            "prompt": require_text(item.get("prompt"), f"questions[{index}].prompt"),
            "answer": require_text(item.get("answer"), f"questions[{index}].answer"),
            "hint": str(item.get("hint", "")).strip(),
            "keywords": [x.strip() for x in keywords if x.strip()],
        })

    settings = raw.get("settings", {})
    if not isinstance(settings, dict):
        raise ValueError("settings 必须是对象")
    draw_mode = settings.get("drawMode", "no-repeat")
    if draw_mode not in {"no-repeat", "random"}:
        raise ValueError("settings.drawMode 只能是 no-repeat 或 random")
    timer = settings.get("timerSeconds", 5)
    if not isinstance(timer, int) or isinstance(timer, bool) or not 0 <= timer <= 600:
        raise ValueError("settings.timerSeconds 必须是 0 到 600 的整数")

    return {
        "title": title,
        "subtitle": subtitle.strip(),
        "students": students,
        "questions": questions,
        "settings": {"drawMode": draw_mode, "timerSeconds": timer},
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="生成离线课堂抽背与默写 HTML")
    parser.add_argument("input", type=Path, help="UTF-8 JSON 输入文件")
    parser.add_argument("--output", "-o", type=Path, required=True, help="HTML 输出文件")
    args = parser.parse_args()

    raw = json.loads(args.input.read_text(encoding="utf-8"))
    data = validate(raw)
    template = Path(__file__).resolve().parent.parent / "assets" / "classroom-template.html"
    html = template.read_text(encoding="utf-8")
    payload = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")
    if "__CLASSROOM_DATA__" not in html:
        raise RuntimeError("页面模板缺少数据占位符")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(html.replace("__CLASSROOM_DATA__", payload), encoding="utf-8")
    print(f"已生成：{args.output.resolve()}")
    print(f"题目：{len(data['questions'])}；学生：{len(data['students'])}")


if __name__ == "__main__":
    main()
