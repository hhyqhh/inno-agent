import { html, LitElement } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { appStore } from "../../stores/app-store.js";
import { chatStore } from "../../stores/chat-store.js";
import { sessionsStore } from "../../stores/sessions-store.js";
import type { SessionChannel, SessionMeta } from "../../api/sessions.js";

@customElement("inno-session-sidebar")
export class SessionSidebar extends LitElement {
	@property({ type: Boolean }) collapsed = false;
	@state() private _sessions: SessionMeta[] = [];
	@state() private _currentSessionId: string | null = null;
	@state() private _isLoadingSessions = false;
	private _unsub?: () => void;
	private _sessionsUnsub?: () => void;

	protected override createRenderRoot() {
		return this;
	}

	override connectedCallback() {
		super.connectedCallback();
		this._unsub = appStore.on("change", () => {
			this.requestUpdate();
		});
		this._sessionsUnsub = sessionsStore.on("change", () => {
			this._sessions = sessionsStore.sessions;
			this._currentSessionId = sessionsStore.currentSessionId;
			this._isLoadingSessions = sessionsStore.isLoading;
			this.requestUpdate();
		});
		sessionsStore.load();
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		this._unsub?.();
		this._sessionsUnsub?.();
	}

	private _formatTime(iso: string): string {
		try {
			return new Date(iso).toLocaleString("zh-CN", {
				month: "short",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
			});
		} catch {
			return iso;
		}
	}

	private _newChat() {
		void (async () => {
			await sessionsStore.clearSelection();
			chatStore.clear();
			appStore.setRightPanelTab("preview");
		})();
	}

	private _channelLabel(channel: SessionChannel): string {
		const labels: Record<SessionChannel, string> = {
			cli: "CLI",
			web: "Web",
			feishu: "Feishu",
			qq: "QQ",
			wechat: "WeChat",
			scheduler: "Job",
			unknown: "Unknown",
		};
		return labels[channel] ?? channel;
	}

	private _channelClass(channel: SessionChannel): string {
		const classes: Record<SessionChannel, string> = {
			cli: "bg-blue-50 text-blue-700 ring-1 ring-blue-100",
			web: "bg-white/70 text-slate-700 ring-1 ring-slate-200",
			feishu: "bg-green-50 text-green-700 ring-1 ring-green-100",
			qq: "bg-cyan-50 text-cyan-700 ring-1 ring-cyan-100",
			wechat: "bg-lime-50 text-lime-700 ring-1 ring-lime-100",
			scheduler: "bg-amber-50 text-amber-700 ring-1 ring-amber-100",
			unknown: "bg-white/60 text-slate-500 ring-1 ring-slate-200",
		};
		return classes[channel] ?? classes.unknown;
	}

	private _renderSession(session: SessionMeta) {
		const active = this._currentSessionId === session.id;
		return html`
			<button
				class="w-full text-left rounded-md px-2.5 py-2.5 mb-1.5 transition-colors border
					${active
						? "bg-[var(--inno-sidebar-active)] text-slate-950 border-black/5"
						: "border-transparent text-slate-700 hover:bg-black/[0.055] hover:text-slate-950"}"
				@click=${() => {
					appStore.setRightPanelTab("preview");
					sessionsStore.openSession(session.id);
				}}
			>
				<div class="flex items-start justify-between gap-2">
					<div class="text-sm font-medium leading-snug line-clamp-2">${session.name}</div>
					<div class="text-[10px] text-slate-500 shrink-0">${this._formatTime(session.updatedAt)}</div>
				</div>
				${session.preview && session.preview !== session.name
					? html`<div class="mt-1 text-xs text-slate-500 line-clamp-2">${session.preview}</div>`
					: ""}
				<div class="flex items-center justify-between gap-2 mt-2">
					<div class="flex items-center gap-1 flex-wrap">
						${session.channels.map((channel) => html`
							<span class="px-1.5 py-0.5 rounded text-[10px] font-medium ${this._channelClass(channel)}">
								${this._channelLabel(channel)}
							</span>
						`)}
					</div>
					<span class="text-[11px] text-slate-500">${session.messageCount}</span>
				</div>
			</button>
		`;
	}

	private _renderCollapsedSession(session: SessionMeta) {
		const active = this._currentSessionId === session.id;
		const channel = session.channels[0] ?? "unknown";
		return html`
			<button
				class="relative mx-auto mb-2 flex h-9 w-9 items-center justify-center rounded-md border text-[11px] font-medium transition-colors
					${active ? "border-black/5 bg-[var(--inno-sidebar-active)] text-slate-950" : "border-black/10 bg-white/70 text-slate-600 hover:bg-black/[0.055] hover:text-slate-950"}"
				title="${session.name} · ${this._channelLabel(channel)}"
				@click=${() => {
					appStore.setRightPanelTab("preview");
					sessionsStore.openSession(session.id);
				}}
			>
				${this._channelLabel(channel).slice(0, 1)}
				<span class="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full ${this._channelClass(channel)}"></span>
			</button>
		`;
	}

	override render() {
		if (this.collapsed) {
			return html`
				<div class="flex h-full flex-col items-center border-r border-black/10 bg-[var(--inno-sidebar-bg)] py-2">
					<button
						class="mb-2 flex h-9 w-9 items-center justify-center rounded-md bg-slate-900 text-white text-lg hover:bg-slate-800"
						title="New chat"
						@click=${() => this._newChat()}
					>
						+
					</button>
					<button
						class="mb-2 flex h-9 w-9 items-center justify-center rounded-md border border-black/10 bg-white/70 text-sm text-slate-600 hover:bg-black/[0.055] hover:text-slate-950"
						title="Expand sessions"
						@click=${() => appStore.setSidebarCollapsed(false)}
					>
						&gt;
					</button>
					<div class="w-full flex-1 min-h-0 overflow-y-auto px-1">
						${this._sessions.slice(0, 24).map((session) => this._renderCollapsedSession(session))}
					</div>
				</div>
			`;
		}

		return html`
			<!-- Logo / Header -->
			<div class="border-b border-black/10 px-3 py-3">
				<div class="flex items-start justify-between gap-3">
					<div class="min-w-0">
						<div class="mb-3 flex items-center gap-1.5" aria-hidden="true">
							<span class="h-3 w-3 rounded-full bg-[#ff5f57] ring-1 ring-black/10"></span>
							<span class="h-3 w-3 rounded-full bg-[#febc2e] ring-1 ring-black/10"></span>
							<span class="h-3 w-3 rounded-full bg-[#28c840] ring-1 ring-black/10"></span>
						</div>
						<h1 class="text-base font-semibold tracking-tight text-slate-950">Inno Agent</h1>
						<p class="text-xs text-slate-500 mt-0.5">Personal Learning Workstation</p>
					</div>
					<button
						class="h-8 w-8 shrink-0 rounded-md border border-black/10 bg-white/70 text-sm text-slate-500 hover:bg-black/[0.055] hover:text-slate-950"
						title="Collapse sessions"
						@click=${() => appStore.setSidebarCollapsed(true)}
					>
						&lt;
					</button>
				</div>
			</div>

			<!-- Sessions -->
			<div class="flex-1 min-h-0">
				<div class="flex items-center justify-between px-3 py-2">
					<h2 class="text-xs font-medium uppercase tracking-wide text-slate-500">Chat Sessions</h2>
					<div class="flex items-center gap-2">
						<button
							class="rounded-md bg-slate-900 px-2 py-1 text-xs font-medium text-white hover:bg-slate-800"
							title="New chat"
							@click=${() => this._newChat()}
						>
							New
						</button>
						<button
							class="text-xs text-slate-500 hover:text-slate-950"
							title="Refresh sessions"
							@click=${() => sessionsStore.load()}
						>
							Refresh
						</button>
					</div>
				</div>
				<div class="overflow-y-auto px-2 pb-2 h-[calc(100%-34px)]">
					${this._isLoadingSessions
						? html`<div class="px-2 py-3 text-xs text-slate-500">Loading...</div>`
						: this._sessions.length === 0
							? html`<div class="px-2 py-3 text-xs text-slate-500">No saved sessions</div>`
							: this._sessions.map((session) => this._renderSession(session))}
				</div>
			</div>

			<!-- New chat button -->
			<div class="p-2 border-t border-black/10">
				<button
					class="flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm w-full
						bg-slate-900 text-white hover:bg-slate-800 transition-colors"
					@click=${() => this._newChat()}
				>
					+ New Chat
				</button>
			</div>
		`;
	}
}
