import { mkdir, mkdtemp, readFile, rm, stat, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WordPreviewService } from "./word-preview.js";
import type { OfficePdfConverter } from "./pdf-converter.js";

let root: string;
let service: WordPreviewService;
const pdf = Buffer.from("%PDF-1.7\npreview");
const convert = vi.fn(async (_content: Buffer, _extension: string, output: string) => { await writeFile(output, pdf); });
const fingerprint = vi.fn(async () => "26.8.1");
const converter = { convert, fingerprint, warm: vi.fn(), stop: vi.fn(), dispose: vi.fn() } as unknown as OfficePdfConverter;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "word-preview-test-"));
	service = new WordPreviewService(join(root, "cache"), converter);
	convert.mockImplementation(async (_content, _extension, output) => { await writeFile(output, pdf); });
	fingerprint.mockResolvedValue("26.8.1");
});
afterEach(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); vi.clearAllMocks(); });

describe("Word PDF previews", () => {
	it.each(["doc", "docx"])("converts an immutable %s snapshot without changing the original", async (extension) => {
		await writeFile(join(root, `source.${extension}`), "original document");
		const result = await service.get(root, `source.${extension}`);
		expect(await readFile(result.path)).toEqual(pdf);
		expect(result.size).toBe(pdf.length);
		expect(convert).toHaveBeenCalledWith(Buffer.from("original document"), `.${extension}`, expect.stringMatching(/\.partial$/));
		expect(await readFile(join(root, `source.${extension}`), "utf8")).toBe("original document");
	});
	it("reuses cache across service restarts and detects a same-size save with restored mtime", async () => {
		const source = join(root, "source.docx"); await writeFile(source, "version1");
		const info = await stat(source);
		const first = await service.get(root, "source.docx");
		await service.get(root, "source.docx");
		service = new WordPreviewService(join(root, "cache"), converter);
		expect(await service.get(root, "source.docx")).toEqual(first);
		expect(convert).toHaveBeenCalledTimes(1);
		await writeFile(source, "version2"); await utimes(source, info.atime, info.mtime);
		expect((await service.get(root, "source.docx")).etag).not.toBe(first.etag);
		expect(convert).toHaveBeenCalledTimes(2);
	});
	it("coalesces duplicate requests and serializes different documents", async () => {
		for (const name of ["a", "b"]) await writeFile(join(root, `${name}.docx`), name);
		let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
		convert.mockImplementationOnce(async (_content, _extension, output) => { await gate; await writeFile(output, pdf); });
		const first = service.get(root, "a.docx"), second = service.get(root, "a.docx"), third = service.get(root, "b.docx");
		await vi.waitFor(() => expect(convert).toHaveBeenCalledTimes(1));
		release(); const results = await Promise.all([first, second, third]);
		expect(results[0]).toEqual(results[1]); expect(results[2].etag).not.toBe(results[0].etag);
		expect(convert).toHaveBeenCalledTimes(2);
	});
	it("invalidates an unchanged document's disk cache after an engine update", async () => {
		await writeFile(join(root, "source.docx"), "same document");
		const first = await service.get(root, "source.docx");
		await service.dispose();
		fingerprint.mockResolvedValue("26.8.2");
		service = new WordPreviewService(join(root, "cache"), converter);
		expect((await service.get(root, "source.docx")).etag).not.toBe(first.etag);
		expect(convert).toHaveBeenCalledTimes(2);
	});
	it("reports the known grid-layout defect without converting or reusing a cached PDF", async () => {
		await writeFile(join(root, "source.docx"), "same document");
		await service.get(root, "source.docx"); await service.dispose();
		service = new WordPreviewService(join(root, "cache"), converter);
		fingerprint.mockRejectedValueOnce(new Error("WORD_ENGINE_INCOMPATIBLE"));
		await expect(service.get(root, "source.docx")).rejects.toMatchObject({ code: "WORD_ENGINE_INCOMPATIBLE", status: 503 });
		expect(convert).toHaveBeenCalledTimes(1);
		await service.get(root, "source.docx");
	});
	it("keeps same-name files in separate folders independent", async () => {
		for (const name of ["a", "b"]) { await mkdir(join(root, name)); await writeFile(join(root, name, "report.docx"), "same content"); }
		const results = await Promise.all([service.get(root, "a/report.docx"), service.get(root, "b/report.docx")]);
		expect(results[0].etag).not.toBe(results[1].etag);
	});
	it("rejects traversal, escaping links, unsupported formats and missing files", async () => {
		await symlink(tmpdir(), join(root, "escape"));
		for (const path of ["../outside.docx", "escape/outside.docx", "missing.docx"]) await expect(service.get(root, path)).rejects.toMatchObject({ status: 404 });
		await expect(service.get(root, "file.txt")).rejects.toMatchObject({ status: 415 }); expect(convert).not.toHaveBeenCalled();
	});
	it("does not cache invalid output, hides converter paths, and permits retry", async () => {
		await writeFile(join(root, "source.docx"), "original");
		convert.mockRejectedValueOnce(new Error("WORD_ENGINE_UNAVAILABLE"));
		await expect(service.get(root, "source.docx")).rejects.toMatchObject({ code: "WORD_ENGINE_UNAVAILABLE", status: 503 });
		convert.mockRejectedValueOnce(new Error(`failure: ${root}`));
		await expect(service.get(root, "source.docx")).rejects.toMatchObject({ message: "Unable to convert this Word document to PDF." });
		convert.mockImplementationOnce(async (_c, _e, output) => { await writeFile(output, "bad output"); });
		await expect(service.get(root, "source.docx")).rejects.toMatchObject({ code: "WORD_PREVIEW_FAILED" });
		expect(await readFile((await service.get(root, "source.docx")).path)).toEqual(pdf);
	});
	it("rejects oversized input before conversion", async () => {
		const path = join(root, "large.docx"); await writeFile(path, ""); await truncate(path, 25 * 1024 * 1024 + 1);
		await expect(service.get(root, "large.docx")).rejects.toMatchObject({ status: 413 }); expect(convert).not.toHaveBeenCalled();
	});
});
