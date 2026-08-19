import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const archiveRawFileMock = vi.hoisted(() => vi.fn());
vi.mock("./sources-service.js", () => ({ archiveRawFile: archiveRawFileMock }));

import { archiveConversation } from "./conversation-archive-service.js";

const roots: string[] = [];
afterEach(() => {
	archiveRawFileMock.mockReset();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "inno-conversation-"));
	roots.push(root);
	return root;
}

describe("archiveConversation", () => {
	it("writes only selected messages before invoking the shared archive pipeline", async () => {
		const root = tempRoot();
		archiveRawFileMock.mockResolvedValue({ status: "indexed" });
		await archiveConversation(root, {
			sessionId: "session.jsonl",
			title: "Selected chat",
			tags: [" learning ", ""],
			messageIds: ["assistant-1"],
			messages: [
				{ id: "user-1", role: "user", content: "skip me", timestamp: Date.UTC(2026, 0, 1) },
				{ id: "assistant-1", role: "assistant", content: "keep me", timestamp: Date.UTC(2026, 0, 2) },
			],
		});

		expect(archiveRawFileMock).toHaveBeenCalledOnce();
		const [, rawPath, options] = archiveRawFileMock.mock.calls[0];
		expect(rawPath).toMatch(/^raw\/conversations\/2026-\d{2}-\d{2}-selected-chat-[a-f0-9]{8}\.md$/);
		expect(options.tags).toEqual(["learning"]);
		const markdown = readFileSync(join(root, rawPath), "utf-8");
		expect(markdown).toContain('session_id: "session.jsonl"');
		expect(markdown).toContain('  - "assistant-1"');
		expect(markdown).toContain("keep me");
		expect(markdown).not.toContain("skip me");
	});

	it("rejects a selection that does not match any session message", async () => {
		await expect(archiveConversation(tempRoot(), {
			sessionId: "session.jsonl",
			title: "Missing",
			messageIds: ["unknown"],
			messages: [{ id: "known", role: "user", content: "hello", timestamp: 0 }],
		})).rejects.toThrow("没有可归档的对话消息");
		expect(archiveRawFileMock).not.toHaveBeenCalled();
	});
});
