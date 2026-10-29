import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopWorkbench } from "./DesktopWorkbench.js";

afterEach(cleanup);

describe("DesktopWorkbench fullscreen transition", () => {
	it.each(["half", "quarter"] as const)("preserves the %s chat layout and draft while fullscreen covers it", (mode) => {
		const props = { workspaceWidth: 280, chatContent: <textarea aria-label="Draft" defaultValue="Draft" />, workspaceContent: <aside>Preview</aside> };
		const { container, rerender } = render(<DesktopWorkbench {...props} mode={mode} />);
		const draft = screen.getByRole("textbox", { name: "Draft" });
		fireEvent.change(draft, { target: { value: "Unsaved text" } });
		const workbench = container.firstElementChild as HTMLElement;
		const reservedWidth = workbench.style.getPropertyValue("--inno-chat-reserved-width");
		expect(reservedWidth).toBe(mode === "half" ? "317px" : "277px");

		rerender(<DesktopWorkbench {...props} mode="full" />);
		expect(workbench.style.getPropertyValue("--inno-chat-reserved-width")).toBe(reservedWidth);
		expect(container.querySelector("textarea")).toBe(draft);
		expect(container.querySelector("main")?.hasAttribute("inert")).toBe(true);
		expect(screen.queryByRole("textbox")).toBeNull();
		expect(screen.getByText("Preview")).toBeTruthy();

		rerender(<DesktopWorkbench {...props} mode={mode} />);
		expect(screen.getByRole("textbox", { name: "Draft" })).toBe(draft);
		expect((draft as HTMLTextAreaElement).value).toBe("Unsaved text");
		expect(container.querySelector("main")?.hasAttribute("inert")).toBe(false);
	});

	it("continues following splitter resizing and releases all space on collapse", () => {
		const props = { chatContent: <div>Chat</div> };
		const { container, rerender } = render(<DesktopWorkbench {...props} mode="half" workspaceWidth={520} />);
		const workbench = container.firstElementChild as HTMLElement;
		rerender(<DesktopWorkbench {...props} mode="half" workspaceWidth={640} />);
		expect(workbench.style.getPropertyValue("--inno-chat-reserved-width")).toBe("637px");
		rerender(<DesktopWorkbench {...props} mode="collapsed" workspaceWidth={640} />);
		expect(workbench.style.getPropertyValue("--inno-chat-reserved-width")).toBe("0px");
	});

	it("reuses the same conversation and its scroll position across fullscreen tabs", () => {
		const props = { workspaceWidth: 520, chatContent: <textarea aria-label="Draft" defaultValue="unsaved" /> };
		const { container, rerender } = render(<DesktopWorkbench {...props} mode="half" />);
		const draft = screen.getByRole("textbox");
		const chat = container.querySelector("main")!;
		chat.scrollTop = 140;
		rerender(<DesktopWorkbench {...props} mode="full" conversationActive />);
		expect(screen.getByRole("tabpanel")).toBe(chat);
		expect(screen.getByRole("textbox")).toBe(draft);
		expect(chat.scrollTop).toBe(140);
		expect((container.firstElementChild as HTMLElement).style.getPropertyValue("--inno-chat-reserved-width")).toBe("0px");
		rerender(<DesktopWorkbench {...props} mode="full" conversationActive={false} />);
		expect(screen.queryByRole("textbox")).toBeNull();
		// Keep the visited fullscreen chat width even while hidden: selecting a
		// file must not squeeze/reflow it again during the exit animation.
		expect((container.firstElementChild as HTMLElement).style.getPropertyValue("--inno-chat-reserved-width")).toBe("0px");
		rerender(<DesktopWorkbench {...props} mode="half" />);
		expect(screen.getByRole("textbox")).toBe(draft);
		expect((draft as HTMLTextAreaElement).value).toBe("unsaved");
	});
});
