// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatStore } from "../../stores/chat-store.js";
import { renderWithTooltipProvider } from "../test-utils.js";
import { ChatConversation } from "./ChatConversation.js";

vi.mock("react-i18next", () => {
	const t = (key: string, fallback?: string) => fallback ?? key;
	return { useTranslation: () => ({ t, i18n: { language: "zh-CN" } }) };
});
vi.mock("../MarkdownArtifact.js", () => ({
	MarkdownArtifact: ({ content, streaming, animate }: { content: string; streaming?: boolean; animate?: boolean }) => (
		<div data-testid="markdown-body" data-streaming={String(Boolean(streaming))} data-animate={String(animate)}>
			{content}
		</div>
	),
}));
vi.mock("./JobStreamBubbles.js", () => ({ JobStreamBubbles: () => null }));
vi.mock("../terminal/TerminalDrawer.js", () => ({ TerminalDrawer: () => null }));
vi.mock("./TodoWidget.js", () => ({ TodoWidget: () => null, extractTodoTasks: () => null }));
vi.mock("../ConversationMinimap.js", async (importOriginal) => ({
	...await importOriginal<typeof import("../ConversationMinimap.js")>(),
	ConversationMinimap: () => null,
}));

function resetChatStoreStream() {
	chatStore.streamingText = "";
	chatStore.streamingTrace = [];
	chatStore.completedTools = [];
	chatStore.isSending = false;
	chatStore.streamingError = "";
	chatStore.streamingStartedAt = null;
	chatStore.streamingFinishedAt = null;
	chatStore.pendingQuestion = null;
	chatStore.pendingPermission = null;
}

afterEach(() => {
	cleanup();
	resetChatStoreStream();
});

function baseProps(overrides?: Partial<ComponentProps<typeof ChatConversation>["chat"]>): ComponentProps<typeof ChatConversation> {
	return {
		chat: {
			messages: [{ role: "user", content: "你好", timestamp: 1000 }],
			isSending: false,
			isLoadingHistory: false,
			jobStreaming: false,
			jobStreamInCurrentSession: false,
			activeTools: [],
			completedTools: [],
			pendingQuestion: null,
			...overrides,
		},
		scrollRef: { current: null },
		onScroll: vi.fn(),
		onPauseAutoScroll: vi.fn(),
		showLatestButton: false,
		onJumpToLatest: vi.fn(),
		questionHint: null,
		busyBlocker: null,
		smartToast: null,
		composer: null,
		onOpenAttachment: vi.fn(),
		onOpenSkill: vi.fn(),
		onEditMessage: vi.fn(),
		canRetry: false,
		onRetry: vi.fn(),
		wsError: "",
	};
}

describe("ChatConversation streaming-to-settled handoff", () => {
	it("keeps the prose DOM node mounted and full-width when a plain-text reply finishes", () => {
		chatStore.isSending = true;
		chatStore.streamingText = "这是一段流式回复正文。";
		chatStore.streamingTrace = [
			{ id: "progress:0", kind: "answer", status: "active", title: "回复", text: "这是一段流式回复正文。" },
		];

		const view = renderWithTooltipProvider(
			<ChatConversation {...baseProps({ isSending: true })} />,
		);

		const liveMarkdown = screen.getByTestId("markdown-body");
		const liveBubble = liveMarkdown.closest(".inno-assistant-message")!;
		expect(liveMarkdown.textContent).toBe("这是一段流式回复正文。");
		expect(liveBubble.className).not.toContain("max-w-[78%]");

		// Simulate finalizeOwner: store resets stream fields and canonical assistant message lands.
		resetChatStoreStream();
		view.rerender(
			<ChatConversation
				{...baseProps({
					isSending: false,
					messages: [
						{ role: "user", content: "你好", timestamp: 1000, entryId: "u1" },
						{ role: "assistant", content: "这是一段流式回复正文。", timestamp: 2000, entryId: "a1" },
					],
				})}
			/>,
		);

		const settledMarkdown = screen.getByTestId("markdown-body");
		const settledBubble = settledMarkdown.closest(".inno-assistant-message")!;
		// Exact same DOM node survives live -> settled without unmount/remount.
		expect(settledMarkdown).toBe(liveMarkdown);
		expect(settledBubble).toBe(liveBubble);
		expect(settledBubble.className).not.toContain("max-w-[78%]");
		expect(settledBubble.querySelector(".inno-message-actions")).not.toBeNull();
	});

	it("keeps the prose DOM node mounted when a trace-backed reply settles", () => {
		chatStore.isSending = true;
		chatStore.streamingText = "最终结论";
		chatStore.streamingStartedAt = "2026-11-28T15:00:00.000Z";
		chatStore.streamingTrace = [
			{ id: "thinking:0", kind: "thinking", status: "completed", title: "思考", text: "先分析" },
			{ id: "tool:t1", kind: "tool", status: "completed", title: "read", toolCallId: "t1", toolName: "read" },
			{ id: "progress:0", kind: "answer", status: "active", title: "回复", text: "最终结论" },
		];

		const view = renderWithTooltipProvider(
			<ChatConversation {...baseProps({ isSending: true })} />,
		);

		const liveMarkdown = screen.getByTestId("markdown-body");
		expect(liveMarkdown.textContent).toBe("最终结论");

		resetChatStoreStream();
		view.rerender(
			<ChatConversation
				{...baseProps({
					isSending: false,
					messages: [
						{ role: "user", content: "分析代码", timestamp: 1000, entryId: "u1" },
						{
							role: "assistant",
							content: "最终结论",
							timestamp: 2000,
							entryId: "a1",
							traceStartedAt: "2026-11-28T15:00:00.000Z",
							traceFinishedAt: "2026-11-28T15:00:02.000Z",
							trace: [
								{ id: "thinking:0", kind: "thinking", status: "completed", title: "思考", text: "先分析" },
								{ id: "tool:t1", kind: "tool", status: "completed", title: "read", toolCallId: "t1", toolName: "read" },
								{ id: "legacy:answer", kind: "answer", status: "completed", title: "回复", text: "最终结论" },
							],
						},
					],
				})}
			/>,
		);

		// Even when canonical step IDs normalize (progress:0 -> legacy:answer),
		// the prose DOM node stays mounted in place.
		const settledMarkdown = screen.getByTestId("markdown-body");
		expect(settledMarkdown).toBe(liveMarkdown);
	});

	it("renders cold-loaded plain-text assistant replies at full 100% lane width", () => {
		const { container } = renderWithTooltipProvider(
			<ChatConversation
				{...baseProps({
					isSending: false,
					messages: [
						{ role: "user", content: "hi", timestamp: 1000, entryId: "u1" },
						{ role: "assistant", content: "hello world", timestamp: 2000, entryId: "a1" },
					],
				})}
			/>,
		);
		const bubble = container.querySelector(".inno-assistant-message")!;
		expect(bubble.className).toContain("w-full");
		expect(bubble.className).not.toContain("max-w-[78%]");
	});
});
