import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import type { ChatTraceStep } from "../types/chat.js";
import {
	compressObject,
	foldTraceFlow,
	formatCompactDuration,
	isFoldableTraceStep,
	summarizeTraceRun,
} from "./trace-summary.js";

// Same stub the component tests use: the zh fallback with {{vars}} filled in.
const t = ((_key: string, fallback: string, options?: Record<string, unknown>) =>
	fallback.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(options?.[name] ?? `{{${name}}}`))) as unknown as TFunction;

function tool(toolName: string, args?: Record<string, unknown>, extra: Partial<ChatTraceStep> = {}): ChatTraceStep {
	return { id: `${toolName}:${Math.random()}`, kind: "tool", status: "completed", title: toolName, toolName, args, ...extra };
}
const thinking: ChatTraceStep = { id: "th", kind: "thinking", status: "completed", title: "思考", text: "..." };
const prose: ChatTraceStep = { id: "p", kind: "progress", status: "completed", title: "进度", text: "正文" };

describe("summarizeTraceRun", () => {
	it("reproduces the WorkBuddy multi-stage lines from the reference screenshot", () => {
		expect(summarizeTraceRun([
			tool("bash", { command: "npm run verify" }),
			tool("bash", { command: "cat x" }),
			tool("read", { path: "/notes/2026-11.md" }),
		], t).text).toBe("运行校验、查看文件：2026-11.md");

		expect(summarizeTraceRun([
			tool("edit", { path: "2026-11-17.md" }),
			tool("edit", { path: "2026-11-17.md" }),
			tool("bash", { command: "check" }),
			tool("edit", { path: "2026-11-17.md" }),
		], t).text).toBe("修改、运行校验：2026-11-17.md");
	});

	it("keeps first-seen order on equal group sizes and never takes a topic from a command", () => {
		const result = summarizeTraceRun([tool("bash", { command: "secret.sh" }), tool("read", { path: "a.md" })], t);
		expect(result.text).toBe("运行校验、查看文件：a.md");
		// Commands alone give no topic, so only the no-topic phrase remains.
		expect(summarizeTraceRun([tool("bash", { command: "x" }), tool("bash", { command: "y" })], t).text).toBe("运行命令");
	});

	it("uses `{action} {object}` for a single useful atom and ignores thinking", () => {
		expect(summarizeTraceRun([thinking, tool("read", { path: "src/app.ts" })], t).text).toBe("读取 app.ts");
		expect(summarizeTraceRun([tool("web_search", { query: "https://example.com/a/b" })], t).text).toBe("搜索资料 example.com");
	});

	it("falls back when nothing useful remains", () => {
		expect(summarizeTraceRun([thinking, thinking], t).text).toBe("思考过程");
		expect(summarizeTraceRun([tool("mystery_tool"), tool("other_mystery")], t).text).toBe("继续处理任务过程");
	});

	it("summarizes many groups without a topic as a count", () => {
		const steps = [
			tool("bash", { command: "a" }),
			tool("todo"),
			tool("subagent"),
			tool("l2_lint"),
		];
		expect(summarizeTraceRun(steps, t).text).toBe("4 类操作");
	});

	it("picks the icon of the most frequent tool, first-seen on ties", () => {
		expect(summarizeTraceRun([tool("read", { path: "a" }), tool("bash"), tool("bash")], t).icon).toBe("command");
		expect(summarizeTraceRun([tool("read", { path: "a" }), tool("bash")], t).icon).toBe("read");
		expect(summarizeTraceRun([thinking, thinking], t).icon).toBe("thinking");
	});

	it("reads targets from streamed argsText when args are not parsed yet", () => {
		expect(summarizeTraceRun([tool("read", undefined, { argsText: '{"path":"docs/x.md"}' })], t).text).toBe("读取 x.md");
	});
});

describe("compressObject", () => {
	it("compresses URL, path, CJK and long text", () => {
		expect(compressObject("https://a.example.com/x?y=1")).toBe("a.example.com");
		expect(compressObject("C:\\work\\报告.docx")).toBe("报告.docx");
		expect(compressObject("这是一个非常非常非常非常长的中文查询语句")).toBe("这是一个非常非常非常非常长的中文…");
		expect(compressObject("one two three four five six seven")).toBe("one two three four five six…");
		expect(compressObject("a\nb")).toBeUndefined();
	});
});

describe("foldTraceFlow", () => {
	const isText = (step: ChatTraceStep) => step.kind === "progress" || step.kind === "answer";
	const flow = (steps: ChatTraceStep[]) => steps.map((step, index) => ({ step, index }));
	const shape = (items: ReturnType<typeof foldTraceFlow>) =>
		items.map((item) => item.type === "run" ? `run${item.members.length}:${item.isLiveTail ? "live" : "closed"}` : "step");

	it("never merges a single step", () => {
		expect(shape(foldTraceFlow(flow([tool("bash")]), true, isText))).toEqual(["step"]);
	});

	it("folds every run of two or more as closed once the turn is finished", () => {
		expect(shape(foldTraceFlow(flow([tool("bash"), tool("read"), prose, tool("bash"), tool("bash"), tool("bash")]), true, isText)))
			.toEqual(["run2:closed", "step", "run3:closed"]);
	});

	it("marks the trailing run as a live rolling group while streaming and closes earlier runs once prose follows", () => {
		expect(shape(foldTraceFlow(flow([tool("bash"), tool("read"), prose, tool("bash"), tool("bash")]), false, isText)))
			.toEqual(["run2:closed", "step", "run2:live"]);
		expect(shape(foldTraceFlow(flow([tool("bash"), tool("read")]), false, isText))).toEqual(["run2:live"]);
	});

	it("keeps question steps as standalone rows while grouping active steps into live runs", () => {
		const running = tool("bash", undefined, { status: "running" });
		const ask = tool("ask_user_question", undefined, { questionId: "q1" });
		expect(isFoldableTraceStep(running)).toBe(false);
		expect(isFoldableTraceStep(ask)).toBe(false);
		expect(shape(foldTraceFlow(flow([tool("bash"), tool("read"), ask, tool("bash"), tool("read"), running]), true, isText)))
			.toEqual(["run2:closed", "step", "run3:live"]);
	});
});

describe("formatCompactDuration", () => {
	it("matches the WorkBuddy format", () => {
		expect(formatCompactDuration(400)).toBe("<1s");
		expect(formatCompactDuration(42_000)).toBe("42s");
		expect(formatCompactDuration(344_000)).toBe("5m44s");
		expect(formatCompactDuration(300_000)).toBe("5m");
		expect(formatCompactDuration(3_900_000)).toBe("1h5m");
		expect(formatCompactDuration(3_600_000)).toBe("1h");
	});
});
