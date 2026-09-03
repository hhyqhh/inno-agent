import { useEffect, useState, useRef, useCallback, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { QrCode as QrCodeIcon, CheckCircle, Wifi, WifiOff, Bird, MessageCircle } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { settingsStore } from "../../stores/settings-store.js";
import { feishuQrRegister, feishuQrStatus, wechatQrLogin, wechatQrStatus, wechatStatus } from "../../api/settings.js";
import type { InnoSettings, ChannelsSettingsPayload, PersonalBridgeChannelConfig } from "../../types/settings.js";
import { inputCls } from "../ui/input.js";
import { checkboxCls } from "../ui/checkbox.js";
import { Switch } from "../ui/Switch.js";
import { SettingsSection } from "./primitives.js";

const labelCls = "mb-0.5 block text-xs text-[var(--inno-text-muted)]";
const checkCls = "flex items-center gap-1.5 text-xs text-[var(--inno-text-muted)]";

/* ---------- Shared channel building blocks ---------- */

/** Card shell shared by every channel: icon + title + description, enable Switch on the right. */
function ChannelCard({ icon, title, desc, enabled, onEnabledChange, children }: {
	icon: ReactNode;
	title: string;
	desc: string;
	enabled: boolean;
	onEnabledChange: (next: boolean) => void;
	children: ReactNode;
}) {
	return (
		<div className="rounded-lg bg-[var(--inno-surface)] p-4">
			<div className="flex items-start justify-between gap-3">
				<div className="flex min-w-0 items-start gap-2.5">
					<span className="mt-0.5 shrink-0 text-[var(--inno-text)]">{icon}</span>
					<div className="min-w-0">
						<h4 className="text-sm font-medium text-[var(--inno-text)]">{title}</h4>
						<p className="mt-0.5 text-xs leading-relaxed text-[var(--inno-text-muted)]">{desc}</p>
					</div>
				</div>
				<Switch checked={enabled} onChange={onEnabledChange} />
			</div>
			<div className="mt-4 grid gap-3">{children}</div>
		</div>
	);
}

/** Connection status row: colored dot icon + state label + optional detail (appId / botId). */
function ChannelStatusRow({ connected, label, detail }: {
	connected: boolean;
	label: string;
	detail?: string | null;
}) {
	return (
		<div className="flex items-center gap-2 rounded border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] px-3 py-2">
			{connected ? (
				<>
					<Wifi size={14} className="shrink-0 text-[var(--inno-success)]" />
					<span className="text-xs font-medium text-[var(--inno-success)]">{label}</span>
					{detail ? <span className="ml-1 text-xs text-[var(--inno-text-subtle)]">{detail}</span> : null}
				</>
			) : (
				<>
					<WifiOff size={14} className="shrink-0 text-[var(--inno-text-subtle)]" />
					<span className="text-xs text-[var(--inno-text-muted)]">{label}</span>
				</>
			)}
		</div>
	);
}

/** Dashed container hosting the QR code / QR flow status / action button. */
function QrPanel({ children }: { children: ReactNode }) {
	return (
		<div className="flex flex-col items-center gap-2 rounded border border-dashed border-[var(--inno-border)] bg-[var(--inno-surface)] p-3">
			{children}
		</div>
	);
}

function QrActionButton({ label, onClick }: { label: string; onClick: () => void }) {
	return (
		<button
			className="flex items-center gap-1.5 rounded-md inno-primary-button px-3 py-1.5 text-xs text-white"
			onClick={onClick}
		>
			<QrCodeIcon size={14} />
			{label}
		</button>
	);
}

/** Access control fields shared by channel cards. `personalOnly` is optional:
 * only channels whose backend enforces it (Feishu) should pass it — WeChat
 * iLink never read the knob and its backend field was removed. */
function AccessControl({ personalOnly, onPersonalOnlyChange, userIds, onUserIdsChange }: {
	personalOnly?: boolean;
	onPersonalOnlyChange?: (next: boolean) => void;
	userIds: string;
	onUserIdsChange: (next: string) => void;
}) {
	const { t } = useTranslation();
	return (
		<div className="grid gap-2">
			{personalOnly !== undefined && (
				<label className={checkCls}>
					<input type="checkbox" className={checkboxCls} checked={personalOnly} onChange={(e) => onPersonalOnlyChange?.(e.target.checked)} />
					{t("settings.channels.personalOnly")}
				</label>
			)}
			<div>
				<label className={labelCls}>{t("settings.channels.allowedUserIds")}</label>
				<textarea
					className={`${inputCls} h-14 resize-y`}
					placeholder={t("settings.channels.allowedUserIdsHint") ?? ""}
					value={userIds}
					onChange={(e) => onUserIdsChange(e.target.value)}
				/>
			</div>
		</div>
	);
}

/* ---------- Feishu channel ---------- */

function FeishuChannel({ settings, state, onStateChange }: {
	settings: InnoSettings;
	state: {
		enabled: boolean;
		appId: string;
		appSecret: string;
		personalOnly: boolean;
		allowedUsers: string;
	};
	onStateChange: (patch: Partial<{ enabled: boolean; appId: string; appSecret: string; personalOnly: boolean; allowedUsers: string }>) => void;
}) {
	const { t } = useTranslation();

	// QR registration state
	const [qrUrl, setQrUrl] = useState<string | null>(null);
	const [qrState, setQrState] = useState<string | null>(null); // scanning | waitingScan | confirmed | expired | denied
	const [qrError, setQrError] = useState<string | null>(null);
	const qrPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

	useEffect(() => {
		return () => { if (qrPollRef.current) clearInterval(qrPollRef.current); };
	}, []);

	const startQrRegister = useCallback(async () => {
		setQrState("scanning");
		setQrUrl(null);
		setQrError(null);
		if (qrPollRef.current) clearInterval(qrPollRef.current);
		try {
			const { deviceCode, qrUrl: url, interval } = await feishuQrRegister();
			setQrUrl(url);
			setQrState("waitingScan");
			// Poll status
			qrPollRef.current = setInterval(async () => {
				try {
					const res = await feishuQrStatus(deviceCode);
					if (res.status === "confirmed") {
						setQrState("confirmed");
						onStateChange({ enabled: true });
						if (qrPollRef.current) clearInterval(qrPollRef.current);
						// Refresh settings to get new appId
						settingsStore.load();
					} else if (res.status === "expired") {
						setQrState("expired");
						if (qrPollRef.current) clearInterval(qrPollRef.current);
					} else if (res.status === "denied") {
						setQrState("denied");
						if (qrPollRef.current) clearInterval(qrPollRef.current);
					}
				} catch {
					// ignore poll errors
				}
			}, (interval || 5) * 1000);
		} catch (err) {
			setQrState(null);
			setQrError(err instanceof Error ? err.message : "QR registration failed");
		}
	}, [onStateChange]);

	const configured = Boolean(settings.feishu?.appId) || qrState === "confirmed";

	return (
		<ChannelCard
			icon={<Bird size={16} />}
			title={t("settings.channels.feishu.title")}
			desc={t("settings.channels.feishu.desc")}
			enabled={state.enabled}
			onEnabledChange={(v) => onStateChange({ enabled: v })}
		>
			<ChannelStatusRow
				connected={configured}
				label={configured ? t("settings.channels.feishu.configured", "已配置") : t("settings.channels.feishu.notConfigured", "未配置")}
				detail={settings.feishu?.appId ? `App ID: ${settings.feishu.appId}` : null}
			/>

			<QrPanel>
				{qrState === "waitingScan" && qrUrl ? (
					<>
						<div className="text-xs font-medium text-[var(--inno-text)]">{t("settings.feishu.qrTitle")}</div>
						<QRCodeSVG value={qrUrl} size={192} />
						<div className="text-xs text-[var(--inno-text-subtle)]">{t("settings.feishu.qrSubtitle")}</div>
						<div className="text-xs text-[var(--inno-accent)]">{t("settings.feishu.qrWaiting")}</div>
					</>
				) : qrState === "confirmed" ? (
					<div className="flex items-center gap-1.5 text-xs text-[var(--inno-success)]">
						<CheckCircle size={14} />
						{t("settings.feishu.qrConfirmed")}
					</div>
				) : qrState === "expired" ? (
					<div className="text-xs text-[var(--inno-warning)]">{t("settings.feishu.qrExpired")}</div>
				) : qrState === "denied" ? (
					<div className="text-xs text-[var(--inno-danger)]">{t("settings.feishu.qrDenied")}</div>
				) : qrState === "scanning" ? (
					<div className="text-xs text-[var(--inno-text-subtle)]">{t("settings.feishu.qrWaiting")}</div>
				) : null}
				{(!qrState || qrState === "confirmed" || qrState === "expired" || qrState === "denied") && (
					<QrActionButton label={t("settings.feishu.qrRegister")} onClick={startQrRegister} />
				)}
				{qrError && (
					<div className="rounded bg-[var(--inno-danger-bg)] px-2 py-1 text-xs text-[var(--inno-danger)]">{qrError}</div>
				)}
			</QrPanel>

			{state.enabled && (
				<>
					<div className="grid grid-cols-2 gap-2">
						<div>
							<label className={labelCls}>{t("settings.channels.feishu.appId")}</label>
							<input className={inputCls} value={state.appId} onChange={(e) => onStateChange({ appId: e.target.value })} />
						</div>
						<div>
							<label className={labelCls}>{t("settings.channels.feishu.appSecret")} {settings.feishu?.appSecret && <span className="text-[var(--inno-text-subtle)]">(••••)</span>}</label>
							<input className={inputCls} type="password" placeholder={t("settings.channels.feishu.appSecretHint") ?? ""} value={state.appSecret} onChange={(e) => onStateChange({ appSecret: e.target.value })} />
						</div>
					</div>
					<AccessControl
						personalOnly={state.personalOnly}
						onPersonalOnlyChange={(v) => onStateChange({ personalOnly: v })}
						userIds={state.allowedUsers}
						onUserIdsChange={(v) => onStateChange({ allowedUsers: v })}
					/>
				</>
			)}
		</ChannelCard>
	);
}

/* ---------- WeChat channel (iLink native) ---------- */

function WechatChannel({ state, onStateChange }: {
	state: {
		enabled: boolean;
		allowedUsers: string;
	};
	onStateChange: (patch: Partial<{ enabled: boolean; allowedUsers: string }>) => void;
}) {
	const { t } = useTranslation();

	// QR login state
	const [qrUrl, setQrUrl] = useState<string | null>(null);
	const [qrStatus, setQrStatus] = useState<string | null>(null); // scanning | waitingScan | scanned | confirmed | expired
	const [qrError, setQrError] = useState<string | null>(null);
	const [wxConnected, setWxConnected] = useState(false);
	const [wxBotId, setWxBotId] = useState<string | null>(null);
	const qrPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

	// Check WeChat connection status on mount
	useEffect(() => {
		if (state.enabled) {
			wechatStatus().then((s) => {
				setWxConnected(s.connected);
				if (s.botId) setWxBotId(s.botId);
			}).catch(() => {});
		}
		return () => { if (qrPollRef.current) clearInterval(qrPollRef.current); };
	}, [state.enabled]);

	const startQrLogin = useCallback(async () => {
		setQrStatus("scanning");
		setQrUrl(null);
		setQrError(null);
		if (qrPollRef.current) clearInterval(qrPollRef.current);
		try {
			const { qrId: id, qrUrl: url } = await wechatQrLogin();
			setQrUrl(url);
			setQrStatus("waitingScan");
			// Poll status every 2s
			qrPollRef.current = setInterval(async () => {
				try {
					const res = await wechatQrStatus(id);
					if (res.status === "scanned") setQrStatus("scanned");
					else if (res.status === "confirmed") {
						setQrStatus("confirmed");
						setWxConnected(true);
						if (res.botId) setWxBotId(res.botId);
						if (qrPollRef.current) clearInterval(qrPollRef.current);
					} else if (res.status === "expired") {
						setQrStatus("expired");
						if (qrPollRef.current) clearInterval(qrPollRef.current);
					}
				} catch {
					// ignore poll errors
				}
			}, 2000);
		} catch (err) {
			setQrStatus(null);
			setQrError(err instanceof Error ? err.message : "QR login failed");
		}
	}, []);

	const connected = wxConnected || qrStatus === "confirmed";

	return (
		<ChannelCard
			icon={<MessageCircle size={16} />}
			title={t("settings.channels.wechat.title")}
			desc={t("settings.channels.wechat.desc")}
			enabled={state.enabled}
			onEnabledChange={(v) => onStateChange({ enabled: v })}
		>
			<ChannelStatusRow
				connected={connected}
				label={connected ? t("settings.channels.wechat.connected") : t("settings.channels.wechat.disconnected")}
				detail={connected && wxBotId ? `${t("settings.channels.wechat.botId")}: ${wxBotId}` : null}
			/>

			<QrPanel>
				{qrUrl && qrStatus !== "confirmed" && qrStatus !== "expired" && (
					<QRCodeSVG value={qrUrl} size={192} level="M" />
				)}
				{qrStatus === "confirmed" && (
					<div className="flex items-center gap-1.5 text-xs text-[var(--inno-success)]">
						<CheckCircle size={14} />
						{t("settings.channels.wechat.confirmed")}
					</div>
				)}
				{qrStatus === "expired" && (
					<div className="text-xs text-[var(--inno-warning)]">{t("settings.channels.wechat.expired")}</div>
				)}
				{qrStatus === "scanning" && (
					<div className="text-xs text-[var(--inno-text-subtle)]">{t("settings.channels.wechat.scanning")}</div>
				)}
				{qrStatus === "waitingScan" && (
					<div className="text-xs text-[var(--inno-text-muted)]">{t("settings.channels.wechat.waitingScan")}</div>
				)}
				{qrStatus === "scanned" && (
					<div className="text-xs text-[var(--inno-accent)]">{t("settings.channels.wechat.scanned")}</div>
				)}
				{(!qrStatus || qrStatus === "confirmed" || qrStatus === "expired") && (
					<QrActionButton
						label={connected ? t("settings.channels.wechat.relogin") : t("settings.channels.wechat.scanLogin")}
						onClick={() => void startQrLogin()}
					/>
				)}
				{qrError && (
					<div className="rounded bg-[var(--inno-danger-bg)] px-2 py-1 text-xs text-[var(--inno-danger)]">{qrError}</div>
				)}
			</QrPanel>

			{state.enabled && (
				<AccessControl
					userIds={state.allowedUsers}
					onUserIdsChange={(v) => onStateChange({ allowedUsers: v })}
				/>
			)}
		</ChannelCard>
	);
}

/* ---------- Channels category page ---------- */

export function ChannelsSettings({ settings }: { settings: InnoSettings }) {
	const { t } = useTranslation();
	const [saving, setSaving] = useState(false);
	const [saveMsg, setSaveMsg] = useState<string | null>(null);
	const [formError, setFormError] = useState<string | null>(null);

	// Feishu
	const [feishu, setFeishu] = useState({
		enabled: settings.channels?.feishu?.enabled ?? false,
		appId: settings.feishu?.appId ?? "",
		appSecret: "",
		personalOnly: settings.channels?.feishu?.personalOnly ?? true,
		allowedUsers: (settings.channels?.feishu?.allowedUserIds ?? []).join("\n"),
	});
	const patchFeishu = useCallback((patch: Partial<typeof feishu>) => setFeishu((s) => ({ ...s, ...patch })), []);

	// QQ
	const qqConfig = settings.channels?.qq as PersonalBridgeChannelConfig | undefined;
	const [qqEnabled, setQqEnabled] = useState(qqConfig?.enabled ?? false);
	const [qqSidecarUrl, setQqSidecarUrl] = useState(qqConfig?.sidecarBaseUrl ?? "http://127.0.0.1:4318");
	const [qqPersonalOnly, setQqPersonalOnly] = useState(qqConfig?.personalOnly ?? true);
	const [qqAllowedUsers, setQqAllowedUsers] = useState(
		(qqConfig?.allowedUserIds ?? []).join("\n"),
	);
	// QQ channel is not yet implemented; flip to true when ready to expose settings.
	const QQ_CHANNEL_READY = false;

	// WeChat
	const wechatConfig = settings.channels?.wechat;
	const [wechat, setWechat] = useState({
		enabled: wechatConfig?.enabled ?? false,
		allowedUsers: (wechatConfig?.allowedUserIds ?? []).join("\n"),
	});
	const patchWechat = useCallback((patch: Partial<typeof wechat>) => setWechat((s) => ({ ...s, ...patch })), []);

	// Bridge
	const [bridgeToken, setBridgeToken] = useState("");

	function parseUserIds(text: string): string[] {
		return text.split("\n").map((s) => s.trim()).filter(Boolean);
	}

	async function handleSave() {
		setFormError(null);
		setSaveMsg(null);
		setSaving(true);
		try {
			const payload: ChannelsSettingsPayload = {
				channels: {
					feishu: {
						enabled: feishu.enabled,
						personalOnly: feishu.personalOnly,
						allowedUserIds: parseUserIds(feishu.allowedUsers),
					},
					qq: {
						enabled: qqEnabled,
						mode: "bridge",
						personalOnly: qqPersonalOnly,
						allowedUserIds: parseUserIds(qqAllowedUsers),
						sidecarBaseUrl: qqSidecarUrl.trim(),
					},
					wechat: {
						enabled: wechat.enabled,
						mode: "ilink",
						allowedUserIds: parseUserIds(wechat.allowedUsers),
					},
				},
			};
			if (feishu.appId.trim()) {
				payload.feishu = {
					appId: feishu.appId.trim(),
					...(feishu.appSecret.trim() ? { appSecret: feishu.appSecret.trim() } : {}),
				};
			}
			if (bridgeToken.trim()) {
				payload.bridge = { token: bridgeToken.trim() };
			}
			await settingsStore.saveChannels(payload);
			setSaveMsg(t("settings.channels.saved"));
			setTimeout(() => setSaveMsg(null), 3000);
		} catch (err) {
			setFormError(err instanceof Error ? err.message : "Save failed");
		} finally {
			setSaving(false);
		}
	}

	return (
		<SettingsSection title={t("settings.tabs.channels")} description={t("settings.sections.channels.desc", "飞书、微信等消息渠道接入")}>
			<FeishuChannel settings={settings} state={feishu} onStateChange={patchFeishu} />

			{/* QQ (hidden: channel not yet implemented) */}
			{QQ_CHANNEL_READY && (
				<div className="rounded-lg bg-[var(--inno-surface)] p-4">
					<div className="mb-2 flex items-center justify-between">
						<div>
							<div className="text-xs font-medium text-[var(--inno-text)]">{t("settings.channels.qq.title")}</div>
							<div className="text-xs text-[var(--inno-text-subtle)]">{t("settings.channels.qq.desc")}</div>
						</div>
						<label className={checkCls}>
							<input type="checkbox" className={checkboxCls} checked={qqEnabled} onChange={(e) => setQqEnabled(e.target.checked)} />
							{t("settings.channels.enabled")}
						</label>
					</div>
					{qqEnabled && (
						<div className="grid grid-cols-2 gap-2">
							<div className="col-span-2">
								<label className={labelCls}>{t("settings.channels.sidecarBaseUrl")}</label>
								<input className={inputCls} value={qqSidecarUrl} onChange={(e) => setQqSidecarUrl(e.target.value)} />
							</div>
							<div className="col-span-2">
								<AccessControl
									personalOnly={qqPersonalOnly}
									onPersonalOnlyChange={setQqPersonalOnly}
									userIds={qqAllowedUsers}
									onUserIdsChange={setQqAllowedUsers}
								/>
							</div>
						</div>
					)}
				</div>
			)}

			<WechatChannel state={wechat} onStateChange={patchWechat} />

			{/* Bridge Token (used by QQ sidecar) */}
			{QQ_CHANNEL_READY && qqEnabled && (
				<div className="rounded-lg bg-[var(--inno-surface)] p-4">
					<div className="text-xs font-medium text-[var(--inno-text)] mb-1">{t("settings.channels.bridgeToken")}</div>
					<div className="text-xs text-[var(--inno-text-subtle)] mb-2">{t("settings.channels.bridgeTokenHint")}</div>
					<input
						className={inputCls}
						type="password"
						placeholder={settings.bridge?.token ? t("settings.channels.bridgeTokenPlaceholder") ?? "" : ""}
						value={bridgeToken}
						onChange={(e) => setBridgeToken(e.target.value)}
					/>
					{settings.bridge?.token && <div className="mt-1 text-xs text-[var(--inno-text-subtle)]">({settings.bridge.token})</div>}
				</div>
			)}

			<div className="grid justify-items-start gap-2">
				{formError && <div className="w-full rounded bg-[var(--inno-danger-bg)] px-2 py-1 text-xs text-[var(--inno-danger)]">{formError}</div>}
				{saveMsg && <div className="w-full rounded bg-[var(--inno-success-bg)] px-2 py-1 text-xs text-[var(--inno-success)]">{saveMsg}</div>}
				<button
					className="rounded-md inno-primary-button px-3 py-1.5 text-xs text-white disabled:opacity-50"
					disabled={saving}
					onClick={() => void handleSave()}
				>
					{saving ? t("settings.channels.saving") : t("settings.channels.save")}
				</button>
			</div>
		</SettingsSection>
	);
}
