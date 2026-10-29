import type { ComponentProps } from "react";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { renderWithTooltipProvider as render } from "../test-utils.js";
import { ChatConversation } from "./ChatConversation.js";

vi.mock("react-i18next", () => {
	const t = (key: string, fallback?: string) => fallback ?? key;
	return { useTranslation: () => ({ t }) };
});
vi.mock("../MarkdownArtifact.js", () => ({ MarkdownArtifact: ({ content }: { content: string }) => <div>{content}</div> }));
vi.mock("./StreamingBubbles.js", () => ({ StreamingBubbles: () => null }));
vi.mock("./JobStreamBubbles.js", () => ({ JobStreamBubbles: () => null }));
vi.mock("../terminal/TerminalDrawer.js", () => ({ TerminalDrawer: () => null }));
vi.mock("./TodoWidget.js", () => ({ TodoWidget: () => null, extractTodoTasks: () => null }));
vi.mock("../ConversationMinimap.js", async (importOriginal) => ({
	...await importOriginal<typeof import("../ConversationMinimap.js")>(), ConversationMinimap: () => null,
}));
const originalTheme = document.documentElement.dataset.theme;
afterEach(() => {
	cleanup();
	if (originalTheme === undefined) delete document.documentElement.dataset.theme;
	else document.documentElement.dataset.theme = originalTheme;
});

it.each(["light", "dark"])("places final cards above the time/actions in %s, after completion and in history", async (theme) => {
	document.documentElement.dataset.theme = theme;
	const onOpenDocument = vi.fn();
	const props: ComponentProps<typeof ChatConversation> = {
		chat: {
			messages: [
				{ role: "user", content: "生成报告", timestamp: 1 },
				{ role: "assistant", content: "处理中", timestamp: 2, traceEvents: [
					{ event: { type: "text_delta", delta: "处理中" } },
					{ event: { type: "workspace_change", workspaceId: "original", changes: [{ path: "report.docx", change: "created" }] } },
					{ event: { type: "workspace_change", workspaceId: "original", changes: [{ path: "report.docx", change: "modified" }] } },
				] },
				{ role: "assistant", content: "已完成", timestamp: 3 },
			],
			isSending: true, isLoadingHistory: false, jobStreaming: false, jobStreamInCurrentSession: false,
			activeTools: [], completedTools: [], pendingQuestion: null,
		},
		scrollRef: { current: null }, onScroll: vi.fn(), onPauseAutoScroll: vi.fn(), showLatestButton: false,
		onJumpToLatest: vi.fn(), questionHint: null, busyBlocker: null, smartToast: null, composer: null,
		onOpenAttachment: vi.fn(), onOpenDocument, onOpenSkill: vi.fn(), onEditMessage: vi.fn(),
		canRetry: false, onRetry: vi.fn(), wsError: "",
	};
	const view = render(<ChatConversation {...props} />);
	const expectCardBeforeActions = () => {
		const card = screen.getByRole("button", { name: "report.docx" });
		const bubble = card.closest(".inno-assistant-message");
		expect(bubble).not.toBeNull();
		const actions = bubble!.querySelector(".inno-message-actions")!;
		expect(actions.querySelector("time")).not.toBeNull();
		expect(card.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(bubble!.textContent).toContain("处理中");
	};
	expect(screen.queryByRole("button", { name: "report.docx" })).toBeNull();
	view.rerender(<ChatConversation {...props} chat={{ ...props.chat, isSending: false }} />);
	await waitFor(() => expect(screen.getAllByRole("button", { name: "report.docx" })).toHaveLength(1));
	expectCardBeforeActions();
	fireEvent.click(screen.getByRole("button", { name: "report.docx" }));
	expect(onOpenDocument).toHaveBeenCalledExactlyOnceWith({ path: "report.docx", workspaceId: "original", kind: "doc", type: "Word" });
	cleanup();
	render(<ChatConversation {...props} chat={{ ...props.chat, isSending: false }} />);
	expect(screen.getAllByRole("button", { name: "report.docx" })).toHaveLength(1);
	expectCardBeforeActions();
});
