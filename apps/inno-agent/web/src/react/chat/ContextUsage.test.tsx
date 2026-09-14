import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextUsage, formatContextTokens } from "./ContextUsage.js";
import { fetchSessionContextUsage, type SessionContextUsage } from "../../api/sessions.js";
vi.mock("../../api/sessions.js", () => ({ fetchSessionContextUsage: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, args?: Record<string, string>) => args?.percent ? `${args.percent} · ${args.amount}` : args?.amount ?? key }) }));
const fetchUsage = vi.mocked(fetchSessionContextUsage);
const data: SessionContextUsage = {
	sessionId: "s1", status: "ready", source: "sdk", tokens: 65700, contextWindow: 262144, percent: 25.1,
	breakdown: [{ id: "system", tokens: 1000, percent: 0.4 }, { id: "messages", tokens: 64700, percent: 24.7 }],
};
beforeEach(() => {
	vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
	fetchUsage.mockReset(); fetchUsage.mockResolvedValue(data);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const renderUsage = () => render(<ContextUsage sessionId="s1" streaming={false} revision="1" />);

describe("ContextUsage", () => {
	it("shows a tooltip and a portaled breakdown; restores focus on Escape", async () => {
		const { container } = renderUsage();
		const trigger = await screen.findByRole("button", { name: /25.1%/ });
		fireEvent.mouseEnter(trigger);
		expect(screen.getByRole("tooltip").textContent).toContain("65.7K / 262.1K");
		fireEvent.click(trigger);
		const panel = screen.getByRole("dialog");
		expect(container.contains(panel)).toBe(false);
		expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("25.1");
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "contextUsage.close" }));
		fireEvent.keyDown(document, { key: "Escape" });
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(document.activeElement).toBe(trigger);
	});
	it("closes on outside click and on the close button", async () => {
		renderUsage();
		const trigger = await screen.findByRole("button", { name: /25.1%/ });
		fireEvent.click(trigger); fireEvent.pointerDown(document.body);
		expect(screen.queryByRole("dialog")).toBeNull();
		fireEvent.click(trigger); fireEvent.click(screen.getByRole("button", { name: "contextUsage.close" }));
		expect(screen.queryByRole("dialog")).toBeNull();
	});
	it("shows unavailable on request failure instead of zero", async () => {
		fetchUsage.mockRejectedValue(new Error("offline"));
		renderUsage();
		fireEvent.click(await screen.findByRole("button", { name: /contextUsage.failed/ }));
		expect(screen.getByRole("dialog").textContent).not.toContain("0.0%");
		expect(screen.getByRole("meter").hasAttribute("aria-valuenow")).toBe(false);
	});
	it("keeps compaction unknown and clamps the ring but not the actual percentage", async () => {
		fetchUsage.mockResolvedValue({ ...data, status: "pending", tokens: null, percent: null, breakdown: [] });
		const { unmount } = renderUsage();
		fireEvent.click(await screen.findByRole("button", { name: /contextUsage.pending/ }));
		expect(screen.getByRole("meter").hasAttribute("aria-valuenow")).toBe(false);
		unmount();
		fetchUsage.mockResolvedValue({ ...data, percent: 120 });
		renderUsage();
		fireEvent.click(await screen.findByRole("button", { name: /120.0%/ }));
		expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("100");
		expect(screen.getByRole("dialog").textContent).toContain("120.0%");
	});
	it("aborts old requests and ignores late responses after switching sessions", async () => {
		let finish!: (value: SessionContextUsage) => void;
		fetchUsage.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
		const { rerender } = render(<ContextUsage key="s1" sessionId="s1" streaming={false} revision="1" />);
		const signal = fetchUsage.mock.calls[0][1];
		fetchUsage.mockResolvedValue({ ...data, sessionId: "s2", tokens: 100, percent: 0.1 });
		rerender(<ContextUsage key="s2" sessionId="s2" streaming={false} revision="1" />);
		expect(signal?.aborted).toBe(true);
		await screen.findByRole("button", { name: /0.1%/ });
		await act(async () => { finish(data); });
		expect(screen.queryByRole("button", { name: /25.1%/ })).toBeNull();
	});
	it("refreshes at turn completion and rejects mismatched session data", async () => {
		const { rerender } = renderUsage();
		await screen.findByRole("button", { name: /25.1%/ });
		fetchUsage.mockResolvedValue({ ...data, sessionId: "wrong" });
		rerender(<ContextUsage sessionId="s1" streaming={false} revision="2" />);
		await waitFor(() => expect(screen.getByRole("button").getAttribute("aria-label")).toContain("contextUsage.failed"));
	});
	it("formats tokens", () => {
		expect(formatContextTokens(262144)).toBe("262.1K");
		expect(formatContextTokens(2000000)).toBe("2.0M");
		expect(formatContextTokens(0)).toBe("0");
	});
});
