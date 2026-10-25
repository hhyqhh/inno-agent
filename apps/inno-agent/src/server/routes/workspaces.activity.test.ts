import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TEMP_WORKSPACE_ID } from "../../workspace/workspace-registry.js";
import { listWorkspaceWriteActivity } from "../workspace-activity-store.js";
import { handleWorkspacesRoutes, type WorkspacesRouteContext } from "./workspaces.js";

vi.mock("../../agent/pi-runner.js", () => ({ applyWorkspaceCwd: vi.fn(), getCurrentSessionId: vi.fn() }));
vi.mock("../workspace-activity-store.js", () => ({ listWorkspaceWriteActivity: vi.fn() }));

const listWorkspacesAsync = vi.fn();
const context = { dataDir: "/data", workspaceRegistry: { listWorkspacesAsync } } as unknown as WorkspacesRouteContext;
async function get(url: string) {
	const res = { writeHead: vi.fn(), end: vi.fn() };
	expect(await handleWorkspacesRoutes({} as IncomingMessage, res as unknown as ServerResponse, "GET", url, context)).toBe(true);
	return { status: res.writeHead.mock.calls[0][0], body: JSON.parse(res.end.mock.calls[0][0]) };
}

beforeEach(() => {
	vi.resetAllMocks();
	listWorkspacesAsync.mockResolvedValue([{ id: "other" }, { id: TEMP_WORKSPACE_ID }]);
	vi.mocked(listWorkspaceWriteActivity).mockResolvedValue({ files: [], trackingIncomplete: false });
});

describe("workspace file activity route", () => {
	it("queries only the requested workspace", async () => {
		const activity = { files: [{ path: "report.md", lastSeenAt: "2026-10-25T00:00:00Z" }], trackingIncomplete: true };
		vi.mocked(listWorkspaceWriteActivity).mockResolvedValue(activity);
		expect(await get("/api/workspace/activity?workspaceId=other")).toEqual({ status: 200, body: activity });
		expect(listWorkspacesAsync).toHaveBeenCalledOnce();
		expect(listWorkspaceWriteActivity).toHaveBeenCalledWith("/data", "other");
	});
	it("uses the default workspace when no workspace id is supplied", async () => {
		expect((await get("/api/workspace/activity")).status).toBe(200);
		expect(listWorkspaceWriteActivity).toHaveBeenCalledWith("/data", TEMP_WORKSPACE_ID);
	});
	it("rejects deleted or unknown workspaces before reading activity", async () => {
		listWorkspacesAsync.mockResolvedValue([]);
		expect((await get("/api/workspace/activity?workspaceId=missing")).status).toBe(404);
		expect(listWorkspaceWriteActivity).not.toHaveBeenCalled();
	});
});
