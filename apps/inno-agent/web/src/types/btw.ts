/** Side-question data lives beside the main conversation and never enters the
 * main transcript unless the learner explicitly brings an exchange back. */

export interface BtwThreadTurn {
	question: string;
	answer: string;
}

export interface BtwExchange extends BtwThreadTurn {
	id: string;
	status: "pending" | "done" | "error";
	/** Set when status is "error" (network/completion failure). */
	error?: string;
	/** True once this exchange has been brought back into the main session. */
	broughtBack?: boolean;
}

export interface BtwTabState {
	id: string;
	number: number;
	draft: string;
	scrollTop: number;
	exchanges: BtwExchange[];
}

export interface BtwSessionState {
	nextTabNumber: number;
	activeTabId: string | null;
	tabs: BtwTabState[];
}

export interface BtwWindowGeometry {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface BtwStateResponse {
	session: BtwSessionState;
	window: BtwWindowGeometry;
	windowInitialized: boolean;
	minimized: boolean;
}
