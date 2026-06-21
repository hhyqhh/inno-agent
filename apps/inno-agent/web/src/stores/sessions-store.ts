import { EventEmitter } from "./event-emitter.js";
import {
	activateSession,
	archiveSession as apiArchiveSession,
	createSession,
	deleteSession,
	generateSessionName,
	getSession,
	listSessions,
	unarchiveSession as apiUnarchiveSession,
	updateSessionName,
	type CreateSessionInput,
	type SessionChannel,
	type SessionMeta,
} from "../api/sessions.js";
import { getSessionWorkspace } from "../api/workspaces.js";
import { chatStore } from "./chat-store.js";
import { workspaceStore } from "./workspace-store.js";
import { workspacesStore } from "./workspaces-store.js";
import { terminalStore } from "./terminal-store.js";

interface SessionsStoreEvents {
	change: void;
}

export type DateGroup = "today" | "yesterday" | "thisWeek" | "earlier" | "archived";

export interface SessionGroup {
	key: DateGroup;
	label: string;
	sessions: SessionMeta[];
}

function dateGroupOf(updatedAt: string, archived?: boolean): DateGroup {
	if (archived) return "archived";
	const now = new Date();
	const d = new Date(updatedAt);
	const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const yesterdayStart = new Date(todayStart.getTime() - 86_400_000);
	const weekStart = new Date(todayStart.getTime() - todayStart.getDay() * 86_400_000);

	if (d >= todayStart) return "today";
	if (d >= yesterdayStart) return "yesterday";
	if (d >= weekStart) return "thisWeek";
	return "earlier";
}

const GROUP_LABELS: Record<DateGroup, string> = {
	today: "今天",
	yesterday: "昨天",
	thisWeek: "本周",
	earlier: "更早",
	archived: "已归档",
};

const GROUP_ORDER: DateGroup[] = ["today", "yesterday", "thisWeek", "earlier", "archived"];

class SessionsStoreImpl extends EventEmitter<SessionsStoreEvents> {
	sessions: SessionMeta[] = [];
	currentSessionId: string | null = null;
	isLoading = false;
	openingSessionId: string | null = null;
	channelFilter: SessionChannel | null = null;
	searchQuery = "";
	/** When true, ChatCenter shows the workspace chooser instead of opening a session. */
	pendingNewSession = false;
	/** When set, a new session should be pre-bound to this workspace (set from the sidebar). */
	preselectedWorkspaceId: string | null = null;
	private _openRequestId = 0;
	private _messageCache = new Map<string, Awaited<ReturnType<typeof getSession>>["messages"]>();

	/**
	 * Single source of truth for whether the chat center shows the welcome
	 * screen (new-chat composer + workspace chooser) vs. an open session.
	 *
	 * The previous logic lived inline in ChatCenter and OR-ed together five
	 * conditions split across two stores, which was fragile at transition
	 * boundaries. Centralizing it here makes the "welcome | session" view an
	 * explicit, testable derivation:
	 *   - `pendingNewSession` → the user explicitly asked for a new chat.
	 *   - an open `currentSessionId` → a real session view.
	 *   - otherwise (no session yet) → welcome, unless the chat is mid-flight
	 *     (loading history / streaming a just-created session) so we don't
	 *     flash the welcome screen during the create→open transition.
	 *
	 * Reads chatStore live at call time; ChatCenter subscribes to both stores,
	 * so it re-renders (and re-evaluates this) on either store's change.
	 */
	get isWelcomeView(): boolean {
		if (this.pendingNewSession) return true;
		if (this.currentSessionId) return false;
		return chatStore.messages.length === 0 && !chatStore.isLoadingHistory && !chatStore.isSending;
	}

	get filteredSessions(): SessionMeta[] {
		let list = this.sessions;
		if (this.channelFilter) {
			const ch = this.channelFilter;
			list = list.filter((s) => s.channels.includes(ch));
		}
		if (this.searchQuery) {
			const q = this.searchQuery.toLowerCase();
			list = list.filter(
				(s) => s.name.toLowerCase().includes(q) || s.preview.toLowerCase().includes(q),
			);
		}
		return list;
	}

	get groupedSessions(): SessionGroup[] {
		const groups = new Map<DateGroup, SessionMeta[]>();
		for (const session of this.filteredSessions) {
			const key = dateGroupOf(session.updatedAt, session.archived);
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key)!.push(session);
		}
		return GROUP_ORDER
			.filter((key) => groups.has(key))
			.map((key) => ({
				key,
				label: GROUP_LABELS[key],
				sessions: groups.get(key)!,
			}));
	}

	get availableChannels(): SessionChannel[] {
		const channels = new Set<SessionChannel>();
		for (const s of this.sessions) {
			for (const ch of s.channels) channels.add(ch);
		}
		return Array.from(channels).sort();
	}

	setChannelFilter(channel: SessionChannel | null) {
		this.channelFilter = channel;
		this.emit("change", undefined);
	}

	setSearchQuery(query: string) {
		this.searchQuery = query;
		this.emit("change", undefined);
	}

	async load(): Promise<void> {
		this.isLoading = true;
		this.emit("change", undefined);
		try {
			this.sessions = await listSessions();
		} catch {
			this.sessions = [];
		} finally {
			this.isLoading = false;
			this.emit("change", undefined);
		}
	}

	async refresh(): Promise<void> {
		try {
			this.sessions = await listSessions();
			this.emit("change", undefined);
		} catch {
			// ignore — keep previous list
		}
	}

	selectSession(id: string) {
		this.currentSessionId = id;
		this.emit("change", undefined);
	}

	async openSession(id: string): Promise<void> {
		const requestId = ++this._openRequestId;
		this.currentSessionId = id;
		this.openingSessionId = id;
		this.pendingNewSession = false;
		this.emit("change", undefined);

		// Abort any in-flight chat stream tied to the previous session so its
		// events can't leak into this one (and keep isSending=true forever).
		chatStore.cancel();
		// Drop any terminal bound to the previous session.
		void terminalStore.disconnect();

		const cached = this._messageCache.get(id);
		if (cached) {
			chatStore.loadHistory(cached);
		} else {
			chatStore.loadHistory([]);
			chatStore.setLoadingHistory(true);
		}

		// Sync workspace binding for this session (fire and forget; UI updates via store).
		void getSessionWorkspace(id)
			.then((info) => {
				if (this.currentSessionId === id) {
					void workspaceStore.setActiveWorkspace(info.workspaceId || null);
				}
			})
			.catch((err) => {
				console.warn(`[sessions] failed to load workspace for ${id}:`, err instanceof Error ? err.message : err);
			});

		try {
			const session = await getSession(id);
			if (requestId !== this._openRequestId) return;
			this._messageCache.set(id, session.messages);
			chatStore.loadHistory(session.messages);

			void activateSession(id).catch((err) => {
				console.warn(`[sessions] failed to activate ${id}: ${err instanceof Error ? err.message : String(err)}`);
			});
		} finally {
			if (requestId === this._openRequestId) {
				this.openingSessionId = null;
				chatStore.setLoadingHistory(false);
				this.emit("change", undefined);
			}
		}
	}

	/**
	 * Enter "new session" mode without yet creating a backend session.
	 * The actual session is created when the user chooses a workspace.
	 *
	 * Also aborts any in-flight chat stream so a stuck/streaming turn can't
	 * keep `chatStore.isSending` true and block the chooser / input.
	 */
	beginNewSession(): void {
		this.currentSessionId = null;
		this.pendingNewSession = true;
		this.preselectedWorkspaceId = null;
		chatStore.cancel();
		chatStore.clear();
		void terminalStore.disconnect();
		this.emit("change", undefined);
	}

	/**
	 * Enter "new session" mode pre-bound to a specific workspace (from the
	 * sidebar). ChatCenter's chooser reads `preselectedWorkspaceId` to default to
	 * that workspace and previews it immediately.
	 */
	beginNewSessionIn(workspaceId: string): void {
		this.beginNewSession();
		this.preselectedWorkspaceId = workspaceId;
		this.emit("change", undefined);
	}

	cancelPendingNewSession(): void {
		this.pendingNewSession = false;
		this.preselectedWorkspaceId = null;
		this.emit("change", undefined);
	}

	/**
	 * Create a session bound to a specific workspace (or new workspace), then open it.
	 */
	async createSessionWith(input: CreateSessionInput = {}): Promise<void> {
		this.isLoading = true;
		this.pendingNewSession = false;
		this.preselectedWorkspaceId = null;
		// Make sure no previous stream / terminal lingers.
		chatStore.cancel();
		void terminalStore.disconnect();
		this.emit("change", undefined);
		try {
			const created = await createSession(input);
			this._messageCache.clear();
			chatStore.clear();
			// Refresh side panels so the new workspace shows up.
			void workspacesStore.load();
			await this.load();
			this.currentSessionId = created.id;
			if (created.workspaceId) {
				void workspaceStore.setActiveWorkspace(created.workspaceId);
			}
			this.emit("change", undefined);
		} finally {
			this.isLoading = false;
			this.emit("change", undefined);
		}
	}

	async clearSelection() {
		// Show the workspace chooser; do not create the backend session yet.
		this.beginNewSession();
	}

	async renameSession(id: string, name: string, generated = false): Promise<void> {
		const updated = await updateSessionName(id, name, generated);
		this.sessions = this.sessions.map((session) => session.id === id ? updated : session);
		this.emit("change", undefined);
	}

	async generateSessionName(id: string): Promise<void> {
		const updated = await generateSessionName(id);
		this.sessions = this.sessions.map((session) => session.id === id ? updated : session);
		this.emit("change", undefined);
	}

	async archiveSession(id: string): Promise<void> {
		await apiArchiveSession(id);
		this.sessions = this.sessions.map((s) => s.id === id ? { ...s, archived: true } : s);
		this.emit("change", undefined);
	}

	async unarchiveSession(id: string): Promise<void> {
		await apiUnarchiveSession(id);
		this.sessions = this.sessions.map((s) => s.id === id ? { ...s, archived: false } : s);
		this.emit("change", undefined);
	}

	async deleteSession(id: string): Promise<void> {
		const result = await deleteSession(id);
		this._messageCache.delete(id);
		this.sessions = this.sessions.filter((session) => session.id !== id);
		if (this.currentSessionId === id) {
			this.currentSessionId = result.newActiveId;
			chatStore.clear();
		}
		this.emit("change", undefined);
		if (result.newActiveId) {
			void this.refresh();
		}
	}
}

export const sessionsStore = new SessionsStoreImpl();
