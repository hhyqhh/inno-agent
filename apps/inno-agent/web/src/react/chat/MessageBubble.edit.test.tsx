// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => key === "chat.editAndResend" ? "Edit and resend" : key,
	}),
}));

import type { ChatMessage } from "../../types/chat.js";
import { MessageBubble } from "./MessageBubble.js";

afterEach(cleanup);

const plainUserMessage: ChatMessage = {
	role: "user",
	content: "teh quadratic formula",
	timestamp: 1,
	channel: "web",
	entryId: "user-entry",
};

describe("MessageBubble edit and resend", () => {
	it("offers a plain Web user message for editing", () => {
		const onEdit = vi.fn();
		render(<MessageBubble message={plainUserMessage} onEdit={onEdit} />);

		fireEvent.click(screen.getByRole("button", { name: "Edit and resend" }));

		expect(onEdit).toHaveBeenCalledWith(plainUserMessage);
	});

	it("offers a file message for editing", () => {
		const message: ChatMessage = {
			...plainUserMessage,
			attachments: {
				bindings: [],
				loose: [{ path: "question.pdf", kind: "pdf", source: "workspace" }],
			},
		};

		const onEdit = vi.fn();
		render(<MessageBubble message={message} onEdit={onEdit} />);

		fireEvent.click(screen.getByRole("button", { name: "Edit and resend" }));
		expect(onEdit).toHaveBeenCalledWith(message);
	});

	it("offers an expanded skill message for editing", () => {
		const message: ChatMessage = {
			...plainUserMessage,
			content: '<skill name="lesson-plan" location="/tmp/lesson-plan/SKILL.md">\n# Lesson Plan\n</skill>',
		};
		const onEdit = vi.fn();
		render(<MessageBubble message={message} onEdit={onEdit} />);

		fireEvent.click(screen.getByRole("button", { name: "Edit and resend" }));
		expect(onEdit).toHaveBeenCalledWith(message);
	});

	it("does not offer editing for a transient message without a persisted entry id", () => {
		const { entryId: _entryId, ...message } = plainUserMessage;

		render(<MessageBubble message={message} onEdit={vi.fn()} />);

		expect(screen.queryByRole("button", { name: "Edit and resend" })).toBeNull();
	});

	it("shows the sent-message time and copies the original content", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		const previousClipboard = navigator.clipboard;
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText },
		});

		try {
			const now = new Date();
			const timestamp = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 22, 35).getTime();
			render(<MessageBubble message={{ ...plainUserMessage, timestamp }} />);

			expect(screen.getByText("22:35")).toBeTruthy();
			fireEvent.click(screen.getByRole("button", { name: "common.copy" }));

			await waitFor(() => {
				expect(writeText).toHaveBeenCalledWith(plainUserMessage.content);
			});
		} finally {
			Object.defineProperty(navigator, "clipboard", {
				configurable: true,
				value: previousClipboard,
			});
		}
	});

	it("shows copy, time, and retry actions for the last assistant message", () => {
		const onRetry = vi.fn();
		const now = new Date();
		const timestamp = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 22, 35).getTime();
		render(
			<MessageBubble
				message={{ role: "assistant", content: "answer", timestamp }}
				showRetry
				onRetry={onRetry}
			/>,
		);

		expect(screen.getByText("22:35")).toBeTruthy();
		expect(screen.getByRole("button", { name: "common.copy" })).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "chat.retryLast" }));
		expect(onRetry).toHaveBeenCalledTimes(1);
	});

});
