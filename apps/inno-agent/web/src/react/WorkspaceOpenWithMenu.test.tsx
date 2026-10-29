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
	localStorage.clear();
	desktop = { getWorkspaceFileApplications: vi.fn(async () => ({ applications: apps, fileManager: "finder" })), openWorkspaceFile: vi.fn(async () => true), revealWorkspaceFile: vi.fn(async () => true) };
	vi.stubGlobal("innoDesktop", desktop);
});

it("places a direct open button to the right of the compact menu and defaults to preview", () => {
	const onOpenPreview = vi.fn();
	render(<WorkspaceOpenWithMenu path="slides.pptx" workspaceId="owner" compact onOpenPreview={onOpenPreview} />);
	const menu = screen.getByRole("button", { name: "打开方式" });
	const direct = screen.getByRole("button", { name: "打开" });
	expect(menu.compareDocumentPosition(direct) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	fireEvent.click(direct);
	expect(onOpenPreview).toHaveBeenCalledOnce();
	expect(desktop.getWorkspaceFileApplications).not.toHaveBeenCalled();
	expect(desktop.openWorkspaceFile).not.toHaveBeenCalled();
});

it("opens a menu selection immediately and remembers it for other files of the same type after remount", async () => {
	const onOpenPreview = vi.fn();
	render(<WorkspaceOpenWithMenu path="docs/report.docx" workspaceId="owner" compact onOpenPreview={onOpenPreview} />);
	fireEvent.keyDown(screen.getByRole("button", { name: "打开方式" }), { key: "Enter" });
	fireEvent.click(await screen.findByRole("menuitem", { name: "LibreOffice" }));
	await waitFor(() => expect(desktop.openWorkspaceFile).toHaveBeenCalledExactlyOnceWith("docs/report.docx", "owner", "libre"));
	await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
	cleanup();
	render(<WorkspaceOpenWithMenu path="other.DOCX" workspaceId="other" compact onOpenPreview={onOpenPreview} />);
	fireEvent.click(screen.getByRole("button", { name: "打开" }));
	await waitFor(() => expect(desktop.openWorkspaceFile).toHaveBeenLastCalledWith("other.DOCX", "other", "libre"));
	expect(onOpenPreview).not.toHaveBeenCalled();
	expect(desktop.getWorkspaceFileApplications).toHaveBeenCalledTimes(1);
	fireEvent.keyDown(screen.getByRole("button", { name: "打开方式" }), { key: "Enter" });
	expect(await screen.findByRole("menuitem", { name: "LibreOffice（默认）" })).toBeTruthy();
	expect(screen.getByRole("menuitem", { name: "Microsoft Word" })).toBeTruthy();
});

it("remembers preview selections and keeps different document types independent", async () => {
	await open();
	fireEvent.click(screen.getByRole("menuitem", { name: "LibreOffice" }));
	await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
	cleanup();
	const onOpenPreview = vi.fn();
	const view = render(<WorkspaceOpenWithMenu path="slides.pptx" workspaceId="owner" compact onOpenPreview={onOpenPreview} />);
	fireEvent.click(screen.getByRole("button", { name: "打开" }));
	expect(onOpenPreview).toHaveBeenCalledTimes(1);
	view.rerender(<WorkspaceOpenWithMenu path="report.docx" workspaceId="owner" compact onOpenPreview={onOpenPreview} />);
	fireEvent.keyDown(screen.getByRole("button", { name: "打开方式" }), { key: "Enter" });
	fireEvent.click(await screen.findByRole("menuitem", { name: "在文件预览中打开" }));
	expect(onOpenPreview).toHaveBeenCalledTimes(2);
	await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
	cleanup();
	render(<WorkspaceOpenWithMenu path="third.docx" workspaceId="owner" compact onOpenPreview={onOpenPreview} />);
	fireEvent.click(screen.getByRole("button", { name: "打开" }));
	expect(onOpenPreview).toHaveBeenCalledTimes(3);
	expect(desktop.openWorkspaceFile).toHaveBeenCalledTimes(1);
});

it("does not replace a working preference after a failed application open", async () => {
	await open();
	fireEvent.click(screen.getByRole("menuitem", { name: "LibreOffice" }));
	await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
	desktop.openWorkspaceFile.mockResolvedValueOnce(false);
	fireEvent.keyDown(screen.getByRole("button", { name: "使用其他应用打开" }), { key: "Enter" });
	fireEvent.click(await screen.findByRole("menuitem", { name: "Microsoft Word" }));
	expect(await screen.findByRole("alert")).toBeTruthy();
	cleanup();
	render(<WorkspaceOpenWithMenu path="report.docx" workspaceId="owner" compact onOpenPreview={vi.fn()} />);
	fireEvent.click(screen.getByRole("button", { name: "打开" }));
	await waitFor(() => expect(desktop.openWorkspaceFile).toHaveBeenLastCalledWith("report.docx", "owner", "libre"));
});

it("shows direct open failures and allows choosing another application", async () => {
	await open();
	fireEvent.click(screen.getByRole("menuitem", { name: "LibreOffice" }));
	await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
	cleanup();
	desktop.openWorkspaceFile.mockResolvedValueOnce(false);
	render(<WorkspaceOpenWithMenu path="missing.docx" workspaceId="owner" compact onOpenPreview={vi.fn()} />);
	fireEvent.click(screen.getByRole("button", { name: "打开" }));
	expect(await screen.findByRole("alert")).toBeTruthy();
	fireEvent.keyDown(screen.getByRole("button", { name: "打开方式" }), { key: "Enter" });
	fireEvent.click(await screen.findByRole("menuitem", { name: "Microsoft Word" }));
	await waitFor(() => expect(desktop.openWorkspaceFile).toHaveBeenLastCalledWith("missing.docx", "owner", "word"));
	await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

it("still opens in preview when browser storage is unavailable", () => {
	vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
	vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
	vi.stubGlobal("innoDesktop", undefined);
	const onOpenPreview = vi.fn();
	render(<WorkspaceOpenWithMenu path="slides.pptx" workspaceId="owner" compact onOpenPreview={onOpenPreview} />);
	fireEvent.click(screen.getByRole("button", { name: "打开" }));
	expect(onOpenPreview).toHaveBeenCalledOnce();
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
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
it("omits download for the Word preview while retaining external app actions", async () => {
	render(<WorkspaceOpenWithMenu path="report.docx" workspaceId="owner" allowDownload={false} />);
	fireEvent.keyDown(screen.getByRole("button", { name: "使用其他应用打开" }), { key: "Enter" });
	expect(await screen.findByRole("menuitem", { name: "Microsoft Word（默认）" })).toBeTruthy();
	expect(screen.queryByRole("menuitem", { name: "下载副本" })).toBeNull();
	expect(screen.getByRole("menuitem", { name: "在访达中显示" })).toBeTruthy();
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

function reopen() {
	fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
	fireEvent.keyDown(screen.getByRole("button", { name: "使用其他应用打开" }), { key: "Enter" });
}
it("reuses the application list and icons when reopening the same file", async () => {
	const icon = "data:image/png;base64,iVBORw0KGgo=";
	desktop.getWorkspaceFileApplications.mockResolvedValue({ applications: [{ ...apps[0], icon }], fileManager: "finder" });
	await open();
	reopen();
	expect(screen.getByRole("menuitem", { name: "Microsoft Word（默认）" }).querySelector("img")?.getAttribute("src")).toBe(icon);
	expect(screen.queryByRole("menuitem", { name: "正在读取应用…" })).toBeNull();
	expect(desktop.getWorkspaceFileApplications).toHaveBeenCalledTimes(1);
});
it("reuses a successful lookup after the menu component remounts", async () => {
	await open();
	cleanup();
	await open();
	expect(desktop.getWorkspaceFileApplications).toHaveBeenCalledTimes(1);
});
it("shares an unfinished lookup across close and remount", async () => {
	let finish!: (value: unknown) => void;
	desktop.getWorkspaceFileApplications.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
	const view = render(<WorkspaceOpenWithMenu path="report.docx" workspaceId="owner" />);
	fireEvent.keyDown(screen.getByRole("button", { name: "使用其他应用打开" }), { key: "Enter" });
	await waitFor(() => expect(desktop.getWorkspaceFileApplications).toHaveBeenCalledTimes(1));
	view.unmount();
	render(<WorkspaceOpenWithMenu path="report.docx" workspaceId="owner" />);
	fireEvent.keyDown(screen.getByRole("button", { name: "使用其他应用打开" }), { key: "Enter" });
	await act(async () => { finish({ applications: apps, fileManager: "finder" }); });
	expect(await screen.findByRole("menuitem", { name: "Microsoft Word（默认）" })).toBeTruthy();
	expect(desktop.getWorkspaceFileApplications).toHaveBeenCalledTimes(1);
});
it("retains the stale list while refreshing expired associations in the background", async () => {
	const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
	await open();
	let finish!: (value: unknown) => void;
	desktop.getWorkspaceFileApplications.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
	now.mockReturnValue(1_000 + 5 * 60_000 + 1);
	reopen();
	expect(screen.getByRole("menuitem", { name: "Microsoft Word（默认）" })).toBeTruthy();
	expect(screen.queryByRole("menuitem", { name: "正在读取应用…" })).toBeNull();
	await act(async () => { finish({ applications: [{ id: "new", name: "New Editor", isDefault: true }], fileManager: "finder" }); });
	expect(await screen.findByRole("menuitem", { name: "New Editor（默认）" })).toBeTruthy();
	reopen();
	expect(desktop.getWorkspaceFileApplications).toHaveBeenCalledTimes(2);
});
it.each(["reject", "unavailable"])("retries a %s lookup on the next open", async (failure) => {
	if (failure === "reject") desktop.getWorkspaceFileApplications.mockRejectedValueOnce(new Error("unavailable"));
	else desktop.getWorkspaceFileApplications.mockResolvedValueOnce({ applications: [], fileManager: "finder", unavailable: true });
	render(<WorkspaceOpenWithMenu path="report.docx" workspaceId="owner" />);
	fireEvent.keyDown(screen.getByRole("button", { name: "使用其他应用打开" }), { key: "Enter" });
	expect(await screen.findByRole("alert")).toBeTruthy();
	reopen();
	expect(await screen.findByRole("menuitem", { name: "Microsoft Word（默认）" })).toBeTruthy();
	reopen();
	expect(desktop.getWorkspaceFileApplications).toHaveBeenCalledTimes(2);
});
it("keeps file and workspace cache keys separate", async () => {
	await open();
	cleanup();
	for (const [path, workspaceId] of [["other.docx", "owner"], ["docs/report.docx", "other"]]) {
		render(<WorkspaceOpenWithMenu path={path} workspaceId={workspaceId} />);
		fireEvent.keyDown(screen.getByRole("button", { name: "使用其他应用打开" }), { key: "Enter" });
		await screen.findByRole("menuitem", { name: "Microsoft Word（默认）" });
		expect(desktop.getWorkspaceFileApplications).toHaveBeenLastCalledWith(path, workspaceId);
		cleanup();
	}
	expect(desktop.getWorkspaceFileApplications).toHaveBeenCalledTimes(3);
});
it.each(["reject", "unavailable"])("retains usable associations after a %s background refresh and retries next time", async (failure) => {
	const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
	await open();
	if (failure === "reject") desktop.getWorkspaceFileApplications.mockRejectedValueOnce(new Error("unavailable"));
	else desktop.getWorkspaceFileApplications.mockResolvedValueOnce({ applications: [], fileManager: "files", unavailable: true });
	now.mockReturnValue(1_000 + 5 * 60_000 + 1);
	reopen();
	expect(await screen.findByRole("alert")).toBeTruthy();
	expect(screen.getByRole("menuitem", { name: "Microsoft Word（默认）" })).toBeTruthy();
	expect(screen.getByRole("menuitem", { name: "在访达中显示" })).toBeTruthy();
	expect(screen.queryByRole("menuitem", { name: "正在读取应用…" })).toBeNull();
	reopen();
	await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
	expect(desktop.getWorkspaceFileApplications).toHaveBeenCalledTimes(3);
});
it("never shows a previous file's applications while a new file is loading", async () => {
	let finish!: (value: unknown) => void;
	desktop.getWorkspaceFileApplications.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
	const view = render(<WorkspaceOpenWithMenu path="one.docx" workspaceId="owner" />);
	fireEvent.keyDown(screen.getByRole("button", { name: "使用其他应用打开" }), { key: "Enter" });
	view.rerender(<WorkspaceOpenWithMenu path="two.xlsx" workspaceId="other" />);
	await screen.findByRole("menuitem", { name: "Microsoft Word（默认）" });
	await act(async () => { finish({ applications: [{ id: "old", name: "Old App", isDefault: true }], fileManager: "finder" }); });
	expect(screen.queryByRole("menuitem", { name: "Old App（默认）" })).toBeNull();
	expect(desktop.getWorkspaceFileApplications).toHaveBeenLastCalledWith("two.xlsx", "other");
});
