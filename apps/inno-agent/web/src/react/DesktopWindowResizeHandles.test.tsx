import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopWindowResizeHandles } from "./DesktopWindowResizeHandles.js";

const resize = vi.fn();
function pointer(target: Element | Window, type: string, pointerId = 1) {
	const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 });
	Object.defineProperty(event, "pointerId", { value: pointerId });
	fireEvent(target, event);
}
async function frame() { await act(async () => { await new Promise(requestAnimationFrame); }); }
beforeEach(() => { resize.mockClear(); vi.stubGlobal("innoDesktop", { resizeWindow: resize }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("desktop outer resize targets", () => {
	it("provides all eight directions and flushes a pending move at release", async () => {
		const { container } = render(<DesktopWindowResizeHandles />);
		expect(container.querySelectorAll("[data-edge]")).toHaveLength(8);
		const target = container.querySelector('[data-edge="nw"]')!;
		pointer(target, "pointerdown");
		expect(resize).toHaveBeenCalledExactlyOnceWith("start", "nw");
		pointer(window, "pointermove"); pointer(window, "pointermove");
		await frame();
		expect(resize).toHaveBeenCalledTimes(2);
		expect(resize).toHaveBeenLastCalledWith("update");
		pointer(window, "pointerup", 2);
		expect(document.body.dataset.windowResizing).toBe("nw");
		pointer(window, "pointermove");
		pointer(window, "pointerup");
		await frame();
		expect(resize).toHaveBeenLastCalledWith("end");
		expect(resize).toHaveBeenCalledTimes(3);
		expect(document.body.dataset.windowResizing).toBeUndefined();
	});

	it.each(["pointercancel", "lostpointercapture", "blur", "Escape", "unmount"])("ends the gesture and releases pending work on %s", async (cause) => {
		const { container, unmount } = render(<DesktopWindowResizeHandles />);
		pointer(container.querySelector('[data-edge="e"]')!, "pointerdown");
		pointer(window, "pointermove");
		if (cause === "unmount") unmount();
		else if (cause === "Escape") fireEvent.keyDown(window, { key: "Escape" });
		else if (cause === "blur") fireEvent.blur(window);
		else pointer(window, cause);
		await frame();
		pointer(window, "pointerup");
		expect(resize.mock.calls).toEqual([["start", "e"], ["cancel"]]);
		expect(document.body.dataset.windowResizing).toBeUndefined();
	});

	it("removes targets in native fullscreen and ends any active gesture", () => {
		const { container, rerender } = render(<DesktopWindowResizeHandles />);
		pointer(container.querySelector('[data-edge="s"]')!, "pointerdown");
		rerender(<DesktopWindowResizeHandles disabled />);
		expect(container.childElementCount).toBe(0);
		expect(resize).toHaveBeenLastCalledWith("cancel");
	});

	it("does not add hit targets to ordinary browsers or older native bridges", () => {
		vi.stubGlobal("innoDesktop", undefined);
		const { container, rerender } = render(<DesktopWindowResizeHandles />);
		expect(container.childElementCount).toBe(0);
		vi.stubGlobal("innoDesktop", {});
		rerender(<DesktopWindowResizeHandles />);
		expect(container.childElementCount).toBe(0);
	});

	it.each(["light", "dark"])("keeps native resize layout synchronous until the final layout paints (%s)", async (theme) => {
		const originalTheme = document.documentElement.getAttribute("data-theme");
		document.documentElement.setAttribute("data-theme", theme);
		try {
			const { container } = render(<DesktopWindowResizeHandles />);
			pointer(container.querySelector('[data-edge="e"]')!, "pointerdown");
			vi.stubGlobal("innerWidth", window.innerWidth - 40);
			fireEvent.resize(window);
			await frame();
			expect(document.body.hasAttribute("data-window-layout-resizing")).toBe(true);
			pointer(window, "pointerup");
			expect(document.body.dataset.windowResizing).toBeUndefined();
			// The main process may deliver the final fitted viewport after release.
			vi.stubGlobal("innerWidth", window.innerWidth - 20);
			fireEvent.resize(window);
			await frame();
			expect(document.body.hasAttribute("data-window-layout-resizing")).toBe(true);
			await frame();
			expect(document.body.hasAttribute("data-window-layout-resizing")).toBe(false);
		} finally {
			if (originalTheme === null) document.documentElement.removeAttribute("data-theme");
			else document.documentElement.setAttribute("data-theme", originalTheme);
		}
	});

	it("covers OS viewport resize without a pointer gesture or the custom resize bridge", async () => {
		vi.stubGlobal("innoDesktop", {});
		render(<DesktopWindowResizeHandles disabled />);
		vi.stubGlobal("innerWidth", window.innerWidth - 40);
		fireEvent.resize(window);
		expect(document.body.hasAttribute("data-window-layout-resizing")).toBe(true);
		await frame();
		await frame();
		expect(document.body.hasAttribute("data-window-layout-resizing")).toBe(false);
		expect(resize).not.toHaveBeenCalled();
	});

	it("cleans up the viewport resize listener and pending animation frames on unmount", async () => {
		const { unmount } = render(<DesktopWindowResizeHandles />);
		vi.stubGlobal("innerWidth", window.innerWidth - 40);
		fireEvent.resize(window);
		unmount();
		expect(document.body.hasAttribute("data-window-layout-resizing")).toBe(false);
		fireEvent.resize(window);
		await frame();
		expect(document.body.hasAttribute("data-window-layout-resizing")).toBe(false);
	});

	it("preserves preview opening animations when the native window expands automatically", () => {
		render(<DesktopWindowResizeHandles />);
		vi.stubGlobal("innerWidth", window.innerWidth + 200);
		fireEvent.resize(window);
		expect(document.body.hasAttribute("data-window-layout-resizing")).toBe(false);
		// A preview may be opened immediately after a preceding shrink.
		vi.stubGlobal("innerWidth", window.innerWidth - 40);
		fireEvent.resize(window);
		expect(document.body.hasAttribute("data-window-layout-resizing")).toBe(true);
		vi.stubGlobal("innerWidth", window.innerWidth + 200);
		fireEvent.resize(window);
		expect(document.body.hasAttribute("data-window-layout-resizing")).toBe(false);
	});

	it("leaves browser resize transitions alone", () => {
		vi.stubGlobal("innoDesktop", undefined);
		render(<DesktopWindowResizeHandles />);
		fireEvent.resize(window);
		expect(document.body.hasAttribute("data-window-layout-resizing")).toBe(false);
	});
});
