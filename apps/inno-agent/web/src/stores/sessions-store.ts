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
import type { PendingQuestion } from "../types/chat.js";
import { workspaceStore } from "./workspace-store.js";
import { workspacesStore } from "./workspaces-store.js";
import { terminalStore } from "./terminal-store.js";

interface SessionsStoreEvents {
	change: void;
}

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
	/** Caches an unanswered question card across session switches so it can be
	 *  restored instantly when switching back, before the backend reconnect
	 *  replay re-delivers the question event. Keyed by session id. */
	private _pendingQuestionCache = new Map<string, NonNullable<typeof chatStore.pendingQuestion>>();
	private _backgroundRunningSessions = new Set<string>();

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
		const prevSessionId = this.currentSessionId;

		// Track background sessions: if the previous session was still streaming,
		// preserve its state so we can resume when switching back.
		if (prevSessionId && prevSessionId !== id) {
			if (chatStore.isSending) {
				this._backgroundRunningSessions.add(prevSessionId);
				this._messageCache.set(prevSessionId, chatStore.messages);
				// Preserve an unanswered question card so it can be restored on return.
				if (chatStore.pendingQuestion) {
					this._pendingQuestionCache.set(prevSessionId, chatStore.pendingQuestion);
				} else {
					this._pendingQuestionCache.delete(prevSessionId);
				}
			} else {
				this._messageCache.delete(prevSessionId);
				this._pendingQuestionCache.delete(prevSessionId);
			}
		}

		this.currentSessionId = id;
		this.openingSessionId = id;
		this.pendingNewSession = false;
		this.emit("change", undefined);

		// Detach from the current stream without stopping the backend task.
		chatStore.detach();
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

			const isBackground = this._backgroundRunningSessions.has(id);
			const cachedMessages = this._messageCache.get(id);

			if (isBackground && cachedMessages && cachedMessages.length > session.messages.length) {
				chatStore.loadHistory(cachedMessages);
			} else {
				this._messageCache.set(id, session.messages);
				chatStore.loadHistory(session.messages);
			}

			void activateSession(id).catch((err) => {
				console.warn(`[sessions] failed to activate ${id}: ${err instanceof Error ? err.message : String(err)}`);
			});

			if (isBackground) {
				this._backgroundRunningSessions.delete(id);
				// Restore the question card before resuming the stream so the UI
				// shows it immediately; the backend reconnect (re-push + replay)
				// reconciles it once events arrive.
				chatStore.restorePendingQuestion(this._pendingQuestionCache.get(id) ?? null);
				void chatStore.resumeStream(id);
			} else {
				this._pendingQuestionCache.delete(id);
				// Non-background session (e.g. opened after a full restart): if the
				// server has a persisted pending question, restore the card.
				if (session.pendingQuestion) {
					chatStore.restorePendingQuestion({
						questionId: session.pendingQuestion.questionId,
						params: session.pendingQuestion.params as PendingQuestion["params"],
					});
				}
			}
		} catch (err) {
			// getSession failed (timeout, network). Fall back to cached messages
			// if available so the UI doesn't get stuck on "loading session…".
			if (requestId === this._openRequestId) {
				const fallback = this._messageCache.get(id);
				if (fallback && fallback.length > 0) {
					chatStore.loadHistory(fallback);
				}
				console.warn(`[sessions] failed to open session ${id}:`, err instanceof Error ? err.message : err);
			}
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
	 * Also detaches from any in-flight chat stream so a stuck/streaming turn
	 * can't keep `chatStore.isSending` true and block the chooser / input.
	 */
	beginNewSession(): void {
		const previousSessionId = this.currentSessionId;
		if (previousSessionId && chatStore.isSending) {
			this._messageCache.set(previousSessionId, chatStore.messages);
			if (chatStore.pendingQuestion) {
				// The card is persisted and will be resumed after an answer. It is
				// no longer a live background stream once a new session is created.
				this._backgroundRunningSessions.delete(previousSessionId);
				this._pendingQuestionCache.set(previousSessionId, chatStore.pendingQuestion);
			} else {
				this._backgroundRunningSessions.add(previousSessionId);
				this._pendingQuestionCache.delete(previousSessionId);
			}
		} else if (previousSessionId) {
			this._messageCache.delete(previousSessionId);
			this._pendingQuestionCache.delete(previousSessionId);
		}
		this.currentSessionId = null;
		this.pendingNewSession = true;
		this.preselectedWorkspaceId = null;
		chatStore.detach();
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
		const previousSessionId = this.currentSessionId;
		if (previousSessionId && chatStore.isSending) {
			this._messageCache.set(previousSessionId, chatStore.messages);
			if (chatStore.pendingQuestion) {
				this._backgroundRunningSessions.delete(previousSessionId);
				this._pendingQuestionCache.set(previousSessionId, chatStore.pendingQuestion);
			} else {
				this._backgroundRunningSessions.add(previousSessionId);
				this._pendingQuestionCache.delete(previousSessionId);
			}
		}
		chatStore.detach();
		void terminalStore.disconnect();
		this.emit("change", undefined);
		try {
			const created = await createSession(input);
			this._messageCache.clear();
			this._pendingQuestionCache.clear();
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
		this._pendingQuestionCache.delete(id);
		this._backgroundRunningSessions.delete(id);
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
