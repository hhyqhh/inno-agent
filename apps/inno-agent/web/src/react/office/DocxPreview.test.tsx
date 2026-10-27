import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceFileDetail } from "../../types/workspace.js";
import { renderWithTooltipProvider as render } from "../test-utils.js";
import DocxPreview from "./DocxPreview.js";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("./PdfPreview.js", () => ({ default: ({ url, name }: { url: string; name: string }) => <div title={name} data-url={url} /> }));

const file: WorkspaceFileDetail = {
	path: "report.docx", name: "report.docx", kind: "office", format: "docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	size: 123, updatedAt: "version1", url: "/api/workspace/raw?path=report.docx", previewUrl: "/api/workspace/word-preview?path=report.docx",
};
const previewUrl = "/api/workspace/word-preview?path=report.docx&v=version1";
const pdfResponse = () => ({ ok: true, json: async () => ({ url: previewUrl, size: 123 }) });
beforeEach(() => { vi.stubGlobal("fetch", vi.fn().mockResolvedValue(pdfResponse())); });
afterEach(() => {
	cleanup();
	delete document.documentElement.dataset.theme;
	vi.unstubAllGlobals();
});

describe("Word PDF preview", () => {
	it.each(["light", "dark"])("loads the PDF directly for range requests in %s mode", async (theme) => {
		document.documentElement.dataset.theme = theme;
		render(<DocxPreview file={file} />);
		expect(screen.getByRole("status").textContent).toContain("preview.wordOpening");
		await waitFor(() => expect(screen.getByTitle(file.name).getAttribute("data-url")).toBe(previewUrl));
		expect(fetch).toHaveBeenCalledWith(`${file.previewUrl}&metadata=1`, expect.objectContaining({ cache: "no-store" }));
	});

	it("reloads after the same document is saved", async () => {
		const { rerender } = render(<DocxPreview file={file} />);
		await screen.findByTitle(file.name);
		rerender(<DocxPreview file={{ ...file, updatedAt: "version2" }} />);
		expect(screen.queryByTitle(file.name)).toBeNull();
		await screen.findByTitle(file.name);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("ignores an old conversion when switching documents", async () => {
		let finishOld!: (response: ReturnType<typeof pdfResponse>) => void;
		vi.mocked(fetch).mockReturnValueOnce(new Promise((resolve) => { finishOld = resolve as typeof finishOld; }));
		const { rerender } = render(<DocxPreview file={file} />);
		const signal = vi.mocked(fetch).mock.calls[0][1]?.signal;
		const next = { ...file, path: "next.doc", name: "next.doc", previewUrl: "/api/workspace/word-preview?path=next.doc" };
		rerender(<DocxPreview file={next} />);
		await screen.findByTitle(next.name);
		await act(async () => finishOld(pdfResponse()));
		expect(signal?.aborted).toBe(true);
		expect(screen.queryByTitle(file.name)).toBeNull();
	});

	it("shows an actionable engine error and retries without reloading the panel", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({ ok: false, json: async () => ({ code: "WORD_ENGINE_UNAVAILABLE" }) } as Response);
		render(<DocxPreview file={file} />);
		expect((await screen.findByRole("alert")).textContent).toContain("preview.wordEngineMissing");
		expect(screen.queryByRole("button", { name: /download|print/i })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: /preview.wordRetry/ }));
		await screen.findByTitle(file.name);
		expect(fetch).toHaveBeenCalledTimes(2);
	});
	it.each(["light", "dark"])("explains the engine layout defect in %s mode", async (theme) => {
		document.documentElement.dataset.theme = theme;
		vi.mocked(fetch).mockResolvedValueOnce({ ok: false, json: async () => ({ code: "WORD_ENGINE_INCOMPATIBLE" }) } as Response);
		render(<DocxPreview file={file} />);
		expect((await screen.findByRole("alert")).textContent).toContain("preview.wordEngineIncompatible");
		expect(screen.queryByTitle(file.name)).toBeNull();
	});
});
