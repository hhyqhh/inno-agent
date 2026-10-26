import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WordDocumentService } from "./word-document.js";

let root: string;
let workspace: string;
let service: WordDocumentService;
let exists = true;
const doc = (text: string) => Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.from(text)]);
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "inno-word-")); workspace = join(root, "workspace");
	await mkdir(workspace); await writeFile(join(workspace, "report.docx"), doc("original")); exists = true;
	service = new WordDocumentService(join(root, "data"), async (id) => exists && id === "owner" ? workspace : null);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("browser Word document storage", () => {
	it("opens without an external Office service and versions actual content", async () => {
		const first = await service.open("owner", "report.docx");
		expect(first.bytes).toEqual(doc("original")); expect(first.version).toMatch(/^[a-f0-9]{64}$/);
		await writeFile(join(workspace, "report.docx"), doc("external"));
		expect((await service.open("owner", "report.docx")).version).not.toBe(first.version);
	});
	it("commits atomically to the owning workspace and retains the opening file", async () => {
		const { version } = await service.open("owner", "report.docx");
		const result = await service.save("owner", "report.docx", version, doc("中文 edited"));
		expect(await readFile(join(workspace, "report.docx"))).toEqual(doc("中文 edited"));
		expect(await readFile(join(root, "data/office/originals", `${version}.docx`))).toEqual(doc("original"));
		expect(result.version).toBe((await service.open("owner", "report.docx")).version);
		expect(await readdir(workspace)).toEqual(["report.docx"]);
		await expect(service.save("owner", "report.docx", version, doc("中文 edited"))).resolves.toMatchObject({ version: result.version });
	});
	it("rejects external edits and competing browser saves without losing either original", async () => {
		const { version } = await service.open("owner", "report.docx");
		const saves = await Promise.allSettled([service.save("owner", "report.docx", version, doc("first")), service.save("owner", "report.docx", version, doc("second"))]);
		expect(saves[0].status).toBe("fulfilled"); expect(saves[1]).toMatchObject({ status: "rejected", reason: { code: "WORD_EDITOR_CONFLICT" } });
		await writeFile(join(workspace, "report.docx"), doc("native app"));
		await expect(service.save("owner", "report.docx", version, doc("browser"))).rejects.toMatchObject({ code: "WORD_EDITOR_CONFLICT" });
		expect(await readFile(join(workspace, "report.docx"))).toEqual(doc("native app"));
	});
	it.each(["../secret.docx", "/private.docx", "C:\\private.docx"])("rejects unsafe path %s", async (path) => {
		await expect(service.open("owner", path)).rejects.toMatchObject({ code: "WORD_EDITOR_INVALID_PATH" });
	});
	it("rejects symlinks outside the workspace and removed workspaces", async () => {
		await writeFile(join(root, "outside.docx"), doc("private"));
		await symlink(join(root, "outside.docx"), join(workspace, "link.docx"));
		await expect(service.open("owner", "link.docx")).rejects.toMatchObject({ code: "WORD_EDITOR_INVALID_PATH" });
		const { version } = await service.open("owner", "report.docx"); exists = false;
		await expect(service.save("owner", "report.docx", version, doc("edit"))).rejects.toMatchObject({ code: "WORD_EDITOR_FILE_MISSING" });
	});
	it("requires a content version, DOCX extension and bounded ZIP bytes", async () => {
		await expect(service.open("owner", "report.doc")).rejects.toMatchObject({ code: "WORD_EDITOR_DOCX_REQUIRED" });
		await expect(service.save("owner", "report.docx", "", doc("edit"))).rejects.toMatchObject({ code: "WORD_EDITOR_VERSION_REQUIRED" });
		await expect(service.save("owner", "report.docx", "a".repeat(64), Buffer.from("html"))).rejects.toMatchObject({ code: "WORD_EDITOR_INVALID_DOCUMENT" });
		await expect(service.save("owner", "report.docx", "a".repeat(64), Buffer.alloc(32 * 1024 * 1024 + 1))).rejects.toMatchObject({ code: "WORD_EDITOR_TOO_LARGE" });
	});
});
