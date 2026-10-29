import { describe, expect, it } from "vitest";
import type { ChatMessage, ChatStreamEvent } from "../types/chat.js";
import { officeDeliverables } from "./office-deliverables.js";

const message = (events: ChatStreamEvent[]): ChatMessage => ({
	role: "assistant", content: "完成", timestamp: 1,
	traceEvents: events.map((event) => ({ event })),
});

describe("Office deliverables from persisted turn events", () => {
	it("deduplicates repeated saves, preserves ownership and removes deleted outputs", () => {
		const changes = (workspaceId: string, path: string, change: "created" | "modified" | "deleted"): ChatStreamEvent => ({ type: "workspace_change", workspaceId, changes: [{ path, change }] });
		expect(officeDeliverables([message([
			changes("owner", "report.docx", "created"),
			changes("owner", "report.docx", "modified"),
			changes("other", "report.docx", "created"),
			changes("owner", "draft.pptx", "created"),
			changes("owner", "draft.pptx", "deleted"),
			changes("owner", "budget.XLSX", "created"),
		])], "current")).toEqual([
			{ workspaceId: "owner", path: "report.docx", kind: "doc", type: "Word" },
			{ workspaceId: "other", path: "report.docx", kind: "doc", type: "Word" },
			{ workspaceId: "owner", path: "budget.XLSX", kind: "xls", type: "Excel" },
		]);
	});

	it("excludes preview assets, unsafe paths, lock files and read-only input documents", () => {
		const input = message([{ type: "workspace_change", changes: [
			".inno-previews/a.pdf", ".inno-previews/a.png", ".inno-previews/a.docx",
			"../a.docx", "/tmp/a.docx", "C:\\tmp\\a.docx", "~$report.docx", "notes.md",
		].map((path) => ({ path, change: "created" })) }]);
		input.tools = [{ toolCallId: "read", toolName: "office_open_document", args: { path: "input.docx" }, result: { docId: "1" } }];
		expect(officeDeliverables([input], null)).toEqual([]);
	});

	it("supports live and older reduced traces without a separate delivery registry", () => {
		const input: ChatMessage = { role: "assistant", content: "完成", timestamp: 1, trace: [{
			id: "tool", kind: "tool", status: "completed", title: "写入", workspaceChanges: [
				{ path: "slides.pptx", change: "created" }, { path: "slides.pptx", change: "modified" },
			],
		}] };
		expect(officeDeliverables([input], "session-workspace")).toEqual([
			{ workspaceId: "session-workspace", path: "slides.pptx", kind: "ppt", type: "PowerPoint" },
		]);
	});
});
