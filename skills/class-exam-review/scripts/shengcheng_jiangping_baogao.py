#!/usr/bin/env python3
"""根据经过校验的讲评分析 JSON 生成可离线查看/打印的班级试卷讲评报告 HTML。

输入 JSON 的结构见 references/deliverables.md。本脚本只做校验和模板注入，
不修改数据、不做任何统计计算——所有数字必须由调用方（技能）事先算好。
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

VALID_TYPES = {"single", "multiple", "judge", "subjective"}
VALID_TIERS = {"must", "brief", "self", "skip"}


def require_dict(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} 必须是对象")
    return value


def require_list(value: Any, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise ValueError(f"{label} 必须是数组")
    return value


def require_number(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} 必须是数字")
    return float(value)


def require_ratio(value: Any, label: str) -> float:
    n = require_number(value, label)
    if not 0.0 <= n <= 1.0:
        raise ValueError(f"{label} 必须在 0–1 之间，当前 {n}")
    return n


def validate_meta(raw: Any) -> dict[str, Any]:
    meta = require_dict(raw, "meta")
    for key in ("subject", "grade", "examTitle", "examDate"):
        v = meta.get(key)
        if not isinstance(v, str) or not v.strip():
            raise ValueError(f"meta.{key} 必须是非空文字")
    full_score = require_number(meta.get("fullScore"), "meta.fullScore")
    if full_score <= 0:
        raise ValueError("meta.fullScore 必须大于 0")
    headcount = meta.get("headcount", 0)
    if not isinstance(headcount, int) or isinstance(headcount, bool) or headcount < 0:
        raise ValueError("meta.headcount 必须是非负整数")
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", meta["examDate"]):
        raise ValueError("meta.examDate 必须为 YYYY-MM-DD 格式")
    return {
        "subject": meta["subject"].strip(),
        "grade": meta["grade"].strip(),
        "examTitle": meta["examTitle"].strip(),
        "examDate": meta["examDate"],
        "fullScore": full_score,
        "headcount": headcount,
        "absent": int(meta.get("absent", 0)),
    }


def validate_distribution(raw: Any, label: str) -> list[dict[str, Any]]:
    dist = require_list(raw, label)
    if not dist:
        raise ValueError(f"{label} 不能为空")
    out: list[dict[str, Any]] = []
    total = 0.0
    for i, item in enumerate(dist, 1):
        item = require_dict(item, f"{label}[{i}]")
        option = item.get("option")
        if not isinstance(option, str) or not option.strip():
            raise ValueError(f"{label}[{i}].option 必须是非空文字")
        count = item.get("count")
        if not isinstance(count, int) or isinstance(count, bool) or count < 0:
            raise ValueError(f"{label}[{i}].count 必须是非负整数")
        ratio = require_ratio(item.get("ratio"), f"{label}[{i}].ratio")
        total += ratio
        out.append({"option": option.strip(), "count": count, "ratio": ratio})
    if abs(total - 1.0) > 0.02:
        raise ValueError(f"{label} 各 ratio 之和应为 1，当前 {total:.4f}")
    return out


def validate_question(raw: Any, index: int) -> dict[str, Any]:
    item = require_dict(raw, f"questions[{index}]")
    qid = item.get("id")
    if not isinstance(qid, str) or not qid.strip():
        raise ValueError(f"questions[{index}].id 必须是非空文字")
    qtype = item.get("type")
    if qtype not in VALID_TYPES:
        raise ValueError(
            f"questions[{index}].type 只能是 {sorted(VALID_TYPES)}，当前 {qtype!r}"
        )
    stem = item.get("stem")
    if not isinstance(stem, str):
        raise ValueError(f"questions[{index}].stem 必须是文字")
    score = require_number(item.get("score"), f"questions[{index}].score")
    if score <= 0:
        raise ValueError(f"questions[{index}].score 必须大于 0")

    out: dict[str, Any] = {
        "id": qid.strip(),
        "type": qtype,
        "stem": stem,
        "score": score,
        "knowledge": [str(k) for k in require_list(item.get("knowledge", []), "knowledge")],
        "difficulty": item.get("difficulty", "medium"),
        "related": [str(r) for r in require_list(item.get("related", []), "related")],
    }

    if qtype == "subjective":
        average = require_number(item.get("average"), f"questions[{index}].average")
        if average < 0 or average > score:
            raise ValueError(f"questions[{index}].average 超出 [0, score] 范围")
        score_rate = average / score
        buckets = require_list(item.get("scoreBuckets"), f"questions[{index}].scoreBuckets")
        zero = item.get("zeroCount") or {}
        out.update({
            "average": average,
            "scoreRate": score_rate,
            "scoreBuckets": [
                {
                    "band": str(b.get("band", "")),
                    "count": int(b.get("count", 0)),
                    "ratio": require_ratio(b.get("ratio"), f"questions[{index}].scoreBuckets[].ratio"),
                }
                for b in buckets
            ],
            "zeroCount": {
                "count": int(zero.get("count", 0)),
                "ratio": require_ratio(zero.get("ratio", 0.0), "zeroCount.ratio"),
            },
        })
    else:
        correct = item.get("correct")
        if correct is None or (isinstance(correct, (list, str)) and not correct):
            raise ValueError(f"questions[{index}].correct 必须给出")
        out["correct"] = correct if isinstance(correct, list) else str(correct)
        out["distribution"] = validate_distribution(
            item.get("distribution"), f"questions[{index}].distribution"
        )
        # accuracy 由 distribution 派生，避免调用方给不一致的值
        correct_key = "".join(sorted(correct)) if isinstance(correct, list) else str(correct)
        matched = 0
        total_n = 0
        for d in out["distribution"]:
            opt = "".join(sorted(d["option"])) if isinstance(correct, list) else d["option"]
            if opt == correct_key:
                matched += d["count"]
            total_n += d["count"]
        out["accuracy"] = (matched / total_n) if total_n else 0.0
        top_wrong = None
        for d in out["distribution"]:
            opt_key = "".join(sorted(d["option"])) if isinstance(correct, list) else d["option"]
            if opt_key == correct_key:
                continue
            if top_wrong is None or d["ratio"] > top_wrong["ratio"]:
                top_wrong = d
        out["topWrong"] = top_wrong

    out["diagnosis"] = require_list(item.get("diagnosis", []), "diagnosis")
    return out


def validate(raw: Any) -> dict[str, Any]:
    data = require_dict(raw, "输入最外层")
    meta = validate_meta(data.get("meta"))

    questions_raw = require_list(data.get("questions"), "questions")
    if not questions_raw:
        raise ValueError("questions 不能为空")
    questions: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for i, q in enumerate(questions_raw, 1):
        q = validate_question(q, i)
        if q["id"] in seen_ids:
            raise ValueError(f"题目编号重复：{q['id']}")
        seen_ids.add(q["id"])
        questions.append(q)

    plan_raw = require_list(data.get("reviewPlan", []), "reviewPlan")
    plan: list[dict[str, Any]] = []
    for p in plan_raw:
        p = require_dict(p, "reviewPlan[]")
        tier = p.get("tier")
        if tier not in VALID_TIERS:
            raise ValueError(f"reviewPlan[].tier 只能是 {sorted(VALID_TIERS)}，当前 {tier!r}")
        plan.append({
            "id": str(p.get("id", "")).strip(),
            "tier": tier,
            "reviewValue": require_number(p.get("reviewValue", 0), "reviewValue"),
            "factors": p.get("factors", {}),
        })

    student_ids: set[str] = set()
    students: list[dict[str, Any]] = []
    for s in require_list(data.get("studentReports", []), "studentReports"):
        s = require_dict(s, "studentReports[]")
        sid = str(s.get("studentId", "")).strip()
        if not sid:
            raise ValueError("studentReports[].studentId 不能为空")
        if sid in student_ids:
            raise ValueError(f"studentReports[].studentId 重复：{sid}")
        student_ids.add(sid)
        students.append(s)

    return {
        "meta": meta,
        "classSummary": require_dict(data.get("classSummary", {}), "classSummary"),
        "questions": questions,
        "knowledgeStats": require_list(data.get("knowledgeStats", []), "knowledgeStats"),
        "reviewPlan": plan,
        "reviewScripts": require_list(data.get("reviewScripts", []), "reviewScripts"),
        "typicalErrors": require_list(data.get("typicalErrors", []), "typicalErrors"),
        "remedialExercises": require_list(data.get("remedialExercises", []), "remedialExercises"),
        "studentReports": students,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="生成班级试卷讲评报告 HTML")
    parser.add_argument("input", type=Path, help="UTF-8 JSON 输入文件（见 references/deliverables.md）")
    parser.add_argument("--output", "-o", type=Path, required=True, help="HTML 输出文件")
    args = parser.parse_args()

    raw = json.loads(args.input.read_text(encoding="utf-8"))
    data = validate(raw)

    template = Path(__file__).resolve().parent.parent / "assets" / "report-template.html"
    html = template.read_text(encoding="utf-8")
    if "__REPORT_JSON__" not in html:
        raise RuntimeError("报告模板缺少数据占位符 __REPORT_JSON__")
    payload = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(html.replace("__REPORT_JSON__", payload), encoding="utf-8")

    tier_counts = {"must": 0, "brief": 0, "self": 0, "skip": 0}
    for p in data["reviewPlan"]:
        tier_counts[p["tier"]] = tier_counts.get(p["tier"], 0) + 1
    print(f"已生成：{args.output.resolve()}")
    print(
        f"题目 {len(data['questions'])}；"
        f"重点讲 {tier_counts['must']} / 简要 {tier_counts['brief']} / "
        f"自行订正 {tier_counts['self']} / 跳过 {tier_counts['skip']}；"
        f"订正单 {len(data['studentReports'])} 份"
    )


if __name__ == "__main__":
    main()
