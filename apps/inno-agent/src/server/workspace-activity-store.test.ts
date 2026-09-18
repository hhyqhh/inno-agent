import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getWorkspaceFileActivities,
	recordToolWorkspaceActivity,
	recordWorkspaceAttachmentActivity,
	recordWorkspaceFileAccess,
	resetWorkspaceActivityStoreForTests,
	workspaceActivityMetadataPath,
} from "./workspace-activity-store.js";
import { traceMetadataPath } from "./trace-store.js";

let dir: string;
let root: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "workspace-activity-"));
	root = join(dir, "workspace");
	mkdirSync(root, { recursive: true });
	resetWorkspaceActivityStoreForTests();
});

afterEach(() => {
	resetWorkspaceActivityStoreForTests();
	rmSync(dir, { recursive: true, force: true });
});

describe("workspace activity sidecar", () => {
	it("merges read and write access without storing content", () => {
		writeFileSync(join(root, "notes.md"), "secret content");
		recordWorkspaceFileAccess(dir, { sessionId: "s1", workspaceId: "w1", workspaceRoot: root, paths: ["notes.md"], access: "read" });
		recordToolWorkspaceActivity(dir, { sessionId: "s1", workspaceId: "w1", workspaceRoot: root, toolName: "write_file", args: { path: "notes.md" } });
		recordWorkspaceAttachmentActivity(dir, {
			sessionId: "s1",
			workspaceId: "w1",
			workspaceRoot: root,
			attachments: { bindings: [], loose: [{ path: "notes.md", kind: "file", source: "workspace" }] },
		});
		const body = readFileSync(workspaceActivityMetadataPath(dir), "utf8");
		expect(body).not.toContain("secret content");
		expect(getWorkspaceFileActivities(dir, { sessionId: "s1", workspaceId: "w1", workspaceRoot: root })).toMatchObject({
			trackingIncomplete: false,
			files: [{ sessionId: "s1", workspaceId: "w1", path: "notes.md", access: "read_write" }],
		});
	});

	it("marks indirect shell access incomplete and ignores dependency paths", () => {
		mkdirSync(join(root, "node_modules"), { recursive: true });
		writeFileSync(join(root, "node_modules", "ignored.js"), "x");
		recordToolWorkspaceActivity(dir, { sessionId: "s1", workspaceId: "w1", workspaceRoot: root, toolName: "bash", args: { command: "cat notes.md" } });
		recordWorkspaceFileAccess(dir, { sessionId: "s1", workspaceId: "w1", workspaceRoot: root, paths: ["node_modules/ignored.js", "agent.md"], access: "read" });
		const activity = getWorkspaceFileActivities(dir, { sessionId: "s1", workspaceId: "w1", workspaceRoot: root });
		expect(activity.trackingIncomplete).toBe(true);
		expect(activity.files.map((file) => file.path)).toEqual(["agent.md"]);
		expect(existsSync(workspaceActivityMetadataPath(dir))).toBe(true);
	});

	it("recovers explicit paths from legacy traces and marks the estimate incomplete", () => {
		writeFileSync(join(root, "legacy.md"), "old");
		mkdirSync(join(dir, "sessions"), { recursive: true });
		writeFileSync(traceMetadataPath(dir), JSON.stringify({
			"s1": [{
				assistantIndex: 0,
				events: [{
					occurredAt: "2026-09-17T00:00:00.000Z",
					event: { type: "tool_start", workspaceId: "w1", toolName: "read", args: { path: "legacy.md" } },
				}],
			}],
		}));
		const activity = getWorkspaceFileActivities(dir, {
			sessionId: "s1",
			workspaceId: "w1",
			workspaceRoot: root,
			hasSessionHistory: true,
		});
		expect(activity.files).toEqual([expect.objectContaining({ path: "legacy.md", access: "read" })]);
		expect(activity.trackingIncomplete).toBe(true);
	});

	it("does not attribute unscoped or other-workspace legacy traces", () => {
		writeFileSync(join(root, "same.md"), "current workspace");
		mkdirSync(join(dir, "sessions"), { recursive: true });
		writeFileSync(traceMetadataPath(dir), JSON.stringify({
			"s1": [{
				assistantIndex: 0,
				events: [
					{
						occurredAt: "2026-09-17T00:00:00.000Z",
						event: { type: "tool_start", workspaceId: "w2", toolName: "read", args: { path: "same.md" } },
					},
					{
						occurredAt: "2026-09-17T00:00:01.000Z",
						event: { type: "tool_start", toolName: "read", args: { path: "same.md" } },
					},
				],
			}],
		}));

		const activity = getWorkspaceFileActivities(dir, {
			sessionId: "s1",
			workspaceId: "w1",
			workspaceRoot: root,
			hasSessionHistory: true,
		});
		expect(activity.files).toEqual([]);
		expect(activity.trackingIncomplete).toBe(true);
	});
});
