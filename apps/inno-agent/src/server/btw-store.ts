import { join } from "node:path";
import { readJson, writeJson } from "../storage/file-store.js";

export const BTW_STATE_VERSION = 1 as const;
export const BTW_INTERRUPTED_ERROR = "回答在应用关闭时中断，请重试";

export type BtwExchangeStatus = "pending" | "done" | "error";

export interface BtwExchangeState {
	id: string;
	question: string;
	answer: string;
	status: BtwExchangeStatus;
	error?: string;
	broughtBack?: boolean;
}

export interface BtwTabState {
	id: string;
	number: number;
	draft: string;
	scrollTop: number;
	exchanges: BtwExchangeState[];
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

export interface BtwPersistedState {
	version: typeof BTW_STATE_VERSION;
	window: BtwWindowGeometry;
	windowInitialized: boolean;
	minimized: boolean;
	sessions: Record<string, BtwSessionState>;
}

export interface BtwStateResponse {
	session: BtwSessionState;
	window: BtwWindowGeometry;
	windowInitialized: boolean;
	minimized: boolean;
}

const DEFAULT_WINDOW: BtwWindowGeometry = {
	x: 0,
	y: 0,
	width: 520,
	height: 420,
};

let cache = new Map<string, BtwPersistedState>();

export function btwStatePath(dataDir: string): string {
	return join(dataDir, "sessions", "btw.json");
}

function defaultSession(): BtwSessionState {
	return { nextTabNumber: 1, activeTabId: null, tabs: [] };
}

function defaultState(): BtwPersistedState {
	return {
		version: BTW_STATE_VERSION,
		window: { ...DEFAULT_WINDOW },
		windowInitialized: false,
		minimized: false,
		sessions: {},
	};
}

function finiteNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeExchange(raw: unknown, restorePending: boolean): BtwExchangeState | null {
	if (!raw || typeof raw !== "object") return null;
	const item = raw as Record<string, unknown>;
	const id = typeof item.id === "string" && item.id ? item.id : "";
	const question = typeof item.question === "string" ? item.question : "";
	const answer = typeof item.answer === "string" ? item.answer : "";
	const status = item.status === "pending" || item.status === "done" || item.status === "error"
		? item.status
		: null;
	if (!id || !question || !status) return null;

	const interrupted = restorePending && status === "pending";
	return {
		id,
		question,
		answer,
		status: interrupted ? "error" : status,
		...(typeof item.error === "string" && item.error ? { error: item.error } : {}),
		...(interrupted ? { error: BTW_INTERRUPTED_ERROR } : {}),
		...(item.broughtBack === true ? { broughtBack: true } : {}),
	};
}

function normalizeTab(raw: unknown, restorePending: boolean): BtwTabState | null {
	if (!raw || typeof raw !== "object") return null;
	const item = raw as Record<string, unknown>;
	const id = typeof item.id === "string" && item.id ? item.id : "";
	const number = finiteNumber(item.number, 0);
	if (!id || number < 1) return null;
	const rawExchanges = Array.isArray(item.exchanges) ? item.exchanges : [];
	return {
		id,
		number: Math.floor(number),
		draft: typeof item.draft === "string" ? item.draft : "",
		scrollTop: Math.max(0, finiteNumber(item.scrollTop, 0)),
		exchanges: rawExchanges
			.map((exchange) => normalizeExchange(exchange, restorePending))
			.filter((exchange): exchange is BtwExchangeState => exchange !== null),
	};
}

function normalizeSession(raw: unknown, restorePending: boolean): BtwSessionState {
	if (!raw || typeof raw !== "object") return defaultSession();
	const item = raw as Record<string, unknown>;
	const tabs = (Array.isArray(item.tabs) ? item.tabs : [])
		.map((tab) => normalizeTab(tab, restorePending))
		.filter((tab): tab is BtwTabState => tab !== null);
	const maxNumber = tabs.reduce((max, tab) => Math.max(max, tab.number), 0);
	const requestedNext = finiteNumber(item.nextTabNumber, 1);
	const activeTabId = typeof item.activeTabId === "string" && tabs.some((tab) => tab.id === item.activeTabId)
		? item.activeTabId
		: (tabs[0]?.id ?? null);
	return {
		nextTabNumber: Math.max(1, Math.floor(requestedNext), maxNumber + 1),
		activeTabId,
		tabs,
	};
}

function normalizeState(raw: unknown, restorePending: boolean): BtwPersistedState {
	const base = defaultState();
	if (!raw || typeof raw !== "object") return base;
	const item = raw as Record<string, unknown>;
	const rawWindow = item.window && typeof item.window === "object"
		? item.window as Record<string, unknown>
		: {};
	const sessions: Record<string, BtwSessionState> = {};
	if (item.sessions && typeof item.sessions === "object") {
		for (const [sessionId, session] of Object.entries(item.sessions as Record<string, unknown>)) {
			if (sessionId) sessions[sessionId] = normalizeSession(session, restorePending);
		}
	}
	return {
		version: BTW_STATE_VERSION,
		window: {
			x: finiteNumber(rawWindow.x, base.window.x),
			y: finiteNumber(rawWindow.y, base.window.y),
			width: Math.max(1, finiteNumber(rawWindow.width, base.window.width)),
			height: Math.max(1, finiteNumber(rawWindow.height, base.window.height)),
		},
		windowInitialized: item.windowInitialized === true,
		minimized: item.minimized === true,
		sessions,
	};
}

function read(dataDir: string): BtwPersistedState {
	const key = btwStatePath(dataDir);
	const cached = cache.get(key);
	if (cached) return cached;
	const loaded = normalizeState(readJson<unknown>(key, null), true);
	cache.set(key, loaded);
	return loaded;
}

function write(dataDir: string, state: BtwPersistedState): void {
	const key = btwStatePath(dataDir);
	cache.set(key, state);
	writeJson(key, state);
}

export function readBtwState(dataDir: string, sessionId: string): BtwStateResponse {
	const state = read(dataDir);
	return {
		session: state.sessions[sessionId] ?? defaultSession(),
		window: { ...state.window },
		windowInitialized: state.windowInitialized,
		minimized: state.minimized,
	};
}

export function writeBtwState(dataDir: string, sessionId: string, input: BtwStateResponse): BtwStateResponse {
	const state = read(dataDir);
	const next: BtwPersistedState = {
		...state,
		window: {
			x: finiteNumber(input.window.x, state.window.x),
			y: finiteNumber(input.window.y, state.window.y),
			width: Math.max(1, finiteNumber(input.window.width, state.window.width)),
			height: Math.max(1, finiteNumber(input.window.height, state.window.height)),
		},
		windowInitialized: input.windowInitialized === true,
		minimized: input.minimized === true,
		sessions: {
			...state.sessions,
			[sessionId]: normalizeSession(input.session, false),
		},
	};
	write(dataDir, next);
	return readBtwState(dataDir, sessionId);
}

export function clearSessionBtw(dataDir: string, sessionId: string): void {
	const state = read(dataDir);
	if (!(sessionId in state.sessions)) return;
	const sessions = { ...state.sessions };
	delete sessions[sessionId];
	write(dataDir, { ...state, sessions });
}

export function resetBtwStoreForTests(): void {
	cache = new Map<string, BtwPersistedState>();
}
