import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResizeHandle } from "./ResizeHandle.js";

function pointer(target: HTMLElement | Window, type: string, clientX: number, pointerId = 1) {
	const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX, clientY: 100 });
	Object.defineProperty(event, "pointerId", { value: pointerId });
	fireEvent(target, event);
}

// Drag moves are applied once per animation frame; let the pending frame run.
async function flushFrame() {
	await act(async () => {
		await new Promise((resolve) => requestAnimationFrame(resolve));
	});
}

function Splitter({ onChange = vi.fn() }: { onChange?: (value: number) => void }) {
	const [value, setValue] = useState(246);
	return <ResizeHandle aria-label="Resize" value={value} min={220} max={480} onValueChange={(next) => { setValue(next); onChange(next); }} />;
}

afterEach(cleanup);

describe("ResizeHandle", () => {
	it("resizes with the captured pointer and clamps to the available range", async () => {
		render(<Splitter />);
		const handle = screen.getByRole("separator", { name: "Resize" });
		pointer(handle, "pointerdown", 300);
		pointer(window, "pointermove", 360, 2);
		await flushFrame();
		expect(handle.getAttribute("aria-valuenow")).toBe("246");
		pointer(window, "pointermove", 360);
		await flushFrame();
		expect(handle.getAttribute("aria-valuenow")).toBe("306");
		pointer(window, "pointermove", 1000);
		await flushFrame();
		expect(handle.getAttribute("aria-valuenow")).toBe("480");
		pointer(window, "pointermove", 0);
		await flushFrame();
		expect(handle.getAttribute("aria-valuenow")).toBe("220");
		pointer(window, "pointerup", 360);
		expect(handle.getAttribute("aria-valuenow")).toBe("306");
		expect(document.body.classList.contains("inno-ui-resizing-columns")).toBe(false);
		pointer(window, "pointermove", 400);
		await flushFrame();
		expect(handle.getAttribute("aria-valuenow")).toBe("306");
		// Pointer styling must not blur the splitter: keyboard sizing stays ready.
		expect(document.activeElement).toBe(handle);
		fireEvent.keyDown(handle, { key: "ArrowRight" });
		expect(handle.getAttribute("aria-valuenow")).toBe("314");
	});

	it("applies at most one width update per frame during a drag", async () => {
		const onChange = vi.fn();
		render(<Splitter onChange={onChange} />);
		const handle = screen.getByRole("separator", { name: "Resize" });
		pointer(handle, "pointerdown", 300);
		pointer(window, "pointermove", 360);
		pointer(window, "pointermove", 400);
		expect(onChange).not.toHaveBeenCalled();
		await flushFrame();
		expect(onChange).toHaveBeenCalledExactlyOnceWith(346);
		pointer(window, "pointerup", 400);
		expect(handle.getAttribute("aria-valuenow")).toBe("346");
	});

	it.each(["Escape", "pointercancel", "lostpointercapture", "blur"])("restores the starting width on %s", (cancel) => {
		render(<Splitter />);
		const handle = screen.getByRole("separator", { name: "Resize" });
		pointer(handle, "pointerdown", 300);
		pointer(window, "pointermove", 360);
		if (cancel === "Escape") fireEvent.keyDown(handle, { key: "Escape" });
		else if (cancel === "pointercancel" || cancel === "lostpointercapture") pointer(window, cancel, 360);
		else fireEvent.blur(window);
		expect(handle.getAttribute("aria-valuenow")).toBe("246");
		expect(document.body.classList.contains("inno-ui-resizing-columns")).toBe(false);
	});

	it("supports keyboard sizing and range endpoints", () => {
		render(<Splitter />);
		const handle = screen.getByRole("separator", { name: "Resize" });
		fireEvent.keyDown(handle, { key: "ArrowRight" });
		expect(handle.getAttribute("aria-valuenow")).toBe("254");
		fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
		expect(handle.getAttribute("aria-valuenow")).toBe("222");
		fireEvent.keyDown(handle, { key: "Home" });
		expect(handle.getAttribute("aria-valuenow")).toBe("220");
		fireEvent.keyDown(handle, { key: "End" });
		expect(handle.getAttribute("aria-valuenow")).toBe("480");
	});

	it("releases an unfinished resize and its global listeners on unmount", () => {
		const onChange = vi.fn();
		const { unmount } = render(<Splitter onChange={onChange} />);
		pointer(screen.getByRole("separator", { name: "Resize" }), "pointerdown", 300);
		pointer(window, "pointermove", 360);
		unmount();
		expect(onChange).toHaveBeenLastCalledWith(246);
		expect(document.body.classList.contains("inno-ui-resizing-columns")).toBe(false);
		onChange.mockClear();
		pointer(window, "pointermove", 400);
		expect(onChange).not.toHaveBeenCalled();
	});
});
