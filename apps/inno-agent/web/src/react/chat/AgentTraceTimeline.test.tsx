// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithTooltipProvider as render } from "../test-utils.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatTraceStep } from "../../types/chat.js";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (_key: string, fallback: string, options?: Record<string, unknown>) => fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name] ?? `{{${name}}}`)),
	}),
}));

import { AgentTraceTimeline } from "./AgentTraceTimeline.js";

beforeEach(() => {
	vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const thinking: ChatTraceStep = {
	id: "thinking:0",
	kind: "thinking",
	status: "completed",
	title: "思考",
	text: "先检查输入，再给出结论。",
};

describe("AgentTraceTimeline", () => {
	const officeTool: ChatTraceStep = {
		id: "office:create", kind: "tool", status: "completed", title: "office_create_document",
		toolName: "office_create_document", args: { path: "我的妈妈.pptx", slides: [{ title: "我的妈妈" }] },
		partialResult: { content: [{ type: "text", text: "正在创建" }] },
		result: { content: [{ type: "text", text: "已生成 slide 文档：我的妈妈.pptx。" }], details: { created: "我的妈妈.pptx" } },
	};

	it.each(["light", "dark"])("shows readable results before optional raw data in %s theme", (theme) => {
		document.documentElement.setAttribute("data-theme", theme);
		try {
			render(<AgentTraceTimeline steps={[officeTool]} />);
			fireEvent.click(screen.getByRole("button", { name: /展开创建文档/ }));
			expect(screen.getByText("已生成 slide 文档：我的妈妈.pptx。")).toBeTruthy();
			expect(screen.queryByText("正在创建")).toBeNull();
			expect(document.querySelector(".inno-trace-payload")).toBeNull();
			fireEvent.click(screen.getByRole("button", { name: "原始数据" }));
			expect(screen.getByRole("tabpanel").textContent).toContain('"slides"');
			const argsTab = screen.getByRole("tab", { name: "参数" });
			fireEvent.keyDown(argsTab, { key: "End" });
			expect(screen.getByRole("tab", { name: "结果" }).getAttribute("aria-selected")).toBe("true");
			expect(screen.getByRole("tabpanel").textContent).toContain('"details"');
			expect(document.querySelectorAll(".inno-trace-payload")).toHaveLength(1);
			fireEvent.click(screen.getByRole("button", { name: "原始数据" }));
			expect(screen.queryByRole("tabpanel")).toBeNull();
		} finally {
			document.documentElement.removeAttribute("data-theme");
		}
	});

	it("copies the selected payload and reports clipboard failures", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
		render(<AgentTraceTimeline steps={[officeTool]} />);
		fireEvent.click(screen.getByRole("button", { name: /展开创建文档/ }));
		fireEvent.click(screen.getByRole("button", { name: "原始数据" }));
		fireEvent.click(screen.getByRole("tab", { name: "结果" }));
		fireEvent.click(screen.getByRole("button", { name: "复制原始数据" }));
		await waitFor(() => expect(screen.getByRole("status").textContent).toBe("已复制"));
		expect(writeText).toHaveBeenCalledWith(JSON.stringify(officeTool.result, null, 2));
		writeText.mockRejectedValueOnce(new Error("permission denied"));
		fireEvent.click(screen.getByRole("button", { name: "复制原始数据" }));
		await waitFor(() => expect(screen.getByRole("status").textContent).toContain("复制失败"));
	});

	it("keeps structured results and question data accessible for unknown tools", () => {
		render(<AgentTraceTimeline steps={[{ ...officeTool, toolName: "custom_tool", result: { records: [1, 2] }, questionParams: { questions: [{ header: "方向", question: "选择方向", options: [] }] } }]} />);
		fireEvent.click(screen.getByRole("button", { name: /展开custom_tool/ }));
		expect(screen.getByText("返回了结构化数据，可查看原始数据")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "原始数据" }));
		fireEvent.click(screen.getByRole("tab", { name: "结果" }));
		expect(screen.getByRole("tabpanel").textContent).toContain('"records"');
		fireEvent.click(screen.getByRole("tab", { name: "提问" }));
		expect(screen.getByRole("tabpanel").textContent).toContain("选择方向");
	});

	it("shows error text immediately and replaces partial output when the final result arrives", () => {
		const view = render(<AgentTraceTimeline steps={[{ ...officeTool, status: "running", result: undefined }]} />);
		fireEvent.click(screen.getByRole("button", { name: /展开执行中/ }));
		expect(screen.getByText("正在创建")).toBeTruthy();
		view.rerender(<AgentTraceTimeline steps={[{ ...officeTool, status: "error", result: "文档保存失败" }]} />);
		expect(screen.getByText("文档保存失败")).toBeTruthy();
		expect(screen.getByText("错误")).toBeTruthy();
		expect(screen.queryByText("正在创建")).toBeNull();
		expect(document.querySelector(".inno-trace-tool-details.has-error")).not.toBeNull();
		expect(document.querySelector(".inno-trace-row.is-error")).not.toBeNull();
		expect(document.querySelector(".inno-trace-payload")).toBeNull();
	});

	it("offers full text only when content overflows and keeps short durations readable", () => {
		vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(600);
		vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(190);
		render(<AgentTraceTimeline steps={[{ ...officeTool, result: "长结果\n".repeat(20) }, { ...thinking, durationMs: 100 }]} />);
		expect(screen.getByRole("button", { name: /展开思考完成/ }).textContent).toContain("<1 秒");
		fireEvent.click(screen.getByRole("button", { name: /展开创建文档/ }));
		fireEvent.click(screen.getByRole("button", { name: "展开全文" }));
		expect(document.querySelector(".inno-trace-readable.is-expanded")).not.toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "收起全文" }));
		expect(document.querySelector(".inno-trace-readable.is-clipped")).not.toBeNull();
	});

	it("does not hide structured error diagnostics behind raw data", () => {
		render(<AgentTraceTimeline steps={[{ ...officeTool, status: "error", result: { error: "permission denied" } }]} />);
		fireEvent.click(screen.getByRole("button", { name: /展开失败/ }));
		expect(screen.getByText(/permission denied/)).toBeTruthy();
		expect(screen.queryByRole("tabpanel")).toBeNull();
	});

	it.each(["light", "dark"])("hides the settled card in %s theme without hiding the answer or real errors", (theme) => {
		const previousTheme = document.documentElement.getAttribute("data-theme");
		document.documentElement.setAttribute("data-theme", theme);
		try {
			render(<AgentTraceTimeline showText steps={[
				{ id: "answer", kind: "answer", status: "completed", title: "回复", text: "文档已完成" },
				{ id: "settled", kind: "system", status: "completed", title: "settled", eventType: "agent_settled", eventDetail: { aborted: false } },
				{ id: "failure", kind: "error", status: "error", title: "请求失败", text: "provider timeout" },
			]} />);
			expect(screen.queryByText("settled")).toBeNull();
			expect(screen.queryByRole("button", { name: /settled/ })).toBeNull();
			expect(screen.getByText("文档已完成")).toBeTruthy();
			expect(screen.getByRole("button", { name: /请求失败/ })).toBeTruthy();
		} finally {
			if (previousTheme === null) document.documentElement.removeAttribute("data-theme");
			else document.documentElement.setAttribute("data-theme", previousTheme);
		}
	});

	it("renders a collapsed one-line row and expands the full payload inline", () => {
		render(<AgentTraceTimeline steps={[thinking]} />);

		const row = screen.getByRole("button", { name: /展开思考/ });
		expect(row).toBeTruthy();
		expect(row.textContent).toContain("思考完成");
		expect(document.querySelector(".inno-trace-row-details")).toBeNull();

		fireEvent.click(row);
		expect(document.querySelector(".inno-trace-row-details")?.textContent).toContain("先检查输入，再给出结论。");
		expect(row.getAttribute("aria-expanded")).toBe("true");
	});

	it("labels pauses and failures instead of claiming the turn completed", () => {
		const interrupted: ChatTraceStep = {
			id: "aborted:1",
			kind: "error",
			status: "error",
			title: "已停止",
			text: "Stopped by user",
		};
		const view = render(
			<AgentTraceTimeline
				steps={[interrupted]}
				terminalState={{ status: "aborted", reason: "Stopped by user" }}
			/>,
		);
		expect(document.querySelector(".inno-trace-work-status")?.textContent).toContain("用户主动暂停");
		expect(document.querySelector(".inno-trace-work-status")?.textContent).not.toContain("已完成");

		view.rerender(
			<AgentTraceTimeline
				steps={[{ ...interrupted, title: "请求失败", text: "provider timeout" }]}
				terminalState={{ status: "error", reason: "provider timeout" }}
			/>,
		);
		expect(document.querySelector(".inno-trace-work-status")?.textContent).toContain("因其他原因中断");
	});

	it("marks a trace without a terminal event as incomplete", () => {
		render(
			<AgentTraceTimeline
				steps={[{ ...thinking, status: "completed" }]}
				terminalState={{ status: "unknown" }}
			/>,
		);
		expect(document.querySelector(".inno-trace-work-status")?.textContent).toContain("未完成 · 原因未知");
	});

	it("expands only the clicked thinking row when trace ids are duplicated", () => {
		render(
			<AgentTraceTimeline
				steps={[
					{ ...thinking, text: "第一段思考" },
					{ ...thinking, text: "第二段思考" },
				]}
			/>,
		);

		const rows = screen.getAllByRole("button");
		expect(rows).toHaveLength(2);

		fireEvent.click(rows[0]!);

		expect(document.querySelectorAll(".inno-trace-row-details")).toHaveLength(1);
		expect(rows[0]!.getAttribute("aria-expanded")).toBe("true");
		expect(rows[1]!.getAttribute("aria-expanded")).toBe("false");
	});

	it("anchors a pending question card after its waiting trace row", () => {
		render(
			<AgentTraceTimeline
				showText
				steps={[
					{ ...thinking, text: "先准备问题" },
					{
						id: "question:q1",
						kind: "tool",
						status: "waiting",
						title: "等待你的回答",
						toolName: "ask_user_question",
						questionId: "q1",
					},
				]}
				pendingQuestion={{
					questionId: "q1",
					card: <div data-testid="pending-question-card">问题卡片</div>,
				}}
			/>,
		);

		const flow = document.querySelector(".inno-trace-flow");
		expect(flow).not.toBeNull();
		expect(Array.from(flow!.children).map((child) => {
			if (child.classList.contains("inno-trace-body")) return "body";
			if (child.classList.contains("inno-trace-questionnaire")) return "question";
			return "trace";
		})).toEqual(["trace", "trace", "question"]);
		expect(screen.getByTestId("pending-question-card").textContent).toBe("问题卡片");
	});

	it("keeps a pending question below an ask row while the trace is still being prepared", () => {
		render(
			<AgentTraceTimeline
				showText
				steps={[{ ...thinking, text: "正在生成问题" }]}
				pendingQuestion={{
					questionId: "q2",
					card: <div data-testid="pending-question-card">问题卡片</div>,
				}}
			/>,
		);

		const flow = document.querySelector(".inno-trace-flow");
		expect(flow).not.toBeNull();
		expect(flow!.querySelectorAll(".inno-trace-row")).toHaveLength(2);
		expect(flow!.querySelectorAll(".inno-trace-row").item(1).textContent).toContain("等待你的回答");
		expect(Array.from(flow!.children).map((child) => child.classList.contains("inno-trace-questionnaire") ? "question" : "trace"))
			.toEqual(["trace", "trace", "question"]);
	});

	it("shimmers only the active thinking title and keeps completed text stable", () => {
		render(
			<AgentTraceTimeline
				isSending
				steps={[{ ...thinking, status: "active", text: "正在分析" }]}
			/>,
		);

		const title = document.querySelector(".inno-trace-row-title.is-shimmering");
		expect(title?.textContent).toContain("思考");
		expect(title?.querySelector(".inno-trace-title-shimmer")?.textContent).toBe("思考中");
		expect(title?.querySelector(".inno-trace-title-shimmer")?.getAttribute("aria-hidden")).toBe("true");
		expect(document.querySelector(".inno-trace-row-details")).toBeNull();
	});

	it("keeps a long live thinking summary on one line and follows its tail", () => {
		const longThinking = `开头 ${"中间内容 ".repeat(30)}最新一个字`;
		render(
			<AgentTraceTimeline
				isSending
				steps={[{ ...thinking, status: "active", text: longThinking }]}
			/>,
		);

		const title = document.querySelector(".inno-trace-row-title");
		expect(title?.textContent).toContain("最新一个字");
		expect(title?.textContent).not.toContain("开头");
	});

	it("shimmers only the last active thinking row", () => {
		render(
			<AgentTraceTimeline
				isSending
				steps={[
					{ ...thinking, id: "thinking:1", status: "active", text: "旧阶段" },
					{ ...thinking, id: "thinking:2", status: "active", text: "当前阶段" },
				]}
			/>,
		);

		expect(document.querySelectorAll(".inno-trace-row-title.is-shimmering")).toHaveLength(1);
		expect(document.querySelector(".inno-trace-row-title.is-shimmering")?.textContent).toContain("思考");
	});

	it("shimmers the current running tool title instead of completed stages", () => {
		render(
			<AgentTraceTimeline
				isSending
				steps={[
					{
						id: "tool:read",
						kind: "tool",
						status: "completed",
						title: "read",
						toolName: "read",
						toolCallId: "read",
						args: { path: "notes.md" },
					},
					{
						id: "tool:bash",
						kind: "tool",
						status: "running",
						title: "bash",
						toolName: "bash",
						toolCallId: "bash",
						args: { command: "printf hello" },
					},
				]}
			/> ,
		);

		const shimmering = document.querySelector(".inno-trace-row-title.is-shimmering");
		expect(document.querySelectorAll(".inno-trace-row-title.is-shimmering")).toHaveLength(1);
		expect(shimmering?.textContent).toContain("bash");
		expect(shimmering?.querySelector(".inno-trace-title-shimmer")?.textContent).toBe("执行中 · bash · printf hello");
		expect(shimmering?.querySelector(".inno-trace-title-shimmer-target")?.classList.contains("is-full-line")).toBe(true);
		expect(document.querySelectorAll(".inno-trace-title-shimmer")).toHaveLength(1);
	});

	it("shimmers an open tool row even when the sending flag is unavailable", () => {
		render(
			<AgentTraceTimeline
				steps={[{
					id: "tool:question",
					kind: "tool",
					status: "waiting",
					title: "等待你的回答",
					toolName: "ask_user_question",
					toolCallId: "question",
					args: { questions: [{ header: "问题方向" }] },
				}]}
			/>,
		);

		const shimmering = document.querySelector(".inno-trace-row-title.is-shimmering");
		expect(shimmering).not.toBeNull();
		expect(shimmering?.querySelector(".inno-trace-title-shimmer")?.textContent).toContain("等待你的回答");
	});

	it("shows the concrete tool name and the latest one-line partial output", () => {
		render(
			<AgentTraceTimeline
				steps={[
					{
						id: "tool:bash",
						kind: "tool",
						status: "running",
						title: "bash",
						toolName: "bash",
						toolCallId: "bash",
						args: { command: "printf hello" },
						partialResult: { content: [{ type: "text", text: "hello" }] },
					},
					{
						id: "tool:read",
						kind: "tool",
						status: "running",
						title: "read",
						toolName: "read",
						toolCallId: "read",
						args: { path: "notes.md" },
					},
				]}
			/>,
		);

		const rows = document.querySelectorAll(".inno-trace-row");
		expect(rows[0]?.textContent).toContain("执行中 · bash · printf hello · hello");
		expect(rows[1]?.textContent).toContain("执行中 · read · notes.md");

		fireEvent.click(screen.getAllByRole("button")[0]!);
		expect(document.querySelector(".inno-trace-row-details")?.textContent).toContain("实时结果");
	});

	it("leaves assistant progress text to the normal body renderer", () => {
		render(
			<AgentTraceTimeline
				steps={[
					{
						id: "progress:0",
						kind: "progress",
						status: "completed",
						title: "正在组织回复",
						text: "这是正文，不是工具调用。",
					},
					{
						id: "tool:t1",
						kind: "tool",
						status: "completed",
						title: "已完成 · 查询资料",
						toolName: "search",
						toolCallId: "t1",
					},
				]}
			/>,
		);

		expect(document.querySelectorAll(".inno-trace-row")).toHaveLength(1);
		expect(document.querySelector(".inno-trace-row")?.textContent).not.toContain("这是正文");
	});

	it("keeps ordinary body blocks in their original position in the process flow", () => {
		render(
			<AgentTraceTimeline
				showText
				steps={[
					{ ...thinking, id: "thinking:before", text: "先思考" },
					{
						id: "progress:0",
						kind: "progress",
						status: "completed",
						title: "正在组织回复",
						text: "第一段正文",
					},
					{
						id: "tool:t1",
						kind: "tool",
						status: "completed",
						title: "查询资料",
						toolName: "search",
						toolCallId: "t1",
					},
					{
						id: "answer:1",
						kind: "answer",
						status: "completed",
						title: "回复",
						text: "第二段正文",
					},
				]}
			/>,
		);

		const flow = document.querySelector(".inno-trace-flow");
		expect(flow).not.toBeNull();
		expect(Array.from(flow!.children).map((child) => child.classList.contains("inno-trace-body"))).toEqual([
			false,
			true,
			false,
			true,
		]);
		expect(flow?.querySelectorAll(".inno-trace-body")).toHaveLength(2);
	});

	it("keeps tool and skill details behind the same row interaction", () => {
		const onOpenSkill = vi.fn();
		render(
			<AgentTraceTimeline
				steps={[
					{
						id: "tool:t1",
						kind: "tool",
						status: "error",
						title: "读取 notes.md",
						toolName: "read_file",
						toolCallId: "t1",
						args: { path: "notes.md" },
						result: "not found",
						isError: true,
					},
					{
						id: "skill:docs",
						kind: "skill",
						status: "completed",
						title: "已载入技能 · docs",
						skillName: "docs",
						skillState: "expanded",
					},
				]}
				onOpenSkill={onOpenSkill}
			/>,
		);

		const rows = screen.getAllByRole("button");
		expect(rows).toHaveLength(2);
		fireEvent.click(rows[1]);
		fireEvent.click(screen.getByRole("button", { name: "打开 Skills 面板" }));
		expect(onOpenSkill).toHaveBeenCalledWith("docs");
	});

	it("keeps internal bookkeeping and child-task timing out of the surface", () => {
		render(
			<AgentTraceTimeline
				steps={[
					{
						id: "system:turn",
						kind: "system",
						status: "completed",
						title: "开始本轮任务",
						eventType: "turn_start",
						durationMs: 2_000,
					},
					{
						id: "skill:loaded",
						kind: "skill",
						status: "completed",
						title: "已预载 1 个技能",
						durationMs: 2_000,
					},
					{
						id: "tool:t2",
						kind: "tool",
						status: "completed",
						title: "读取 notes.md",
						toolName: "read_file",
						toolCallId: "t2",
						durationMs: 3_000,
					},
				]}
			/>,
		);

		const content = document.body.textContent ?? "";
		expect(content).not.toContain("开始本轮任务");
		expect(content).not.toContain("2 秒");
		expect(content).not.toContain("3 秒");
	});
});
