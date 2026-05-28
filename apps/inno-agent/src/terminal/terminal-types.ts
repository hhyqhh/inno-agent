// ---------------------------------------------------------------------------
// Terminal WebSocket protocol types.
// ---------------------------------------------------------------------------

export type ClientTerminalEvent =
	| { type: "input"; data: string }
	| { type: "resize"; cols: number; rows: number }
	| { type: "run"; command: string; sourceFile?: string }
	| { type: "close" };

export type ServerTerminalEvent =
	| { type: "ready"; sessionId: string; cwd: string; workspaceId: string }
	| { type: "output"; data: string }
	| { type: "exit"; code: number | null; signal?: string; runId?: string }
	| { type: "run_started"; runId: string; command: string }
	| { type: "error"; message: string };

export interface RunRecord {
	id: string;
	sessionId: string;
	workspaceId: string;
	command: string;
	cwd: string;
	startedAt: string;
	endedAt?: string;
	exitCode?: number | null;
	signal?: string;
	sourceFile?: string;
	logPath: string;
	outputBytes: number;
}
