// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SIDEBAR_PREVIEW_CLOSE_DELAY, useSidebarPreview } from "./use-sidebar-preview.js";

describe("useSidebarPreview", () => {
	let focusInsidePreview = false;

	beforeEach(() => {
		focusInsidePreview = false;
		vi.useFakeTimers();
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
	});

	it("opens only when the Chat preview interaction asks for it", () => {
		const { result } = renderHook(() => useSidebarPreview(true, () => focusInsidePreview));
		expect(result.current.previewOpen).toBe(false);

		act(() => result.current.openPreview());
		expect(result.current.previewOpen).toBe(true);
	});

	it("waits for the close delay after leaving and cancels the close when the pointer re-enters", () => {
		const { result } = renderHook(() => useSidebarPreview(true, () => focusInsidePreview));
		act(() => result.current.openPreview());
		act(() => result.current.scheduleClose());
		act(() => vi.advanceTimersByTime(SIDEBAR_PREVIEW_CLOSE_DELAY - 1));
		expect(result.current.previewOpen).toBe(true);

		act(() => result.current.cancelClose());
		act(() => vi.advanceTimersByTime(1));
		expect(result.current.previewOpen).toBe(true);
	});

	it("keeps the preview while keyboard focus remains inside, then closes after focus leaves", () => {
		const { result } = renderHook(() => useSidebarPreview(true, () => focusInsidePreview));
		act(() => result.current.openPreview());
		focusInsidePreview = true;
		act(() => result.current.scheduleClose());
		act(() => vi.advanceTimersByTime(SIDEBAR_PREVIEW_CLOSE_DELAY));
		expect(result.current.previewOpen).toBe(true);

		focusInsidePreview = false;
		act(() => result.current.scheduleClose());
		act(() => vi.advanceTimersByTime(SIDEBAR_PREVIEW_CLOSE_DELAY));
		expect(result.current.previewOpen).toBe(false);
	});

	it("Escape closes the preview unless a nested popover already handled it", () => {
		const { result } = renderHook(() => useSidebarPreview(true, () => focusInsidePreview));
		act(() => result.current.openPreview());
		const handledByPopover = { key: "Escape", defaultPrevented: true, preventDefault: vi.fn() };
		act(() => result.current.handleKeyDown(handledByPopover));
		expect(result.current.previewOpen).toBe(true);

		const escape = { key: "Escape", defaultPrevented: false, preventDefault: vi.fn() };
		act(() => result.current.handleKeyDown(escape));
		expect(escape.preventDefault).toHaveBeenCalledOnce();
		expect(result.current.previewOpen).toBe(false);
	});

	it("clears pending close work when the sidebar unmounts", () => {
		const { result, unmount } = renderHook(() => useSidebarPreview(true, () => focusInsidePreview));
		act(() => result.current.openPreview());
		act(() => result.current.scheduleClose());
		expect(vi.getTimerCount()).toBe(1);
		unmount();
		expect(vi.getTimerCount()).toBe(0);
	});
});
