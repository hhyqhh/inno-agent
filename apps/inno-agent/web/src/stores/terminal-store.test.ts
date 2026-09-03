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
const sockets: FakeWebSocket[] = [];

class FakeWebSocket {
	static readonly OPEN = 1;
	readyState = FakeWebSocket.OPEN;
	onmessage: ((event: { data: string }) => void) | null = null;
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;

	constructor(_url: string) {
		currentSocket = this;
		sockets.push(this);
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
	sockets.length = 0;
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

	it("sends immediately while a previous run is still executing", async () => {
		await terminalStore.connect("session-1", "workspace-1");
		currentSocket.onmessage?.({ data: JSON.stringify({ type: "ready", cwd: "/workspace" }) });
		currentSocket.onmessage?.({ data: JSON.stringify({ type: "run_started", runId: "r1", command: "first" }) });
		expect(terminalStore.status).toBe("running");
		sent.length = 0;

		terminalStore.runCommand("python -c \"print(2)\"");
		expect(sent.map((value) => JSON.parse(value))).toEqual([{
			type: "run",
			command: "python -c \"print(2)\"",
			sourceFile: undefined,
		}]);
	});

	it("flushes every queued command in order once the socket is ready", async () => {
		terminalStore.runCommand("python -c \"print(1)\"");
		terminalStore.runCommand("python -c \"print(2)\"");

		await terminalStore.connect("session-1", "workspace-1");
		currentSocket.onmessage?.({ data: JSON.stringify({ type: "ready", cwd: "/workspace" }) });
		expect(sent.map((value) => JSON.parse(value).command)).toEqual([
			"python -c \"print(1)\"",
			"python -c \"print(2)\"",
		]);
	});

	it("drops the queue when the terminal session cannot be created", async () => {
		terminalStore.runCommand("python -c \"print(1)\"");
		apiMocks.create.mockRejectedValueOnce(new Error("boom"));
		await terminalStore.connect("session-1", "workspace-1");
		expect(terminalStore.status).toBe("error");

		// A later, unrelated connect must not resurrect the stale command.
		await terminalStore.connect("session-2", "workspace-2");
		currentSocket.onmessage?.({ data: JSON.stringify({ type: "ready", cwd: "/workspace" }) });
		expect(sent).toEqual([]);
	});

	it("drops the queue when the socket errors before ready", async () => {
		terminalStore.runCommand("python -c \"print(1)\"");
		await terminalStore.connect("session-1", "workspace-1");
		currentSocket.onerror?.();
		expect(terminalStore.status).toBe("error");

		await terminalStore.connect("session-2", "workspace-2");
		currentSocket.onmessage?.({ data: JSON.stringify({ type: "ready", cwd: "/workspace" }) });
		expect(sent).toEqual([]);
	});

	// Regression: React StrictMode mounts TerminalView twice, firing two
	// connect() calls that interleave. The superseded attempt must clean up
	// its server-side session and never touch shared state afterwards.
	it("survives a StrictMode-style double connect with the queue intact", async () => {
		terminalStore.runCommand("python -c \"print(1)\"");
		await Promise.all([
			terminalStore.connect("session-1", "workspace-1"),
			terminalStore.connect("session-1", "workspace-1"),
		]);

		// Exactly one live socket; the superseded session was closed server-side.
		expect(sockets.length).toBe(1);
		expect(apiMocks.close).toHaveBeenCalledTimes(1);
		expect(terminalStore.status).toBe("connecting");

		currentSocket.onmessage?.({ data: JSON.stringify({ type: "ready", cwd: "/workspace" }) });
		expect(sent.map((value) => JSON.parse(value).command)).toEqual(["python -c \"print(1)\""]);
	});

	// Regression: a replaced socket's error event used to set status "error"
	// and wipe the queue while the replacement connection was live.
	it("ignores error/close/message events from a replaced socket", async () => {
		await terminalStore.connect("session-1", "workspace-1");
		currentSocket.onmessage?.({ data: JSON.stringify({ type: "ready", cwd: "/workspace" }) });
		const stale = currentSocket;

		await terminalStore.connect("session-2", "workspace-2");
		expect(currentSocket).not.toBe(stale);
		expect(terminalStore.status).toBe("connecting");

		stale.onerror?.();
		expect(terminalStore.status).toBe("connecting");
		expect(terminalStore.error).toBe("");

		stale.onclose?.();
		expect(terminalStore.status).toBe("connecting");

		currentSocket.onmessage?.({ data: JSON.stringify({ type: "ready", cwd: "/workspace" }) });
		expect(terminalStore.status).toBe("connected");
	});

	it("revives a disconnected session on the next Run click", async () => {
		await terminalStore.connect("session-1", "workspace-1");
		currentSocket.onmessage?.({ data: JSON.stringify({ type: "ready", cwd: "/workspace" }) });

		// Socket dies (backend restart, network drop).
		const dead = currentSocket;
		dead.close();
		dead.onclose?.();
		expect(terminalStore.status).toBe("disconnected");

		terminalStore.runCommand("python -c \"print(9)\"");
		await vi.waitFor(() => expect(currentSocket).not.toBe(dead));
		currentSocket.onmessage?.({ data: JSON.stringify({ type: "ready", cwd: "/workspace" }) });
		expect(sent.map((value) => JSON.parse(value).command)).toEqual(["python -c \"print(9)\""]);
	});
});
