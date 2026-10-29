import { act, cleanup, fireEvent, render as renderView, screen, waitFor } from "@testing-library/react";
import { createRef, forwardRef, useEffect, useImperativeHandle, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocxEditorProps } from "@docx-editor.dev/react";
import type { WorkspaceFileDetail } from "../../types/workspace.js";
import { themeStore } from "../../stores/theme-store.js";
import { WordEditor, type WordEditorHandle } from "./WordEditor.js";
import { TooltipProvider } from "../ui/index.js";

const render = (ui: ReactElement) => renderView(ui, {
	wrapper: ({ children }) => <TooltipProvider>{children}</TooltipProvider>,
});

const engine = vi.hoisted(() => ({ autoReady: true, save: vi.fn(), props: null as DocxEditorProps | null, mounts: vi.fn(), unmounts: vi.fn() }));
const storage = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock("../../api/workspace.js", () => ({ saveWorkspaceFileBinary: storage.save }));
vi.mock("./word-editor-fonts.js", () => ({ loadWordEditorFonts: vi.fn(async () => ({ configuration: async () => ({ sources: [] }), degraded: false })) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "zh-CN" } }) }));
vi.mock("@docx-editor.dev/react", () => ({
	DocxEditor: forwardRef(function MockEditor(props: DocxEditorProps, ref) {
		engine.props = props;
		useImperativeHandle(ref, () => ({ save: engine.save }));
		useEffect(() => {
			engine.mounts();
			props.onChange?.({ source: "load", revision: 0 });
			if (engine.autoReady) props.onReady?.({} as never);
			return () => { engine.unmounts(); };
		}, []);
		return <div aria-label="New DOCX engine"><button onClick={() => props.onChange?.({ revision: 1 })}>Type character</button></div>;
	}),
}));

const file: WorkspaceFileDetail = { name: "report.docx", path: "reports/report.docx", format: "docx", kind: "office", size: 100, mimeType: "", updatedAt: "now", url: "/api/workspace/raw?path=reports/report.docx&workspaceId=owner" };
const saved = { saved: true, path: file.path, size: 4, updatedAt: "now" };
const bytes = new Uint8Array([80, 75, 3, 4]).buffer;

async function open(props: Partial<React.ComponentProps<typeof WordEditor>> = {}) {
	const ref = createRef<WordEditorHandle>();
	const onClose = vi.fn();
	const view = render(<WordEditor ref={ref} file={file} workspaceId="owner" onClose={onClose} {...props} />);
	await screen.findByLabelText("New DOCX engine");
	await waitFor(() => expect(screen.getByRole("button", { name: "wordEditor.save" }).hasAttribute("disabled")).toBe(false));
	return { ...view, ref, onClose };
}

beforeEach(() => {
	vi.clearAllMocks();
	engine.props = null;
	engine.autoReady = true;
	engine.save.mockResolvedValue(bytes);
	storage.save.mockResolvedValue(saved);
	vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, arrayBuffer: async () => bytes })));
	Object.defineProperties(HTMLDialogElement.prototype, {
		show: { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } },
		close: { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } },
	});
});
afterEach(() => { cleanup(); themeStore.apply("light"); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("EigenPal inline Word editor", () => {
	it("loads original DOCX bytes directly, ignores load events, and does not export on each edit", async () => {
		const { ref } = await open();
		expect(engine.props?.document).toEqual(new Uint8Array(bytes));
		expect(engine.props?.menu).toBe(false);
		expect(engine.props?.locale).toBe("zh-CN");
		expect(engine.props?.i18n).toBeTruthy();
		expect(ref.current?.isDirty()).toBe(false);
		for (let i = 0; i < 30; i++) fireEvent.click(screen.getByRole("button", { name: "Type character" }));
		expect(ref.current?.isDirty()).toBe(true);
		expect(engine.save).not.toHaveBeenCalled();
		expect(storage.save).not.toHaveBeenCalled();
	});

	it("overlays the loading state inside the engine stage until ready", async () => {
		engine.autoReady = false;
		const view = render(<WordEditor file={file} workspaceId="owner" onClose={vi.fn()} />);
		const editor = await screen.findByLabelText("New DOCX engine");
		const stage = editor.parentElement!;
		expect(stage.className).toBe("inno-word-stage");
		expect(stage.getAttribute("aria-busy")).toBe("true");
		expect(stage.querySelector(".inno-word-loading")?.textContent).toContain("wordEditor.loading");
		expect(view.container.querySelectorAll(".inno-word-loading")).toHaveLength(1);
		act(() => engine.props?.onReady?.({} as never));
		expect(stage.getAttribute("aria-busy")).toBe("false");
		expect(stage.querySelector(".inno-word-loading")).toBeNull();
	});

	it("passes a callable font resolver without executing it as a React state updater", async () => {
		await open();
		expect(typeof engine.props?.fonts).toBe("function");
		expect(engine.props?.fontShaping?.maxFontBytes).toBe(64 * 1024 * 1024);
	});

	it("does not latch a warning for transient missing fonts while native resolution is pending", async () => {
		await open();
		act(() => engine.props?.onFontError?.({ code: "missing", message: "pending" } as never));
		expect(screen.queryByText("wordEditor.fontWarning")).toBeNull();
		act(() => engine.props?.onFontError?.({ code: "loadFailed", message: "failed" } as never));
		expect(screen.getByText("wordEditor.fontWarning")).toBeTruthy();
	});

	it("keeps the same document across dirty-state, theme, and inactive-tab updates", async () => {
		const { rerender, onClose } = await open();
		const original = engine.props?.document;
		fireEvent.click(screen.getByRole("button", { name: "Type character" }));
		act(() => themeStore.apply("dark"));
		expect(engine.props?.colorMode).toBe("dark");
		rerender(<WordEditor file={{ ...file }} workspaceId="owner" active={false} onClose={onClose} />);
		expect(engine.props?.document).toBe(original);
		expect(engine.mounts).toHaveBeenCalledOnce();
		expect(engine.unmounts).not.toHaveBeenCalled();
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("marks clean only after workspace persistence succeeds and saves the owning workspace", async () => {
		let acknowledge!: (result: typeof saved) => void;
		storage.save.mockImplementation(() => new Promise((resolve) => { acknowledge = resolve; }));
		const { ref } = await open();
		fireEvent.click(screen.getByRole("button", { name: "Type character" }));
		let operation!: Promise<boolean>;
		act(() => { operation = ref.current!.save(); });
		await waitFor(() => expect(storage.save).toHaveBeenCalledWith(file.path, bytes, "owner"));
		expect(ref.current!.isDirty()).toBe(true);
		await act(async () => { acknowledge(saved); expect(await operation).toBe(true); });
		expect(ref.current!.isDirty()).toBe(false);
	});

	it("keeps later edits dirty when a previous revision finishes saving", async () => {
		let acknowledge!: (result: typeof saved) => void;
		storage.save.mockImplementation(() => new Promise((resolve) => { acknowledge = resolve; }));
		const { ref } = await open();
		fireEvent.click(screen.getByRole("button", { name: "Type character" }));
		let operation!: Promise<boolean>;
		act(() => { operation = ref.current!.save(); });
		await waitFor(() => expect(storage.save).toHaveBeenCalledOnce());
		fireEvent.click(screen.getByRole("button", { name: "Type character" }));
		await act(async () => { acknowledge(saved); expect(await operation).toBe(false); });
		expect(ref.current!.isDirty()).toBe(true);
	});

	it("deduplicates simultaneous saves", async () => {
		const { ref } = await open();
		await act(async () => {
			const first = ref.current!.save();
			expect(ref.current!.save()).toBe(first);
			await first;
		});
		expect(engine.save).toHaveBeenCalledOnce();
		expect(storage.save).toHaveBeenCalledOnce();
	});

	it("preserves the draft and shows a save error when persistence fails", async () => {
		storage.save.mockRejectedValueOnce(new Error("disk full"));
		const { ref, onClose } = await open();
		fireEvent.click(screen.getByRole("button", { name: "Type character" }));
		await act(async () => { expect(await ref.current!.save()).toBe(false); });
		expect(screen.getByRole("alert").textContent).toContain("disk full");
		expect(ref.current!.isDirty()).toBe(true);
		expect(onClose).not.toHaveBeenCalled();
	});

	it("confirms unsaved close and waits for save before returning to preview", async () => {
		const { onClose } = await open();
		fireEvent.click(screen.getByRole("button", { name: "Type character" }));
		fireEvent.click(screen.getByRole("button", { name: "wordEditor.back" }));
		expect(screen.getByRole("dialog")).toBeTruthy();
		expect(onClose).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "wordEditor.saveAndClose" }));
		await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
		expect(storage.save).toHaveBeenCalledWith(file.path, bytes, "owner");
	});

	it("does not intercept Save while the editor tab is inactive", async () => {
		const { rerender, onClose } = await open({ active: false });
		fireEvent.keyDown(window, { key: "s", metaKey: true });
		expect(engine.save).not.toHaveBeenCalled();
		rerender(<WordEditor file={file} workspaceId="owner" active onClose={onClose} />);
		fireEvent.keyDown(window, { key: "s", ctrlKey: true });
		await waitFor(() => expect(storage.save).toHaveBeenCalledOnce());
	});

	it("offers a retry after a failed document fetch", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 404 } as Response);
		render(<WordEditor file={file} workspaceId="owner" onClose={vi.fn()} />);
		expect((await screen.findByRole("alert")).textContent).toContain("404");
		fireEvent.click(screen.getByRole("button", { name: "wordEditor.retry" }));
		await screen.findByLabelText("New DOCX engine");
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("aborts a document fetch when its session is unmounted", async () => {
		vi.mocked(fetch).mockImplementation(() => new Promise(() => {}));
		const view = render(<WordEditor file={file} workspaceId="owner" onClose={vi.fn()} />);
		const options = vi.mocked(fetch).mock.calls[0][1]!;
		view.unmount();
		expect(options.signal?.aborted).toBe(true);
	});
});
