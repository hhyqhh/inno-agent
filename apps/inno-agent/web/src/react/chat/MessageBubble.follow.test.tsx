// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { cleanup, waitFor } from "@testing-library/react";
import { renderWithTooltipProvider as render } from "../test-utils.js";
import { fireEvent } from "@testing-library/dom";
import { MessageBubble } from "./MessageBubble.js";
import type { ChatMessage } from "../../types/chat.js";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));

// The sent-message binding panel must re-anchor when the layout shifts
// (window expansion, streaming reflow): resize/scroll listeners and a rAF
// loop keep the portal glued to its anchor pill.

let anchorLeft = 100;
const rectSpy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
	const base = { right: anchorLeft + 40, top: 300, bottom: 316, left: anchorLeft, width: 40, height: 16, x: anchorLeft, y: 300, toJSON: () => ({}) };
	return base as DOMRect;
});
Object.defineProperty(window, "innerWidth", { value: 1600, configurable: true });
Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });

const message: ChatMessage = {
	id: "m1",
	role: "user",
	content: "请阅读 pdf 的内容",
	attachments: {
		bindings: [{ word: "pdf", wordIndex: 0, files: [{ path: "a.pdf", kind: "pdf" as const, source: "workspace" as const }] }],
		loose: [],
	},
} as unknown as ChatMessage;

async function openPanel() {
	render(<MessageBubble message={message} />);
	const pill = document.querySelector(".inno-smart-ref-inline") as HTMLElement;
	expect(pill).toBeTruthy();
	fireEvent.mouseOver(pill, { relatedTarget: document.body });
	fireEvent.mouseEnter(pill);
	await waitFor(() => {
		expect(document.querySelector(".inno-smart-panel--readonly")).toBeTruthy();
	}, { timeout: 2000 });
	return document.querySelector(".inno-smart-panel--readonly") as HTMLElement;
}

describe("SentBindingPanel anchor follow", () => {
	it("repositions after window resize while open", async () => {
		const panel = await openPanel();
		// layout shift: anchor pill moves right 300px
		anchorLeft = 400;
		fireEvent.resize(window);
		await waitFor(() => {
			const left = Number.parseFloat(panel.style.left);
			expect(left).toBeGreaterThanOrEqual(390);
		}, { timeout: 1000 });
		cleanup();
	});

	it("repositions after scroll while open", async () => {
		const panel = await openPanel();
		anchorLeft = 700;
		fireEvent.scroll(document);
		await waitFor(() => {
			const left = Number.parseFloat(panel.style.left);
			expect(left).toBeGreaterThanOrEqual(690);
		}, { timeout: 1000 });
		cleanup();
		rectSpy.mockRestore();
	});
});
