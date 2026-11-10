import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./Menu.js";
import { Popover, PopoverContent, PopoverTrigger } from "./Popover.js";

afterEach(() => {
	cleanup();
	document.documentElement.removeAttribute("data-theme");
});

it.each(["light", "dark"])("switches from an open menu to a neighboring popover in one click (%s)", async (theme) => {
	document.documentElement.setAttribute("data-theme", theme);
	render(
		<>
			<DropdownMenu>
				<DropdownMenuTrigger>Actions</DropdownMenuTrigger>
				<DropdownMenuContent>
					<DropdownMenuItem>Action</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<Popover>
				<PopoverTrigger>Options</PopoverTrigger>
				<PopoverContent>Option panel</PopoverContent>
			</Popover>
		</>,
	);

	fireEvent.keyDown(screen.getByRole("button", { name: "Actions" }), { key: "Enter" });
	expect(screen.getByRole("menuitem", { name: "Action" })).toBeTruthy();
	const options = screen.getByText("Options");
	// jsdom dispatches synthetic events even on elements a browser cannot hit.
	expect(getComputedStyle(options).pointerEvents).not.toBe("none");

	// Radix installs outside-pointer handling after the opening event.
	await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
	fireEvent.pointerDown(options, { button: 0, pointerType: "mouse" });
	fireEvent.click(options);

	expect(screen.queryByRole("menu")).toBeNull();
	expect(screen.getByRole("dialog").textContent).toBe("Option panel");
});
