import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { L2Memory } from "./l2-memory.js";
import {
	archiveL2Note,
	createL2Note,
	listL2Notes,
	readNoteContent,
	saveL2NoteContent,
} from "./notes-service.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "inno-note-archive-"));
	tempDirs.push(dir);
	return dir;
}

function fakeMemory(root: string): L2Memory {
	return {
		dataDir: root,
		indexPageByPath: vi.fn().mockResolvedValue(undefined),
		removePage: vi.fn().mockResolvedValue(undefined),
	} as unknown as L2Memory;
}

function deferred<T>() {
	let resolvePromise!: (value: T) => void;
	const promise = new Promise<T>((resolvePromiseCallback) => {
		resolvePromise = resolvePromiseCallback;
	});
	return { promise, resolve: resolvePromise };
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("archiveL2Note", () => {
	it("preserves edits made while a note is being archived", async () => {
		const root = makeTempDir();
		const created = createL2Note(root, resolve("apps/inno-agent"), {
			title: "并发编辑",
			content: "归档开始时的正文",
		});
		const firstIndex = deferred<void>();
		const memory = fakeMemory(root);
		vi.mocked(memory.indexPageByPath)
			.mockImplementationOnce(() => firstIndex.promise)
			.mockResolvedValue(undefined);

		const archiving = archiveL2Note(root, created.rawPath, { memory });
		await vi.waitFor(() => expect(memory.indexPageByPath).toHaveBeenCalledTimes(1));
		saveL2NoteContent(root, created.rawPath, {
			title: "并发编辑",
			content: "归档期间保存的新正文",
		});

		firstIndex.resolve();
		await archiving;
		const current = readNoteContent(root, created.rawPath);
		expect(current.content).toContain("归档期间保存的新正文");
		expect(current.status).toBe("outdated");
	});

	it("keeps one editable item through archive, edit, and rearchive", async () => {
		const root = makeTempDir();
		const memory = fakeMemory(root);
		const created = createL2Note(root, resolve("apps/inno-agent"), {
			title: "生命周期",
			content: "第一版 [[笔记流程]]",
		});

		const archived = await archiveL2Note(root, created.rawPath, { memory });
		expect(listL2Notes(root).notes).toMatchObject([
			{ rawPath: created.rawPath, sourceId: archived.sourceId, kind: "markdown", status: "indexed" },
		]);
		saveL2NoteContent(root, created.rawPath, { title: "生命周期", content: "第二版 [[笔记流程]]" });
		expect(listL2Notes(root).notes).toMatchObject([
			{ rawPath: created.rawPath, kind: "markdown", status: "outdated" },
		]);
		await archiveL2Note(root, created.rawPath, { memory });
		expect(listL2Notes(root).notes).toMatchObject([
			{ rawPath: created.rawPath, kind: "markdown", status: "indexed" },
		]);
	});

	it("leaves a concurrently archived note indexed", async () => {
		const root = makeTempDir();
		const memory = fakeMemory(root);
		const created = createL2Note(root, resolve("apps/inno-agent"), {
			title: "重复归档",
			content: "不会被误标过期",
		});

		const results = await Promise.all([
			archiveL2Note(root, created.rawPath, { memory }),
			archiveL2Note(root, created.rawPath, { memory }),
		]);
		expect(results.map((result) => result.duplicate)).toEqual([false, true]);
		expect(readNoteContent(root, created.rawPath).status).toBe("indexed");
	});
});
