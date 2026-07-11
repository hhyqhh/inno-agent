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
	@state() private _cardExpanded = false;
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
			cli: "bg-[var(--inno-accent-soft)] text-[var(--inno-accent)] ring-1 ring-blue-100",
			web: "bg-white/70 text-[var(--inno-text)] ring-1 ring-slate-200",
			feishu: "bg-green-50 text-green-700 ring-1 ring-green-100",
			qq: "bg-cyan-50 text-cyan-700 ring-1 ring-cyan-100",
			wechat: "bg-lime-50 text-lime-700 ring-1 ring-lime-100",
			scheduler: "bg-amber-50 text-amber-700 ring-1 ring-amber-100",
			unknown: "bg-white/60 text-[var(--inno-text-muted)] ring-1 ring-slate-200",
		};
		return classes[channel] ?? classes.unknown;
	}

	private _renderSession(session: SessionMeta) {
		const active = this._currentSessionId === session.id;
		return html`
			<button
				class="w-full text-left rounded-md px-2.5 py-2.5 mb-1.5 transition-colors border
					${active
						? "bg-[var(--inno-sidebar-active)] text-[var(--inno-text)] border-black/5"
						: "border-transparent text-[var(--inno-text)] hover:bg-black/[0.055] hover:text-[var(--inno-text)]"}"
				@click=${() => {
					appStore.setRightPanelTab("preview");
					sessionsStore.openSession(session.id);
				}}
			>
				<div class="flex items-start justify-between gap-2">
					<div class="text-sm font-medium leading-snug line-clamp-2">${session.name}</div>
					<div class="text-[10px] text-[var(--inno-text-muted)] shrink-0">${this._formatTime(session.updatedAt)}</div>
				</div>
				${session.preview && session.preview !== session.name
					? html`<div class="mt-1 text-xs text-[var(--inno-text-muted)] line-clamp-2">${session.preview}</div>`
					: ""}
				<div class="flex items-center justify-between gap-2 mt-2">
					<div class="flex items-center gap-1 flex-wrap">
						${session.channels.map((channel) => html`
							<span class="px-1.5 py-0.5 rounded text-[10px] font-medium ${this._channelClass(channel)}">
								${this._channelLabel(channel)}
							</span>
						`)}
					</div>
					<span class="text-[11px] text-[var(--inno-text-muted)]">${session.messageCount}</span>
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
					${active ? "border-black/5 bg-[var(--inno-sidebar-active)] text-[var(--inno-text)]" : "border-black/10 bg-white/70 text-[var(--inno-text-muted)] hover:bg-black/[0.055] hover:text-[var(--inno-text)]"}"
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
						class="mb-2 flex h-9 w-9 items-center justify-center rounded-md inno-primary-button text-white text-lg"
						title="New chat"
						@click=${() => this._newChat()}
					>
						+
					</button>
					<button
						class="mb-2 flex h-9 w-9 items-center justify-center rounded-md border border-black/10 bg-white/70 text-sm text-[var(--inno-text-muted)] hover:bg-black/[0.055] hover:text-[var(--inno-text)]"
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
						<div class="flex items-center gap-2">
							<svg xmlns="http://www.w3.org/2000/svg" fill="none" width="28" height="28" viewBox="0 0 30 30" class="shrink-0">
								<defs>
									<linearGradient id="lgs1" x1="0.813" y1="1" x2="0.405" y2="0.11"><stop offset="0%" stop-color="#5376FF"/><stop offset="37.86%" stop-color="#7D49FF"/><stop offset="68.57%" stop-color="#E15FF8"/><stop offset="99.29%" stop-color="#4C88FF"/></linearGradient>
									<linearGradient id="lgs2" x1="0.813" y1="1" x2="0.468" y2="0.081"><stop offset="0%" stop-color="#5376FF"/><stop offset="37.86%" stop-color="#7D49FF"/><stop offset="68.57%" stop-color="#E15FF8"/><stop offset="99.29%" stop-color="#4C88FF"/></linearGradient>
									<linearGradient id="lgs3" x1="0.813" y1="1" x2="0.617" y2="0.052"><stop offset="0%" stop-color="#5376FF"/><stop offset="37.86%" stop-color="#7D49FF"/><stop offset="68.57%" stop-color="#E15FF8"/><stop offset="99.29%" stop-color="#4C88FF"/></linearGradient>
								</defs>
								<path d="M5.56924,25.7018C6.65013,26.7281,7.73965,27.3991,8.83779,27.6855C11.5746,28.3991,13.7173,28.1092,15.462,27.233C17.1071,26.4069,18.2102,24.0374,18.4285,22.3264C18.4417,22.2228,18.4516,22.1216,18.4583,22.0233C18.5571,20.5632,18.4446,19.9426,18.2861,19.0683C18.2577,18.9118,18.2279,18.7471,18.1975,18.5681C18.1323,19.9327,17.8209,21.0452,17.2635,21.9056C16.7814,22.6495,16.1154,23.205,15.2653,23.5719C12.5155,24.759,9.23424,24.1597,7.13172,23.2078C5.8972,22.6488,4.72125,21.6247,3.88512,20.3527C3.29723,19.4583,2.87734,18.4414,2.72319,17.3773C2.39643,15.1219,2.56366,14.0611,2.6787,13.3313C2.69512,13.2272,2.71048,13.1298,2.72318,13.0366C2.2484,14.427,1.87663,17.273,2.38998,19.5348C2.49556,20,2.63213,20.4395,2.79613,20.8535C2.80649,20.8797,2.81696,20.9057,2.82754,20.9317C3.11983,21.6486,3.49504,22.2874,3.93434,22.8482C4.45112,23.5079,5.05659,24.0595,5.7201,24.5032C4.83592,24.2859,4.07445,23.8541,3.43568,23.2078C4.01385,24.0096,4.59456,24.7133,5.17778,25.3143C5.30814,25.4486,5.43863,25.5778,5.56924,25.7018ZM11.43,26.8775Q13.3558,26.9479,14.9235,26.1607Q15.8056,25.7176,16.5097,24.3847Q16.5506,24.3072,16.5893,24.2301Q16.193,24.4785,15.7409,24.6737Q13.5582,25.6159,10.8548,25.3877Q9.71294,25.2914,8.63644,25.0096L11.43,26.8775Z" fill="url(#lgs1)"/>
								<path d="M14.7953,3.71075C16.0925,3.53303,17.2132,3.41752,18.168,3.1639C18.9509,2.95591,19.6223,2.65504,20.1876,2.1508C20.1876,2.33039,20.1452,2.52102,20.0676,2.71429C19.8622,3.22557,19.4099,3.75527,18.8423,4.14758C18.7331,4.22304,18.6197,4.29341,18.5029,4.3576C19.5257,4.06209,20.2725,3.92063,20.9669,3.71908C21.3437,3.60974,21.705,3.48271,22.0867,3.3038C22.7712,2.98291,23.6435,2.40303,24.3823,1.67971C24.8146,1.25642,25.2013,0.784011,25.4779,0.285645C25.5744,0.970676,25.6014,1.61597,25.5703,2.2234C25.4349,4.86472,24.2003,6.79004,22.7988,8.15321C21.075,9.82986,17.0292,9.59022,14.7953,10.0184C12.5615,10.4465,9.40362,13.3417,9.03059,16.2242C8.74363,18.4417,8.9115,20.1575,10.26,21.6648C10.6644,22.1169,11.175,22.5502,11.8114,22.9727C11.0297,22.9727,10.3028,22.8892,9.6321,22.7407C7.07283,22.1743,5.33143,20.663,4.48639,19.2424C2.88664,16.5531,2.65515,11.4741,5.13072,8.15321C7.60629,4.83236,11.254,4.19594,14.7953,3.71075ZM14.9582,4.89964Q14.9998,4.89394,15.0478,4.88744L8.46142,8.50781L18.836,5.51045Q19.3682,5.35668,20.2478,5.14337Q21.7848,4.77059,22.596,4.39036Q23.4703,3.98054,24.1934,3.46161Q23.706,5.59681,21.9621,7.293Q21.0282,8.20139,16.9073,8.56322Q15.2563,8.70818,14.5695,8.83982Q12.4273,9.25037,10.3583,11.3608Q8.15977,13.6033,7.84052,16.0702Q7.50099,18.6939,8.11827,20.4008Q8.26429,20.8046,8.47003,21.1877Q6.58108,20.4165,5.51772,18.6289Q4.40845,16.7642,4.47992,13.9653Q4.55742,10.9301,6.09281,8.87041Q7.54433,6.92327,9.9911,5.98978Q11.6663,5.35066,14.9582,4.89964Z" fill="url(#lgs2)"/>
								<path d="M27.0384,9.74718C27.0384,10.1576,27.024,10.5398,26.985,10.9161C26.9121,11.6174,26.7535,12.2984,26.4419,13.1045C26.3789,13.2675,26.3096,13.4357,26.2335,13.6102C26.0038,14.137,25.712,14.7214,25.3428,15.3966C25.6725,15.2034,25.9786,14.9669,26.2517,14.7085C26.7966,14.1929,27.2101,13.5901,27.4174,13.0706C27.4253,13.2983,27.432,13.52,27.4374,13.7358C27.4508,14.2718,27.4563,14.7712,27.4533,15.2354C27.4421,16.9613,27.3136,18.2019,27.0384,19.0391C26.6594,20.1921,26.497,21.1409,24.5713,23.5159C23.1756,25.2373,21.2649,26.6821,18.989,27.5549C18.125,27.8863,17.2083,28.1352,16.2472,28.2856Q17.4123,27.7221,18.2149,26.5777C18.9358,25.5499,19.4375,24.1707,19.72,22.4402C20.0891,20.1788,19.7819,18.3216,19.0234,16.9546C18.2648,15.5877,17.055,14.7109,15.619,14.4104C14.3901,14.1531,13.2178,14.1614,12.1107,14.6408C11.493,14.9083,10.8955,15.3225,10.3198,15.9192C10.5286,15.1529,10.8271,14.4067,11.2492,13.7296C11.99,12.5416,13.1113,11.5666,14.7962,11.0697C17.4413,10.2898,19.3065,11.0019,21.6464,10.0524C23.3388,9.36563,24.5167,8.11122,25.27,6.62273C25.5582,6.05318,25.7843,5.44936,25.9532,4.82996C26.1968,5.54244,26.4045,6.14312,26.571,6.70243C26.8721,7.71378,27.0384,8.58988,27.0384,9.74718ZM25.9494,16.432Q26.0909,16.3491,26.2258,16.2619Q26.1554,17.8824,25.8984,18.6643Q25.8567,18.7911,25.7805,19.033Q25.221,20.8092,23.6392,22.7601Q22.0729,24.6919,20.0151,25.7986Q20.6105,24.4335,20.9043,22.6335Q21.505,18.9536,20.0726,16.3724Q18.6564,13.8201,15.8648,13.2358Q14.5693,12.9647,13.4195,13.086Q14.1601,12.5084,15.1356,12.2208Q16.2354,11.8965,18.187,11.8304Q20.6625,11.7467,22.0976,11.1643Q24.3415,10.2538,25.6854,8.31288Q25.8384,9.13071,25.8384,9.74718Q25.8384,11.989,24.2899,14.8209L22.2116,18.6219L25.9494,16.432Z" fill="url(#lgs3)"/>
							</svg>
							<div class="min-w-0">
								<h1 class="text-base font-semibold tracking-tight text-[var(--inno-text)]">Inno Agent</h1>
								<p class="text-xs text-[var(--inno-text-muted)] mt-0.5">Personal Learning Workstation</p>
							</div>
						</div>
					</div>
					<button
						class="h-8 w-8 shrink-0 rounded-md border border-black/10 bg-white/70 text-sm text-[var(--inno-text-muted)] hover:bg-black/[0.055] hover:text-[var(--inno-text)]"
						title="Collapse sessions"
						@click=${() => appStore.setSidebarCollapsed(true)}
					>
						&lt;
					</button>
				</div>
			</div>

			<!-- Collapsible quick-card -->
			<div class="px-3 pt-3 pb-1">
				${this._cardExpanded ? html`
					<div
						class="relative cursor-pointer overflow-hidden rounded-2xl"
						style="backdrop-filter: blur(5px); -webkit-backdrop-filter: blur(5px);"
						@click=${() => this._cardExpanded = false}
					>
						<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 310 108" class="absolute inset-0 w-full h-full">
							<defs>
								<clipPath id="card_clip">
									<path d="M0 96C0 102.62742 5.3725843 108 12.000005 108L298 108C304.62741 108 310 102.62742 310 96L310 12.000002C310 5.3725834 304.62741 0 298 0L12.000003 0C5.3725843 0 0 5.3725834 0 12L0 96Z"/>
								</clipPath>
							</defs>
							<foreignObject x="0" y="0" width="310" height="108">
								<div xmlns="http://www.w3.org/1999/xhtml" style="backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px);clip-path:url(#card_clip);height:100%;width:100%"></div>
							</foreignObject>
							<path d="M0,96C0,102.62742,5.3725843,108,12.000005,108L298,108C304.62741,108,310,102.62742,310,96L310,12.000002C310,5.3725834,304.62741,0,298,0L12.000003,0C5.3725843,0,0,5.3725834,0,12L0,96Z" fill="#FFFFFF" fill-opacity="0.8"/>
							<path d="M0,96C0,102.62742,5.3725843,108,12.000005,108L298,108C304.62741,108,310,102.62742,310,96L310,12.000002C310,5.3725834,304.62741,0,298,0L12.000003,0C5.3725843,0,0,5.3725834,0,12L0,96ZM1,96Q1,100.55636,4.2218266,103.77818Q7.4436507,107,12.000006,107L298,107Q302.55634,107,305.77817,103.77818Q309,100.55634,309,96L309,12.000003Q309,7.4436655,305.77817,4.2218256Q302.55634,0.9999994,298,0.99999875L12.000003,1Q7.4436526,1,4.2218266,4.2218256Q1,7.4436522,1,12L1,96Z" fill-rule="evenodd" fill="#DDE2FF"/>
						</svg>
						<div class="relative z-10 px-4 py-3 text-sm text-[var(--inno-text)]">
							Expanded card content here
						</div>
					</div>
				` : html`
					<svg
						class="cursor-pointer w-full"
						xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 310 44"
						@click=${() => this._cardExpanded = true}
					>
						<path d="M0,31.999998C0,38.627419,5.3725843,44,12.000005,44L298,44C304.62741,44,310,38.627419,310,31.999998L310,12.000002C310,5.3725834,304.62741,0,298,0L12.000003,0C5.3725843,0,0,5.3725834,0,12.000002L0,31.999998Z" fill="#E3E7FF" fill-opacity="1" style="opacity:0.6"/>
					</svg>
				`}
			</div>

			<!-- Sessions -->
			<div class="flex-1 min-h-0">
				<div class="flex items-center justify-between px-3 py-2">
					<h2 class="text-xs font-medium uppercase tracking-wide text-[var(--inno-text-muted)]">Chat Sessions</h2>
					<div class="flex items-center gap-2">
						<button
							class="rounded-md inno-primary-button px-2 py-1 text-xs font-medium text-white"
							title="New chat"
							@click=${() => this._newChat()}
						>
							New
						</button>
						<button
							class="text-xs text-[var(--inno-text-muted)] hover:text-[var(--inno-text)]"
							title="Refresh sessions"
							@click=${() => sessionsStore.load()}
						>
							Refresh
						</button>
					</div>
				</div>
				<div class="overflow-y-auto px-2 pb-2 h-[calc(100%-34px)]">
					${this._isLoadingSessions
						? html`<div class="px-2 py-3 text-xs text-[var(--inno-text-muted)]">Loading...</div>`
						: this._sessions.length === 0
							? html`<div class="px-2 py-3 text-xs text-[var(--inno-text-muted)]">No saved sessions</div>`
							: this._sessions.map((session) => this._renderSession(session))}
				</div>
			</div>

			<!-- New chat button -->
			<div class="p-2 border-t border-black/10">
				<button
					class="flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm w-full
						inno-primary-button text-white transition-colors"
					@click=${() => this._newChat()}
				>
					+ New Chat
				</button>
			</div>
		`;
	}
}
