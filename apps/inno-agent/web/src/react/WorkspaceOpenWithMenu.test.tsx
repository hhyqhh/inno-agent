import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceOpenWithMenu } from "./WorkspaceOpenWithMenu.js";
import { renderWithTooltipProvider as render } from "./test-utils.js";
import { triggerDownload, workspaceFileUrl } from "../api/workspace.js";
vi.mock("react-i18next", () => {
	const t = (_key: string, fallback: string) => fallback;
	return { useTranslation: () => ({ t }) };
});
vi.mock("../api/workspace.js", () => ({ triggerDownload: vi.fn(), workspaceFileUrl: vi.fn(() => "/download-copy") }));
const apps = [{ id: "word", name: "Microsoft Word", isDefault: true }, { id: "libre", name: "LibreOffice", isDefault: false }];
let desktop: { getWorkspaceFileApplications: ReturnType<typeof vi.fn>; openWorkspaceFile: ReturnType<typeof vi.fn>; revealWorkspaceFile: ReturnType<typeof vi.fn> };
beforeEach(() => {
	desktop = { getWorkspaceFileApplications: vi.fn(async () => ({ applications: apps, fileManager: "finder" })), openWorkspaceFile: vi.fn(async () => true), revealWorkspaceFile: vi.fn(async () => true) };
	vi.stubGlobal("innoDesktop", desktop);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });
async function open() {
	render(<WorkspaceOpenWithMenu path="docs/report.docx" workspaceId="owner" />);
	fireEvent.keyDown(screen.getByRole("button", { name: "使用其他应用打开" }), { key: "Enter" });
	return screen.findByRole("menuitem", { name: "Microsoft Word（默认）" });
}
it("loads on demand and opens the selected application in the owning workspace", async () => {
	const word = await open();
	expect(desktop.getWorkspaceFileApplications).toHaveBeenCalledExactlyOnceWith("docs/report.docx", "owner");
	expect(word).toBeTruthy();
	expect(desktop.openWorkspaceFile).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("menuitem", { name: "LibreOffice" }));
	await waitFor(() => expect(desktop.openWorkspaceFile).toHaveBeenCalledExactlyOnceWith("docs/report.docx", "owner", "libre"));
	await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
});
it("reveals the original in Finder and downloads a separate copy through the existing URL", async () => {
	await open();
	fireEvent.click(screen.getByRole("menuitem", { name: "在访达中显示" }));
	await waitFor(() => expect(desktop.revealWorkspaceFile).toHaveBeenCalledExactlyOnceWith("docs/report.docx", "owner"));
	await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
	fireEvent.keyDown(screen.getByRole("button", { name: "使用其他应用打开" }), { key: "Enter" });
	fireEvent.click(await screen.findByRole("menuitem", { name: "下载副本" }));
	expect(workspaceFileUrl).toHaveBeenCalledWith("docs/report.docx", "owner", true);
	expect(triggerDownload).toHaveBeenCalledWith("/download-copy");
});
it("keeps a failed open visible with a retryable app list", async () => {
	desktop.openWorkspaceFile.mockResolvedValue(false);
	fireEvent.click(await open());
	expect(await screen.findByRole("alert")).toBeTruthy();
	expect(screen.getByRole("menuitem", { name: "Microsoft Word（默认）" })).toBeTruthy();
	await waitFor(() => expect(screen.getByRole("menuitem", { name: "Microsoft Word（默认）" }).hasAttribute("data-disabled")).toBe(false));
	desktop.openWorkspaceFile.mockResolvedValue(true);
	fireEvent.click(screen.getByRole("menuitem", { name: "Microsoft Word（默认）" }));
	await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
});
it("retains a default application and download when enumeration fails", async () => {
	desktop.getWorkspaceFileApplications.mockRejectedValue(new Error("unavailable"));
	render(<WorkspaceOpenWithMenu path="report.docx" workspaceId={null} />);
	fireEvent.keyDown(screen.getByRole("button", { name: "使用其他应用打开" }), { key: "Enter" });
	expect(await screen.findByRole("menuitem", { name: "系统默认应用" })).toBeTruthy();
	expect(screen.getByRole("alert")).toBeTruthy();
	fireEvent.click(screen.getByRole("menuitem", { name: "系统默认应用" }));
	await waitFor(() => expect(desktop.openWorkspaceFile).toHaveBeenCalledExactlyOnceWith("report.docx", null, "system-default"));
});
it("ignores an application-list response after the file changes", async () => {
	let finish!: (value: unknown) => void;
	desktop.getWorkspaceFileApplications.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
	const view = render(<WorkspaceOpenWithMenu key="one" path="one.docx" workspaceId="owner" />);
	fireEvent.keyDown(screen.getByRole("button", { name: "使用其他应用打开" }), { key: "Enter" });
	view.rerender(<WorkspaceOpenWithMenu key="two" path="two.xlsx" workspaceId="other" />);
	await act(async () => { finish({ applications: apps, fileManager: "finder" }); });
	expect(screen.queryByRole("menuitem")).toBeNull();
	expect(desktop.openWorkspaceFile).not.toHaveBeenCalled();
});
