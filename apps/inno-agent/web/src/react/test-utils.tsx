import type { ReactElement, ReactNode } from "react";
import { render as testingLibraryRender, type RenderOptions } from "@testing-library/react";
import { TooltipProvider } from "./ui/index.js";

export function renderWithTooltipProvider(
	ui: ReactElement,
	options?: Omit<RenderOptions, "wrapper">,
) {
	return testingLibraryRender(ui, {
		wrapper: ({ children }: { children: ReactNode }) => (
			<TooltipProvider delayDuration={0}>{children}</TooltipProvider>
		),
		...options,
	});
}
