import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SegmentedControl, Tabs } from "./Tabs.js";

afterEach(cleanup);

it("passes right-clicks on a tab trigger to the item's context menu handler", () => {
	const onContextMenu = vi.fn();
	render(
		<Tabs
			id="tabs"
			ariaLabel="Tabs"
			value="a"
			onValueChange={() => {}}
			items={[{ value: "a", label: "A", onContextMenu }, { value: "b", label: "B" }]}
		/>,
	);
	fireEvent.contextMenu(screen.getByRole("tab", { name: "A" }));
	expect(onContextMenu).toHaveBeenCalledTimes(1);
	fireEvent.contextMenu(screen.getByRole("tab", { name: "B" }));
	expect(onContextMenu).toHaveBeenCalledTimes(1);
});

it("excludes collapsed rail options from keyboard navigation and hover until reopened", () => {
	const onValueChange = vi.fn();
	const onValuePreview = vi.fn();
	const props = {
		value: "files",
		ariaLabel: "Sidebar views",
		onValueChange,
		onValuePreview,
		items: [{ value: "messages", label: "Messages" }, { value: "files", label: "Files" }],
	};
	const { rerender } = render(<SegmentedControl {...props} variant="rail" collapsed orientation="vertical" />);
	const messages = screen.getByRole("radio", { name: "Messages" });
	const hiddenFiles = screen.getAllByRole("radio", { hidden: true })[1] as HTMLButtonElement;
	expect(hiddenFiles.disabled).toBe(true);
	expect(hiddenFiles.hasAttribute("inert")).toBe(true);
	expect(hiddenFiles.tabIndex).toBe(-1);
	expect(messages.tabIndex).toBe(0);
	fireEvent.keyDown(messages, { key: "End" });
	fireEvent.keyDown(messages, { key: "ArrowDown" });
	fireEvent.pointerEnter(hiddenFiles);
	fireEvent.focus(hiddenFiles);
	expect(onValueChange).not.toHaveBeenCalled();
	expect(onValuePreview).not.toHaveBeenCalled();
	rerender(<SegmentedControl {...props} variant="rail" orientation="vertical" />);
	expect(screen.getByRole("radio", { name: "Files" })).toBe(hiddenFiles);
	expect(hiddenFiles.disabled).toBe(false);
	expect(hiddenFiles.hasAttribute("inert")).toBe(false);
	fireEvent.keyDown(messages, { key: "ArrowDown" });
	expect(document.activeElement).toBe(hiddenFiles);
	expect(onValueChange).toHaveBeenLastCalledWith("files");
});
