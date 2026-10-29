import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithTooltipProvider as render } from "../test-utils.js";
import { OfficeDocumentCards } from "./OfficeDocumentCards.js";

vi.mock("react-i18next", () => {
	const t = (key: string, fallback?: string) => fallback ?? key;
	return { useTranslation: () => ({ t }) };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); document.documentElement.removeAttribute("data-theme"); });

describe.each(["light", "dark"])("final Office cards in %s theme", (theme) => {
	it("shows each document type and opens only after a click", async () => {
		document.documentElement.setAttribute("data-theme", theme);
		vi.stubGlobal("innoDesktop", undefined);
		const onOpen = vi.fn();
		const files = [
			{ path: "docs/report.docx", workspaceId: "owner", kind: "doc" as const, type: "Word" },
			{ path: "slides.pptx", workspaceId: "owner", kind: "ppt" as const, type: "PowerPoint" },
			{ path: "budget.xlsx", workspaceId: "owner", kind: "xls" as const, type: "Excel" },
		];
		render(<OfficeDocumentCards files={files} onOpen={onOpen} />);
		for (const file of files) expect(screen.getByText(file.type)).toBeTruthy();
		expect(onOpen).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "report.docx" }));
		expect(onOpen).toHaveBeenCalledExactlyOnceWith(files[0]);
		fireEvent.keyDown(screen.getAllByRole("button", { name: "打开方式" })[1]!, { key: "Enter" });
		fireEvent.click(await screen.findByRole("menuitem", { name: "在文件预览中打开（默认）" }));
		expect(onOpen).toHaveBeenLastCalledWith(files[1]);
		fireEvent.click(screen.getAllByRole("button", { name: "打开" })[2]!);
		expect(onOpen).toHaveBeenLastCalledWith(files[2]);
	});
});
