import { EventEmitter } from "./event-emitter.js";
import { askBtw, bringBackBtw, getBtwState, saveBtwState } from "../api/btw.js";
import type {
	BtwExchange,
	BtwSessionState,
	BtwStateResponse,
	BtwTabState,
	BtwThreadTurn,
	BtwWindowGeometry,
} from "../types/btw.js";
import { BTW_DEFAULT_HEIGHT, BTW_DEFAULT_WIDTH } from "../utils/btw-window.js";

interface BtwStoreEvents {
	change: void;
}

const INTERRUPTED_ERROR = "回答在应用关闭时中断，请重试";
const EMPTY_SESSION: BtwSessionState = { nextTabNumber: 1, activeTabId: null, tabs: [] };
let nextId = 1;

function createId(prefix: string): string {
	try {
		if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
			return `${prefix}-${crypto.randomUUID()}`;
		}
	} catch {
		// Fall back for older webviews and test environments without crypto.randomUUID.
	}
	return `${prefix}-${Date.now()}-${nextId++}`;
}

function defaultWindowGeometry(): BtwWindowGeometry {
	return { x: 0, y: 0, width: BTW_DEFAULT_WIDTH, height: BTW_DEFAULT_HEIGHT };
}

function cloneExchange(exchange: BtwExchange): BtwExchange {
	return { ...exchange };
}

function cloneTab(tab: BtwTabState): BtwTabState {
	return { ...tab, exchanges: tab.exchanges.map(cloneExchange) };
}

function cloneSession(session: BtwSessionState): BtwSessionState {
	return { ...session, tabs: session.tabs.map(cloneTab) };
}

function normalizeSession(raw: BtwSessionState | undefined): BtwSessionState {
	if (!raw || !Array.isArray(raw.tabs)) return cloneSession(EMPTY_SESSION);
	const tabs = raw.tabs
		.filter((tab) => Boolean(tab) && typeof tab.id === "string" && tab.id.length > 0)
		.map((tab) => ({
			...cloneTab(tab),
			number: Math.max(1, Math.floor(Number(tab.number) || 1)),
			draft: typeof tab.draft === "string" ? tab.draft : "",
			scrollTop: Math.max(0, Number.isFinite(tab.scrollTop) ? tab.scrollTop : 0),
				exchanges: tab.exchanges
					.filter((exchange) => Boolean(exchange) && typeof exchange.id === "string")
					.map((exchange) => exchange.status === "pending"
						? { ...cloneExchange(exchange), status: "error" as const, error: INTERRUPTED_ERROR }
						: cloneExchange(exchange)),
		}));
	const maxNumber = tabs.reduce((max, tab) => Math.max(max, tab.number), 0);
	const activeTabId = tabs.some((tab) => tab.id === raw.activeTabId) ? raw.activeTabId : (tabs[0]?.id ?? null);
	return {
		nextTabNumber: Math.max(1, Math.floor(Number(raw.nextTabNumber) || 1), maxNumber + 1),
		activeTabId,
		tabs,
	};
}

function asThread(tab: BtwTabState): BtwThreadTurn[] {
	return tab.exchanges
		.filter((exchange) => exchange.status === "done")
		.map((exchange) => ({ question: exchange.question, answer: exchange.answer }));
}

export class BtwStoreImpl extends EventEmitter<BtwStoreEvents> {
	private sessions = new Map<string, BtwSessionState>();
	private hydratedSessions = new Set<string>();
	private hydrationRequests = new Map<string, Promise<void>>();
	private persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private persistQueue: Promise<void> = Promise.resolve();
	private requestControllers = new Map<string, AbortController>();
	private bootInitialized = false;

	panelOpen = false;
	minimized = false;
	windowGeometry = defaultWindowGeometry();
	windowInitialized = false;
	activeSessionId: string | null = null;

	get isVisible(): boolean {
		return this.panelOpen && !this.minimized && Boolean(this.activeTabFor(this.activeSessionId));
	}

	get draft(): string {
		const tab = this.activeTabFor(this.activeSessionId);
		return tab?.draft ?? "";
	}

	sessionFor(sessionId: string | null | undefined): BtwSessionState {
		if (!sessionId) return EMPTY_SESSION;
		return this.sessions.get(sessionId) ?? EMPTY_SESSION;
	}

	tabsFor(sessionId: string | null | undefined): BtwTabState[] {
		return this.sessionFor(sessionId).tabs;
	}

	activeTabFor(sessionId: string | null | undefined): BtwTabState | null {
		const session = this.sessionFor(sessionId);
		return session.tabs.find((tab) => tab.id === session.activeTabId) ?? null;
	}

	tabFor(sessionId: string | null | undefined, tabId: string | null | undefined): BtwTabState | null {
		if (!sessionId || !tabId) return null;
		return this.sessionFor(sessionId).tabs.find((tab) => tab.id === tabId) ?? null;
	}

	/** Backwards-compatible view of the active tab's exchange list. */
	threadFor(sessionId: string | null | undefined): BtwExchange[] {
		return this.activeTabFor(sessionId)?.exchanges ?? [];
	}

	async setMainSession(sessionId: string | null): Promise<void> {
		if (!sessionId) return;
		this.activeSessionId = sessionId;
		await this.hydrateSession(sessionId);
		if (this.activeSessionId !== sessionId) return;
		this.emit("change", undefined);
	}

	async hydrateSession(sessionId: string): Promise<void> {
		if (!sessionId || this.hydratedSessions.has(sessionId)) return;
		const existing = this.hydrationRequests.get(sessionId);
		if (existing) return existing;

		const request = (async () => {
			if (!this.bootInitialized) {
				this.bootInitialized = true;
				// Persisted tabs are restored silently; the learner explicitly restores
				// the window with the main composer button.
				this.panelOpen = false;
				this.minimized = true;
			}
			try {
				const remote = await getBtwState(sessionId);
				this.sessions.set(sessionId, normalizeSession(remote.session));
				if (remote.windowInitialized && !this.windowInitialized) {
					this.windowGeometry = { ...remote.window };
					this.windowInitialized = true;
				}
			} catch {
				// The state endpoint is best-effort: an unavailable sidecar must not
				// prevent the learner from opening a fresh side-question tab.
				this.sessions.set(sessionId, cloneSession(EMPTY_SESSION));
			}
			this.hydratedSessions.add(sessionId);
			this.hydrationRequests.delete(sessionId);
			this.emit("change", undefined);
		})().catch((err) => {
			this.hydrationRequests.delete(sessionId);
			throw err;
		});
		this.hydrationRequests.set(sessionId, request);
		return request;
	}

	async openOrRestore(sessionId: string | null): Promise<void> {
		if (!sessionId) return;
		this.activeSessionId = sessionId;
		await this.hydrateSession(sessionId);
		if (this.activeSessionId !== sessionId) return;
		if (this.tabsFor(sessionId).length === 0) this.createTab(sessionId);
		this.panelOpen = true;
		this.minimized = false;
		this.emit("change", undefined);
		this.schedulePersist(sessionId, 0);
	}

	/** Retained for callers that used the old open/close toggle. */
	togglePanel(open?: boolean, sessionId?: string | null): void {
		if (open === false) {
			this.panelOpen = false;
			this.minimized = false;
			this.emit("change", undefined);
			return;
		}
		if (open === true || !this.isVisible) {
			void this.openOrRestore(sessionId ?? this.activeSessionId);
			return;
		}
		this.minimizePanel();
	}

	createTab(sessionId: string): string | null {
		if (!sessionId) return null;
		const current = cloneSession(this.sessionFor(sessionId));
		const tab: BtwTabState = {
			id: createId("btw-tab"),
			number: current.nextTabNumber,
			draft: "",
			scrollTop: 0,
			exchanges: [],
		};
		current.nextTabNumber += 1;
		current.tabs.push(tab);
		current.activeTabId = tab.id;
		this.sessions.set(sessionId, current);
		this.activeSessionId = sessionId;
		this.panelOpen = true;
		this.minimized = false;
		this.emit("change", undefined);
		this.schedulePersist(sessionId, 0);
		return tab.id;
	}

	selectTab(sessionId: string, tabId: string): void {
		const current = this.sessions.get(sessionId);
		if (!current || !current.tabs.some((tab) => tab.id === tabId)) return;
		if (current.activeTabId === tabId) return;
		this.sessions.set(sessionId, { ...current, activeTabId: tabId });
		this.activeSessionId = sessionId;
		this.emit("change", undefined);
		this.schedulePersist(sessionId);
	}

	setDraft(sessionId: string, tabId: string, text: string): void {
		this.updateTab(sessionId, tabId, (tab) => ({ ...tab, draft: text }));
	}

	setScrollTop(sessionId: string, tabId: string, scrollTop: number): void {
		this.updateTab(sessionId, tabId, (tab) => ({ ...tab, scrollTop: Math.max(0, scrollTop) }), false);
	}

	setWindowGeometry(geometry: BtwWindowGeometry): void {
		this.windowGeometry = { ...geometry };
		this.windowInitialized = true;
		this.emit("change", undefined);
		this.schedulePersist(this.activeSessionId);
	}

	minimizePanel(): void {
		this.panelOpen = true;
		this.minimized = true;
		this.emit("change", undefined);
		this.flushPersistence();
	}

	async ask(sessionId: string, tabIdOrQuestion: string, maybeQuestion?: string): Promise<void> {
		const tabId = maybeQuestion ? tabIdOrQuestion : this.activeTabFor(sessionId)?.id ?? this.createTab(sessionId);
		if (!tabId) return;
		const question = maybeQuestion ?? tabIdOrQuestion;
		const trimmed = question.trim();
		const tab = this.tabFor(sessionId, tabId);
		if (!sessionId || !tab || !trimmed || tab.exchanges.some((exchange) => exchange.status === "pending")) return;

		const exchange: BtwExchange = {
			id: createId("btw-exchange"),
			question: trimmed,
			answer: "",
			status: "pending",
		};
		this.updateTab(sessionId, tabId, (current) => ({
			...current,
			draft: "",
			exchanges: [...current.exchanges, exchange],
		}));
		this.activeSessionId = sessionId;
		this.panelOpen = true;
		this.minimized = false;
		this.emit("change", undefined);

		const controller = new AbortController();
		this.requestControllers.set(exchange.id, controller);
		try {
			const answer = await askBtw(sessionId, trimmed, asThread(tab), controller.signal);
			if (controller.signal.aborted || !this.exchangeFor(sessionId, tabId, exchange.id)) return;
			this.updateExchange(sessionId, tabId, exchange.id, { status: "done", answer });
		} catch (err) {
			if (controller.signal.aborted || !this.exchangeFor(sessionId, tabId, exchange.id)) return;
			this.updateExchange(sessionId, tabId, exchange.id, {
				status: "error",
				error: err instanceof Error ? err.message : "Request failed",
			});
		} finally {
			this.requestControllers.delete(exchange.id);
		}
	}

	async retry(sessionId: string, tabIdOrExchangeId: string, maybeExchangeId?: string): Promise<void> {
		const tabId = maybeExchangeId ? tabIdOrExchangeId : this.activeTabFor(sessionId)?.id;
		const exchangeId = maybeExchangeId ?? tabIdOrExchangeId;
		if (!tabId) return;
		const exchange = this.exchangeFor(sessionId, tabId, exchangeId);
		if (!exchange || exchange.status !== "error") return;
		const tab = this.tabFor(sessionId, tabId);
		if (!tab) return;
		this.updateExchange(sessionId, tabId, exchangeId, { status: "pending", error: undefined });
		const controller = new AbortController();
		this.requestControllers.set(exchangeId, controller);
		try {
			const retryHistory = tab.exchanges
				.filter((item) => item.status === "done" && item.id !== exchangeId)
				.map((item) => ({ question: item.question, answer: item.answer }));
			const answer = await askBtw(sessionId, exchange.question, retryHistory, controller.signal);
			if (controller.signal.aborted || !this.exchangeFor(sessionId, tabId, exchangeId)) return;
			this.updateExchange(sessionId, tabId, exchangeId, { status: "done", answer });
		} catch (err) {
			if (controller.signal.aborted || !this.exchangeFor(sessionId, tabId, exchangeId)) return;
			this.updateExchange(sessionId, tabId, exchangeId, {
				status: "error",
				error: err instanceof Error ? err.message : "Request failed",
			});
		} finally {
			this.requestControllers.delete(exchangeId);
		}
	}

	async bringBack(sessionId: string, tabIdOrExchangeId: string, maybeExchangeId?: string): Promise<void> {
		const tabId = maybeExchangeId ? tabIdOrExchangeId : this.activeTabFor(sessionId)?.id;
		const exchangeId = maybeExchangeId ?? tabIdOrExchangeId;
		if (!tabId) return;
		const exchange = this.exchangeFor(sessionId, tabId, exchangeId);
		if (!exchange || exchange.status !== "done" || exchange.broughtBack) return;
		await bringBackBtw(sessionId, exchange.question, exchange.answer);
		this.updateExchange(sessionId, tabId, exchangeId, { broughtBack: true });
	}

	closeTab(sessionId: string, tabId: string): void {
		const current = this.sessions.get(sessionId);
		if (!current) return;
		const index = current.tabs.findIndex((tab) => tab.id === tabId);
		if (index < 0) return;
		const tab = current.tabs[index];
		for (const exchange of tab.exchanges) this.requestControllers.get(exchange.id)?.abort();
		const tabs = current.tabs.filter((tabItem) => tabItem.id !== tabId);
		const nextActive = tabs.length === 0
			? null
			: (current.activeTabId === tabId
				? (tabs[index]?.id ?? tabs[index - 1]?.id ?? tabs[0].id)
				: current.activeTabId);
		this.sessions.set(sessionId, { ...current, tabs, activeTabId: nextActive });
		if (tabs.length === 0) {
			this.panelOpen = false;
			this.minimized = false;
		}
		this.emit("change", undefined);
		this.flushPersistence(sessionId);
	}

	clearThread(sessionId: string): void {
		const current = this.sessions.get(sessionId);
		if (!current) return;
		for (const tab of current.tabs) {
			for (const exchange of tab.exchanges) this.requestControllers.get(exchange.id)?.abort();
		}
		this.sessions.delete(sessionId);
		this.emit("change", undefined);
		this.flushPersistence(sessionId);
	}

	private exchangeFor(sessionId: string, tabId: string, exchangeId: string): BtwExchange | null {
		return this.tabFor(sessionId, tabId)?.exchanges.find((exchange) => exchange.id === exchangeId) ?? null;
	}

	private updateExchange(sessionId: string, tabId: string, exchangeId: string, patch: Partial<BtwExchange>): void {
		this.updateTab(sessionId, tabId, (tab) => ({
			...tab,
			exchanges: tab.exchanges.map((exchange) => exchange.id === exchangeId ? { ...exchange, ...patch } : exchange),
		}));
	}

	private updateTab(
		sessionId: string,
		tabId: string,
		update: (tab: BtwTabState) => BtwTabState,
		emit = true,
	): void {
		const current = this.sessions.get(sessionId);
		if (!current) return;
		const index = current.tabs.findIndex((tab) => tab.id === tabId);
		if (index < 0) return;
		const tabs = current.tabs.map((tab, tabIndex) => tabIndex === index ? update(cloneTab(tab)) : tab);
		this.sessions.set(sessionId, { ...current, tabs });
		if (emit) this.emit("change", undefined);
		this.schedulePersist(sessionId);
	}

	private schedulePersist(sessionId: string | null, delay = 180): void {
		if (!sessionId || !this.sessions.has(sessionId)) return;
		const previous = this.persistTimers.get(sessionId);
		if (previous) clearTimeout(previous);
		const timer = setTimeout(() => {
			this.persistTimers.delete(sessionId);
			this.persistNow(sessionId);
		}, delay);
		this.persistTimers.set(sessionId, timer);
	}

	flushPersistence(sessionId = this.activeSessionId): void {
		if (!sessionId) return;
		const timer = this.persistTimers.get(sessionId);
		if (timer) clearTimeout(timer);
		this.persistTimers.delete(sessionId);
		this.persistNow(sessionId);
	}

	private persistNow(sessionId: string): void {
		const payload: BtwStateResponse = {
			session: cloneSession(this.sessionFor(sessionId)),
			window: { ...this.windowGeometry },
			windowInitialized: this.windowInitialized,
			minimized: this.minimized,
		};
		this.persistQueue = this.persistQueue
			.catch(() => undefined)
			.then(() => saveBtwState(sessionId, payload))
			.then(() => undefined)
			.catch(() => undefined);
	}
}

export const btwStore = new BtwStoreImpl();
