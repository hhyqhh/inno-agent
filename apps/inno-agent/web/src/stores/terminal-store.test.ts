import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
	create: vi.fn(async () => ({ id: "terminal-1", workspaceId: "workspace-1", cwd: "/workspace" })),
	close: vi.fn(async () => undefined),
}));

vi.mock("../api/terminal.js", () => ({
	createTerminalSession: apiMocks.create,
	closeTerminalSession: apiMocks.close,
	terminalWsUrl: (id: string) => `ws://example.test/${id}`,
}));

const sent: string[] = [];
let currentSocket: FakeWebSocket;

class FakeWebSocket {
	static readonly OPEN = 1;
	readyState = FakeWebSocket.OPEN;
	onmessage: ((event: { data: string }) => void) | null = null;
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;

	constructor(_url: string) {
		currentSocket = this;
	}

	send(value: string) { sent.push(value); }
	close() { this.readyState = 3; }
}

vi.stubGlobal("WebSocket", FakeWebSocket);

import { terminalStore } from "./terminal-store.js";

beforeEach(async () => {
	await terminalStore.disconnect();
	terminalStore.setOpen(false);
	sent.length = 0;
	apiMocks.create.mockClear();
	apiMocks.close.mockClear();
});

afterEach(async () => {
	await terminalStore.disconnect();
});

describe("terminalStore code-block runs", () => {
	it("keeps a command queued while opening and connecting the Practice Lab", async () => {
		terminalStore.runCommand("python -c \"print(42)\"", "model_reply.py");
		expect(terminalStore.isOpen).toBe(true);

		await terminalStore.connect("session-1", "workspace-1");
		expect(sent).toEqual([]);

		currentSocket.onmessage?.({ data: JSON.stringify({ type: "ready", cwd: "/workspace" }) });
		expect(sent.map((value) => JSON.parse(value))).toEqual([{
			type: "run",
			command: "python -c \"print(42)\"",
			sourceFile: "model_reply.py",
		}]);
	});
});
