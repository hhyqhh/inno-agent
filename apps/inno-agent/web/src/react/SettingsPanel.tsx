import { useEffect, useState, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Trash2, Pencil, X, ChevronDown, ChevronRight, Plus, QrCode as QrCodeIcon, CheckCircle, Wifi, WifiOff, Database } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { getWikiStats } from "../api/wiki.js";
import { settingsStore } from "../stores/settings-store.js";
import { themeStore, THEME_IDS, THEME_PREVIEW_COLORS, type ThemeId } from "../stores/theme-store.js";
import { wechatQrLogin, wechatQrStatus, wechatStatus } from "../api/settings.js";
import type { InnoModelInfo, InnoProviderModel as ProviderModel, InnoSettings, ChannelsSettingsPayload, PersonalBridgeChannelConfig } from "../types/settings.js";
import type { WikiStats } from "../types/wiki.js";
import { useStoreSnapshot } from "./hooks.js";
import { setLocale } from "../i18n/index.js";
import ToggleSwitch from "./ToggleSwitch.js";

const apiOptions = ["openai-completions", "openai-responses", "anthropic-messages"];

interface ProviderFormState {
	providerId: string;
	baseUrl: string;
	apiKey: string;
	api: string;
	modelId: string;
	modelName: string;
	contextWindow: string;
	maxTokens: string;
	reasoning: boolean;
	makeDefault: boolean;
	preserveApiKey: boolean;
}

const emptyForm: ProviderFormState = {
	providerId: "",
	baseUrl: "",
	apiKey: "",
	api: "openai-completions",
	modelId: "",
	modelName: "",
	contextWindow: "128000",
	maxTokens: "8192",
	reasoning: false,
	makeDefault: true,
	preserveApiKey: false,
};

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTokens(tokens: number): string {
	return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

function modelKey(model: InnoModelInfo): string {
	return `${model.provider}:${model.id}`;
}

/* ---------- Model Edit Form (inline) ---------- */

function ModelEditForm({ model, settings, onClose }: {
	model: InnoModelInfo;
	settings: NonNullable<typeof settingsStore.settings>;
	onClose: () => void;
}) {
	const { t } = useTranslation();
	const provider = settings.providers[model.provider];
	const [form, setForm] = useState<ProviderFormState>({
		providerId: model.provider,
		baseUrl: provider?.baseUrl ?? "",
		apiKey: "",
		api: provider?.api ?? "openai-completions",
		modelId: model.id,
		modelName: model.name || model.id,
		contextWindow: String(model.contextWindow),
		maxTokens: String(model.maxTokens),
		reasoning: model.reasoning,
		makeDefault: settings.defaultProvider === model.provider && settings.defaultModel === model.id,
		preserveApiKey: Boolean(provider?.apiKey),
	});
	const [formError, setFormError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	async function handleSave() {
		const contextWindow = Number(form.contextWindow);
		const maxTokens = Number(form.maxTokens);
		if (!form.providerId.trim()) return setFormError(t("settings.errors.providerRequired"));
		if (!form.baseUrl.trim()) return setFormError(t("settings.errors.baseUrlRequired"));
		if (!form.modelId.trim()) return setFormError(t("settings.errors.modelRequired"));
		if (!Number.isFinite(contextWindow) || contextWindow <= 0 || !Number.isFinite(maxTokens) || maxTokens <= 0) {
			return setFormError(t("settings.errors.tokensInvalid"));
		}
		setSaving(true);
		try {
			const providerModel: ProviderModel = {
				id: form.modelId.trim(),
				name: form.modelName.trim() || form.modelId.trim(),
				reasoning: form.reasoning,
				contextWindow: Math.trunc(contextWindow),
				maxTokens: Math.trunc(maxTokens),
			};
			await settingsStore.saveProvider({
				providerId: form.providerId.trim(),
				baseUrl: form.baseUrl.trim(),
				apiKey: form.apiKey,
				api: form.api,
				models: [providerModel],
				makeDefault: form.makeDefault,
				preserveApiKey: form.preserveApiKey,
			});
			onClose();
		} catch (err) {
			setFormError(err instanceof Error ? err.message : "Save failed");
		} finally {
			setSaving(false);
		}
	}

	const maskedKey = provider?.apiKey ? "••••••••" : "";

	return (
		<div className="rounded-lg border border-[var(--inno-accent-soft)] bg-blue-50/50 p-3">
			<div className="mb-2 flex items-center justify-between">
				<span className="text-xs font-medium text-[var(--inno-text)]">{t("settings.editModel", "Edit Model")}</span>
				<button className="flex h-6 w-6 items-center justify-center rounded-full text-[var(--inno-text-subtle)] hover:bg-slate-200 hover:text-[var(--inno-text)]" onClick={onClose}><X size={14} /></button>
			</div>
			<div className="grid grid-cols-2 gap-2">
				<div>
					<label className="mb-0.5 block text-[10px] text-[var(--inno-text-muted)]">{t("settings.form.providerId")}</label>
					<input className="w-full rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] px-2.5 py-1.5 text-xs text-[var(--inno-text-muted)]" value={form.providerId} readOnly />
				</div>
				<div>
					<label className="mb-0.5 block text-[10px] text-[var(--inno-text-muted)]">{t("settings.form.apiType", "API Type")}</label>
					<select className="w-full rounded-md border border-[var(--inno-border)] px-2.5 py-1.5 text-xs" value={form.api} onChange={(e) => setForm({ ...form, api: e.target.value })}>
						{apiOptions.map((api) => <option key={api} value={api}>{api}</option>)}
					</select>
				</div>
				<div className="col-span-2">
					<label className="mb-0.5 block text-[10px] text-[var(--inno-text-muted)]">{t("settings.form.baseUrl")}</label>
					<input className="w-full rounded-md border border-[var(--inno-border)] px-2.5 py-1.5 text-xs" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
				</div>
				<div className="col-span-2">
					<label className="mb-0.5 block text-[10px] text-[var(--inno-text-muted)]">{t("settings.form.apiKey")} {maskedKey && <span className="text-[var(--inno-text-subtle)]">({maskedKey})</span>}</label>
					<input className="w-full rounded-md border border-[var(--inno-border)] px-2.5 py-1.5 text-xs" type="password" placeholder={form.preserveApiKey ? t("settings.form.apiKeyPreserved", "Leave empty to keep current key") ?? "" : ""} value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />
				</div>
				<div>
					<label className="mb-0.5 block text-[10px] text-[var(--inno-text-muted)]">{t("settings.form.modelId")}</label>
					<input className="w-full rounded-md border border-[var(--inno-border)] px-2.5 py-1.5 text-xs" value={form.modelId} onChange={(e) => setForm({ ...form, modelId: e.target.value })} />
				</div>
				<div>
					<label className="mb-0.5 block text-[10px] text-[var(--inno-text-muted)]">{t("settings.form.modelName")}</label>
					<input className="w-full rounded-md border border-[var(--inno-border)] px-2.5 py-1.5 text-xs" value={form.modelName} onChange={(e) => setForm({ ...form, modelName: e.target.value })} />
				</div>
				<div>
					<label className="mb-0.5 block text-[10px] text-[var(--inno-text-muted)]">{t("settings.form.contextWindow")}</label>
					<input className="w-full rounded-md border border-[var(--inno-border)] px-2.5 py-1.5 text-xs" value={form.contextWindow} onChange={(e) => setForm({ ...form, contextWindow: e.target.value })} />
				</div>
				<div>
					<label className="mb-0.5 block text-[10px] text-[var(--inno-text-muted)]">{t("settings.form.maxTokens")}</label>
					<input className="w-full rounded-md border border-[var(--inno-border)] px-2.5 py-1.5 text-xs" value={form.maxTokens} onChange={(e) => setForm({ ...form, maxTokens: e.target.value })} />
				</div>
			</div>
			<div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-[var(--inno-text-muted)]">
				<label className="flex items-center gap-1.5"><ToggleSwitch checked={form.reasoning} onChange={(v) => setForm({ ...form, reasoning: v })} /> {t("settings.form.reasoning")}</label>
				<label className="flex items-center gap-1.5"><ToggleSwitch checked={form.makeDefault} onChange={(v) => setForm({ ...form, makeDefault: v })} /> {t("settings.form.makeDefault")}</label>
				<label className="flex items-center gap-1.5"><ToggleSwitch checked={form.preserveApiKey} onChange={(v) => setForm({ ...form, preserveApiKey: v })} /> {t("settings.form.preserveApiKey")}</label>
			</div>
			{formError ? <div className="mt-2 rounded bg-red-50 px-2 py-1 text-xs text-red-700">{formError}</div> : null}
			<div className="mt-2 flex gap-2">
				<button className="rounded-full inno-primary-button px-3 py-1.5 text-xs text-white disabled:opacity-50" disabled={saving} onClick={() => void handleSave()}>
					{saving ? t("settings.savingProvider") : t("settings.saveProvider")}
				</button>
				<button className="rounded-full border border-[var(--inno-border)] px-3 py-1.5 text-xs text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)]" onClick={onClose}>
					{t("common.cancel", "Cancel")}
				</button>
			</div>
		</div>
	);
}

/* ---------- New Provider Form (collapsible) ---------- */

function ThemeSettings() {
	const { t } = useTranslation();
	const state = useStoreSnapshot(themeStore, () => ({ current: themeStore.current }));
	return (
		<div className="flex items-center gap-1.5 text-xs text-[var(--inno-text-muted)]">
			<span>{t("settings.theme")}</span>
			<div className="flex gap-1">
				{THEME_IDS.map((id) => {
					const active = state.current === id;
					return (
						<button
							key={id}
							type="button"
							aria-label={t(`settings.themeOptions.${id}`)}
							title={t(`settings.themeOptions.${id}`)}
							onClick={() => void themeStore.save(id)}
							className={`h-5 w-5 rounded-full border-2 transition-all ${
								active
									? "border-[var(--inno-accent)] ring-2 ring-[var(--inno-accent)]/30 scale-110"
									: "border-[var(--inno-border-strong)] hover:border-slate-400"
							}`}
							style={{ backgroundColor: THEME_PREVIEW_COLORS[id] }}
						/>
					);
				})}
			</div>
		</div>
	);
}

function NewProviderForm() {
	const { t } = useTranslation();
	const [expanded, setExpanded] = useState(false);
	const [form, setForm] = useState<ProviderFormState>(emptyForm);
	const [formError, setFormError] = useState<string | null>(null);
	const [saveMessage, setSaveMessage] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	async function handleSave() {
		const contextWindow = Number(form.contextWindow);
		const maxTokens = Number(form.maxTokens);
		if (!form.providerId.trim()) return setFormError(t("settings.errors.providerRequired"));
		if (!form.baseUrl.trim()) return setFormError(t("settings.errors.baseUrlRequired"));
		if (!form.modelId.trim()) return setFormError(t("settings.errors.modelRequired"));
		if (!Number.isFinite(contextWindow) || contextWindow <= 0 || !Number.isFinite(maxTokens) || maxTokens <= 0) {
			return setFormError(t("settings.errors.tokensInvalid"));
		}
		setSaving(true);
		try {
			const model: ProviderModel = {
				id: form.modelId.trim(),
				name: form.modelName.trim() || form.modelId.trim(),
				reasoning: form.reasoning,
				contextWindow: Math.trunc(contextWindow),
				maxTokens: Math.trunc(maxTokens),
			};
			await settingsStore.saveProvider({
				providerId: form.providerId.trim(),
				baseUrl: form.baseUrl.trim(),
				apiKey: form.apiKey,
				api: form.api,
				models: [model],
				makeDefault: form.makeDefault,
				preserveApiKey: false,
			});
			setSaveMessage(t("settings.saved"));
			setForm(emptyForm);
			setFormError(null);
			setExpanded(false);
		} catch (err) {
			setFormError(err instanceof Error ? err.message : "Save failed");
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="border-b border-[var(--inno-border)] bg-[var(--inno-surface)]">
			<button
				className="flex w-full items-center justify-between px-4 py-3 text-left"
				onClick={() => { setExpanded((v) => !v); setFormError(null); setSaveMessage(null); }}
			>
				<div className="flex items-center gap-2">
					<ChevronRight size={14} className={`text-[var(--inno-text-subtle)] transition-transform ${expanded ? "rotate-90" : ""}`} />
					<span className="text-sm font-medium text-[var(--inno-text)]">{t("settings.newProvider")}</span>
				</div>
				<Plus size={14} className="text-[var(--inno-text-subtle)]" />
			</button>
			{expanded && (
				<div className="px-4 pb-4 pt-1">
					<div className="grid grid-cols-2 gap-2">
						<div>
							<label className="mb-0.5 block text-[10px] text-[var(--inno-text-muted)]">{t("settings.form.providerId")}</label>
							<input className="w-full rounded-md border border-[var(--inno-border)] px-2.5 py-1.5 text-xs" placeholder={t("settings.form.providerId") ?? ""} value={form.providerId} onChange={(e) => setForm({ ...form, providerId: e.target.value })} />
						</div>
						<div>
							<label className="mb-0.5 block text-[10px] text-[var(--inno-text-muted)]">{t("settings.form.apiType", "API Type")}</label>
							<select className="w-full rounded-md border border-[var(--inno-border)] px-2.5 py-1.5 text-xs" value={form.api} onChange={(e) => setForm({ ...form, api: e.target.value })}>
								{apiOptions.map((api) => <option key={api} value={api}>{api}</option>)}
							</select>
						</div>
						<div className="col-span-2">
							<label className="mb-0.5 block text-[10px] text-[var(--inno-text-muted)]">{t("settings.form.baseUrl")}</label>
							<input className="w-full rounded-md border border-[var(--inno-border)] px-2.5 py-1.5 text-xs" placeholder={t("settings.form.baseUrl") ?? ""} value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
						</div>
						<div className="col-span-2">
							<label className="mb-0.5 block text-[10px] text-[var(--inno-text-muted)]">{t("settings.form.apiKey")}</label>
							<input className="w-full rounded-md border border-[var(--inno-border)] px-2.5 py-1.5 text-xs" type="password" placeholder={t("settings.form.apiKey") ?? ""} value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />
						</div>
						<div>
							<label className="mb-0.5 block text-[10px] text-[var(--inno-text-muted)]">{t("settings.form.modelId")}</label>
							<input className="w-full rounded-md border border-[var(--inno-border)] px-2.5 py-1.5 text-xs" placeholder={t("settings.form.modelId") ?? ""} value={form.modelId} onChange={(e) => setForm({ ...form, modelId: e.target.value })} />
						</div>
						<div>
							<label className="mb-0.5 block text-[10px] text-[var(--inno-text-muted)]">{t("settings.form.modelName")}</label>
							<input className="w-full rounded-md border border-[var(--inno-border)] px-2.5 py-1.5 text-xs" placeholder={t("settings.form.modelName") ?? ""} value={form.modelName} onChange={(e) => setForm({ ...form, modelName: e.target.value })} />
						</div>
						<div>
							<label className="mb-0.5 block text-[10px] text-[var(--inno-text-muted)]">{t("settings.form.contextWindow")}</label>
							<input className="w-full rounded-md border border-[var(--inno-border)] px-2.5 py-1.5 text-xs" value={form.contextWindow} onChange={(e) => setForm({ ...form, contextWindow: e.target.value })} />
						</div>
						<div>
							<label className="mb-0.5 block text-[10px] text-[var(--inno-text-muted)]">{t("settings.form.maxTokens")}</label>
							<input className="w-full rounded-md border border-[var(--inno-border)] px-2.5 py-1.5 text-xs" value={form.maxTokens} onChange={(e) => setForm({ ...form, maxTokens: e.target.value })} />
						</div>
					</div>
					<div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-[var(--inno-text-muted)]">
						<label className="flex items-center gap-1.5"><ToggleSwitch checked={form.reasoning} onChange={(v) => setForm({ ...form, reasoning: v })} /> {t("settings.form.reasoning")}</label>
						<label className="flex items-center gap-1.5"><ToggleSwitch checked={form.makeDefault} onChange={(v) => setForm({ ...form, makeDefault: v })} /> {t("settings.form.makeDefault")}</label>
					</div>
					{formError ? <div className="mt-2 rounded bg-red-50 px-2 py-1 text-xs text-red-700">{formError}</div> : null}
					{saveMessage ? <div className="mt-2 rounded bg-green-50 px-2 py-1 text-xs text-green-700">{saveMessage}</div> : null}
					<button className="mt-3 rounded-full inno-primary-button px-3 py-1.5 text-xs text-white disabled:opacity-50" disabled={saving} onClick={() => void handleSave()}>
						{saving ? t("settings.savingProvider") : t("settings.saveProvider")}
					</button>
				</div>
			)}
		</div>
	);
}

/* ---------- Channels Settings ---------- */

function ChannelsSettings({ settings }: { settings: InnoSettings }) {
	const { t } = useTranslation();
	const [expanded, setExpanded] = useState(false);
	const [saving, setSaving] = useState(false);
	const [saveMsg, setSaveMsg] = useState<string | null>(null);
	const [formError, setFormError] = useState<string | null>(null);

	// Feishu
	const [feishuEnabled, setFeishuEnabled] = useState(settings.channels?.feishu?.enabled ?? false);
	const [feishuAppId, setFeishuAppId] = useState(settings.feishu?.appId ?? "");
	const [feishuAppSecret, setFeishuAppSecret] = useState("");
	const [feishuPersonalOnly, setFeishuPersonalOnly] = useState(settings.channels?.feishu?.personalOnly ?? true);
	const [feishuAllowedUsers, setFeishuAllowedUsers] = useState(
		(settings.channels?.feishu?.allowedUserIds ?? []).join("\n"),
	);

	// QQ
	const qqConfig = settings.channels?.qq as PersonalBridgeChannelConfig | undefined;
	const [qqEnabled, setQqEnabled] = useState(qqConfig?.enabled ?? false);
	const [qqSidecarUrl, setQqSidecarUrl] = useState(qqConfig?.sidecarBaseUrl ?? "http://127.0.0.1:4318");
	const [qqPersonalOnly, setQqPersonalOnly] = useState(qqConfig?.personalOnly ?? true);
	const [qqAllowedUsers, setQqAllowedUsers] = useState(
		(qqConfig?.allowedUserIds ?? []).join("\n"),
	);

	// WeChat (iLink native mode)
	const wechatConfig = settings.channels?.wechat;
	const [wechatEnabled, setWechatEnabled] = useState(wechatConfig?.enabled ?? false);
	const [wechatPersonalOnly, setWechatPersonalOnly] = useState(wechatConfig?.personalOnly ?? true);
	const [wechatAllowedUsers, setWechatAllowedUsers] = useState(
		(wechatConfig?.allowedUserIds ?? []).join("\n"),
	);
	// QR login state
	const [qrUrl, setQrUrl] = useState<string | null>(null);
	const [qrId, setQrId] = useState<string | null>(null);
	const [qrStatus, setQrStatus] = useState<string | null>(null); // scanning | waitingScan | scanned | confirmed | expired
	const [wxConnected, setWxConnected] = useState(false);
	const [wxBotId, setWxBotId] = useState<string | null>(null);
	const qrPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

	// Check WeChat connection status on mount
	useEffect(() => {
		if (wechatEnabled) {
			wechatStatus().then((s) => {
				setWxConnected(s.connected);
				if (s.botId) setWxBotId(s.botId);
			}).catch(() => {});
		}
		return () => { if (qrPollRef.current) clearInterval(qrPollRef.current); };
	}, [wechatEnabled]);

	const [qrError, setQrError] = useState<string | null>(null);

	const startQrLogin = useCallback(async () => {
		setQrStatus("scanning");
		setQrUrl(null);
		setQrError(null);
		if (qrPollRef.current) clearInterval(qrPollRef.current);
		try {
			const { qrId: id, qrUrl: url } = await wechatQrLogin();
			setQrId(id);
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
						enabled: feishuEnabled,
						personalOnly: feishuPersonalOnly,
						allowedUserIds: parseUserIds(feishuAllowedUsers),
					},
					qq: {
						enabled: qqEnabled,
						mode: "bridge",
						personalOnly: qqPersonalOnly,
						allowedUserIds: parseUserIds(qqAllowedUsers),
						sidecarBaseUrl: qqSidecarUrl.trim(),
					},
					wechat: {
						enabled: wechatEnabled,
						mode: "ilink",
						personalOnly: wechatPersonalOnly,
						allowedUserIds: parseUserIds(wechatAllowedUsers),
					},
				},
			};
			if (feishuAppId.trim()) {
				payload.feishu = {
					appId: feishuAppId.trim(),
					...(feishuAppSecret.trim() ? { appSecret: feishuAppSecret.trim() } : {}),
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

	const inputCls = "w-full rounded-md border border-[var(--inno-border)] px-2.5 py-1.5 text-xs";
	const labelCls = "mb-0.5 block text-[10px] text-[var(--inno-text-muted)]";

	return (
		<div className="border-b border-[var(--inno-border)] bg-[var(--inno-surface)]">
			<button
				className="flex w-full items-center justify-between px-4 py-3 text-left"
				onClick={() => { setExpanded((v) => !v); setFormError(null); setSaveMsg(null); }}
			>
				<div className="flex items-center gap-2">
					<ChevronRight size={14} className={`text-[var(--inno-text-subtle)] transition-transform ${expanded ? "rotate-90" : ""}`} />
					<span className="text-sm font-medium text-[var(--inno-text)]">{t("settings.channels.title")}</span>
				</div>
				<div className="flex items-center gap-2 text-xs text-[var(--inno-text-subtle)]">
					{feishuEnabled && <span className="rounded bg-green-50 px-1.5 py-0.5 text-green-700">{t("settings.channels.feishu.title")}</span>}
					{qqEnabled && <span className="rounded bg-[var(--inno-accent-soft)] px-1.5 py-0.5 text-[var(--inno-accent)]">{t("settings.channels.qq.title")}</span>}
					{wechatEnabled && <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-700">{t("settings.channels.wechat.title")}</span>}
				</div>
			</button>
			{expanded && (
				<div className="px-4 pb-4 pt-1 grid gap-4">
					{/* Feishu */}
					<div className="rounded-lg border border-[var(--inno-border)] p-3">
						<div className="mb-2 flex items-center justify-between">
							<div>
								<div className="text-xs font-medium text-[var(--inno-text)]">{t("settings.channels.feishu.title")}</div>
								<div className="text-[10px] text-[var(--inno-text-subtle)]">{t("settings.channels.feishu.desc")}</div>
							</div>
								<label className="flex items-center gap-1.5 text-xs text-[var(--inno-text-muted)]">
								<ToggleSwitch checked={feishuEnabled} onChange={setFeishuEnabled} />
								{t("settings.channels.enabled")}
							</label>
						</div>
						{feishuEnabled && (
							<div className="grid grid-cols-2 gap-2">
								<div>
									<label className={labelCls}>{t("settings.channels.feishu.appId")}</label>
									<input className={inputCls} value={feishuAppId} onChange={(e) => setFeishuAppId(e.target.value)} />
								</div>
								<div>
									<label className={labelCls}>{t("settings.channels.feishu.appSecret")} {settings.feishu?.appSecret && <span className="text-[var(--inno-text-subtle)]">(••••)</span>}</label>
									<input className={inputCls} type="password" placeholder={t("settings.channels.feishu.appSecretHint") ?? ""} value={feishuAppSecret} onChange={(e) => setFeishuAppSecret(e.target.value)} />
								</div>
								<div className="col-span-2 flex items-center gap-3">
										<label className="flex items-center gap-1.5 text-xs text-[var(--inno-text-muted)]">
										<ToggleSwitch checked={feishuPersonalOnly} onChange={setFeishuPersonalOnly} />
										{t("settings.channels.personalOnly")}
									</label>
								</div>
								<div className="col-span-2">
									<label className={labelCls}>{t("settings.channels.allowedUserIds")}</label>
									<textarea className={`${inputCls} h-14 resize-y`} placeholder={t("settings.channels.allowedUserIdsHint") ?? ""} value={feishuAllowedUsers} onChange={(e) => setFeishuAllowedUsers(e.target.value)} />
								</div>
							</div>
						)}
					</div>

					{/* QQ */}
					<div className="rounded-lg border border-[var(--inno-border)] p-3">
						<div className="mb-2 flex items-center justify-between">
							<div>
								<div className="text-xs font-medium text-[var(--inno-text)]">{t("settings.channels.qq.title")}</div>
								<div className="text-[10px] text-[var(--inno-text-subtle)]">{t("settings.channels.qq.desc")}</div>
							</div>
								<label className="flex items-center gap-1.5 text-xs text-[var(--inno-text-muted)]">
								<ToggleSwitch checked={qqEnabled} onChange={setQqEnabled} />
								{t("settings.channels.enabled")}
							</label>
						</div>
						{qqEnabled && (
							<div className="grid grid-cols-2 gap-2">
								<div className="col-span-2">
									<label className={labelCls}>{t("settings.channels.sidecarBaseUrl")}</label>
									<input className={inputCls} value={qqSidecarUrl} onChange={(e) => setQqSidecarUrl(e.target.value)} />
								</div>
								<div className="col-span-2 flex items-center gap-3">
										<label className="flex items-center gap-1.5 text-xs text-[var(--inno-text-muted)]">
										<ToggleSwitch checked={qqPersonalOnly} onChange={setQqPersonalOnly} />
										{t("settings.channels.personalOnly")}
									</label>
								</div>
								<div className="col-span-2">
									<label className={labelCls}>{t("settings.channels.allowedUserIds")}</label>
									<textarea className={`${inputCls} h-14 resize-y`} placeholder={t("settings.channels.allowedUserIdsHint") ?? ""} value={qqAllowedUsers} onChange={(e) => setQqAllowedUsers(e.target.value)} />
								</div>
							</div>
						)}
					</div>

					{/* WeChat (iLink native) */}
					<div className="rounded-lg border border-[var(--inno-border)] p-3">
						<div className="mb-2 flex items-center justify-between">
							<div>
								<div className="text-xs font-medium text-[var(--inno-text)]">{t("settings.channels.wechat.title")}</div>
								<div className="text-[10px] text-[var(--inno-text-subtle)]">{t("settings.channels.wechat.desc")}</div>
							</div>
								<label className="flex items-center gap-1.5 text-xs text-[var(--inno-text-muted)]">
								<ToggleSwitch checked={wechatEnabled} onChange={setWechatEnabled} />
								{t("settings.channels.enabled")}
							</label>
						</div>
						{wechatEnabled && (
							<div className="grid gap-2">
								{/* Connection status */}
								<div className="flex items-center gap-2 rounded border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] px-2.5 py-2">
									{wxConnected ? (
										<>
											<Wifi size={14} className="text-green-600" />
											<span className="text-xs font-medium text-green-700">{t("settings.channels.wechat.connected")}</span>
											{wxBotId && <span className="text-[10px] text-[var(--inno-text-subtle)] ml-1">{t("settings.channels.wechat.botId")}: {wxBotId}</span>}
										</>
									) : (
										<>
											<WifiOff size={14} className="text-[var(--inno-text-subtle)]" />
											<span className="text-xs text-[var(--inno-text-muted)]">{t("settings.channels.wechat.disconnected")}</span>
										</>
									)}
								</div>

								{/* QR login area */}
								<div className="flex flex-col items-center gap-2 rounded border border-dashed border-[var(--inno-border)] bg-[var(--inno-surface)] p-3">
									{qrUrl && qrStatus !== "confirmed" && qrStatus !== "expired" && (
										<QRCodeSVG value={qrUrl} size={192} level="M" />
									)}
									{qrStatus === "confirmed" && (
										<div className="flex items-center gap-1.5 text-xs text-green-600">
											<CheckCircle size={14} />
											{t("settings.channels.wechat.confirmed")}
										</div>
									)}
									{qrStatus === "expired" && (
										<div className="text-xs text-amber-600">{t("settings.channels.wechat.expired")}</div>
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
										<button
											className="flex items-center gap-1.5 rounded-full inno-primary-button px-3 py-1.5 text-xs text-white"
											onClick={() => void startQrLogin()}
										>
											{wxConnected ? t("settings.channels.wechat.relogin") : t("settings.channels.wechat.scanLogin")}
										</button>
									)}
									{qrError && (
										<div className="rounded bg-red-50 px-2 py-1 text-xs text-red-700">{qrError}</div>
									)}
								</div>
								<div className="flex items-center gap-3">
										<label className="flex items-center gap-1.5 text-xs text-[var(--inno-text-muted)]">
										<ToggleSwitch checked={wechatPersonalOnly} onChange={setWechatPersonalOnly} />
										{t("settings.channels.personalOnly")}
									</label>
								</div>
								<div>
									<label className={labelCls}>{t("settings.channels.allowedUserIds")}</label>
									<textarea className={`${inputCls} h-14 resize-y`} placeholder={t("settings.channels.allowedUserIdsHint") ?? ""} value={wechatAllowedUsers} onChange={(e) => setWechatAllowedUsers(e.target.value)} />
								</div>
							</div>
						)}
					</div>

					{/* Bridge Token (used by QQ sidecar) */}
					{qqEnabled && (
						<div className="rounded-lg border border-[var(--inno-border)] p-3">
							<div className="text-xs font-medium text-[var(--inno-text)] mb-1">{t("settings.channels.bridgeToken")}</div>
							<div className="text-[10px] text-[var(--inno-text-subtle)] mb-2">{t("settings.channels.bridgeTokenHint")}</div>
							<input
								className={inputCls}
								type="password"
								placeholder={settings.bridge?.token ? t("settings.channels.bridgeTokenPlaceholder") ?? "" : ""}
								value={bridgeToken}
								onChange={(e) => setBridgeToken(e.target.value)}
							/>
							{settings.bridge?.token && <div className="mt-1 text-[10px] text-[var(--inno-text-subtle)]">({settings.bridge.token})</div>}
						</div>
					)}

					{formError && <div className="rounded bg-red-50 px-2 py-1 text-xs text-red-700">{formError}</div>}
					{saveMsg && <div className="rounded bg-green-50 px-2 py-1 text-xs text-green-700">{saveMsg}</div>}
					<button
						className="rounded-full inno-primary-button px-3 py-1.5 text-xs text-white disabled:opacity-50 justify-self-start"
						disabled={saving}
						onClick={() => void handleSave()}
					>
						{saving ? t("settings.channels.saving") : t("settings.channels.save")}
					</button>
				</div>
			)}
		</div>
	);
}

/* ---------- Content Hub (source for skill library + presets) ---------- */

function ContentHubSettings({ settings }: { settings: InnoSettings }) {
	const { t } = useTranslation();
	const hub = settings.contentHub;
	const [open, setOpen] = useState(false);
	const [type, setType] = useState<"github" | "bundle">(hub?.type ?? "github");
	const [owner, setOwner] = useState(hub?.owner ?? "");
	const [repo, setRepo] = useState(hub?.repo ?? "");
	const [ref, setRef] = useState(hub?.ref ?? "");
	const [skillsPath, setSkillsPath] = useState(hub?.skillsPath ?? "");
	const [presetsPath, setPresetsPath] = useState(hub?.presetsPath ?? "");
	const [baseUrl, setBaseUrl] = useState(hub?.baseUrl ?? "");
	const [token, setToken] = useState(hub?.token ?? "");
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);

	useEffect(() => {
		setType(hub?.type ?? "github");
		setOwner(hub?.owner ?? "");
		setRepo(hub?.repo ?? "");
		setRef(hub?.ref ?? "");
		setSkillsPath(hub?.skillsPath ?? "");
		setPresetsPath(hub?.presetsPath ?? "");
		setBaseUrl(hub?.baseUrl ?? "");
		setToken(hub?.token ?? "");
		setSaved(false);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [hub?.type, hub?.owner, hub?.repo, hub?.ref, hub?.skillsPath, hub?.presetsPath, hub?.baseUrl, hub?.token]);

	async function handleSave() {
		setSaving(true);
		setSaved(false);
		try {
			await settingsStore.saveContentHub({
				type,
				owner: owner.trim(),
				repo: repo.trim(),
				ref: ref.trim(),
				skillsPath: skillsPath.trim(),
				presetsPath: presetsPath.trim(),
				baseUrl: baseUrl.trim(),
				token: token.trim(),
			});
			setSaved(true);
		} catch {
			// error surfaced via store
		} finally {
			setSaving(false);
		}
	}

	const inputCls = "h-8 min-w-0 w-full rounded-md border border-[var(--inno-border)] px-2.5 text-xs text-[var(--inno-text)] placeholder:text-[var(--inno-text-subtle)] focus:border-blue-400 focus:outline-none";
	const sourceLabel = type === "github"
		? `GitHub · ${owner || "?"}/${repo || "?"}`
		: `${t("settings.contentHub.bundle", "自托管服务")} · ${baseUrl || "?"}`;

	return (
		<div className="min-w-0 border-b border-[var(--inno-border)] bg-[var(--inno-surface)] p-4">
			<button className="inno-settings-card-toggle flex w-full min-w-0 items-start gap-2 text-left" onClick={() => setOpen((v) => !v)}>
				<div className="min-w-0 flex-1">
					<h4 className="break-words text-sm font-medium text-[var(--inno-text)]">{t("settings.contentHub.title", "内容源(技能库 + 预设)")}</h4>
					<p className="mt-1 max-w-full break-words text-xs leading-relaxed text-[var(--inno-text-muted)]">
						{t("settings.contentHub.desc", "技能库和预设工作区从这里拉取。默认公共仓库,可改为私有 GitHub 仓库或自托管服务。")}
					</p>
					{!open && <p className="mt-1 break-all text-[11px] leading-relaxed text-[var(--inno-text-subtle)]">{sourceLabel}</p>}
				</div>
			</button>

			{open ? (
				<div className="mt-3 grid gap-2.5">
					{/* Type selector */}
					<div className="flex flex-wrap items-center gap-1.5">
						<button
							onClick={() => setType("github")}
							className={`flex h-7 items-center rounded-md border px-2.5 text-xs ${type === "github" ? "border-blue-400 bg-[var(--inno-accent-soft)] text-[var(--inno-accent)]" : "border-[var(--inno-border)] text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)]"}`}
						>
							GitHub
						</button>
						<button
							onClick={() => setType("bundle")}
							className={`flex h-7 items-center rounded-md border px-2.5 text-xs ${type === "bundle" ? "border-blue-400 bg-[var(--inno-accent-soft)] text-[var(--inno-accent)]" : "border-[var(--inno-border)] text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)]"}`}
						>
							{t("settings.contentHub.bundle", "自托管服务")}
						</button>
					</div>

					{type === "github" ? (
						<>
							<div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-2">
								<input className={inputCls} value={owner} onChange={(e) => { setOwner(e.target.value); setSaved(false); }} placeholder="owner" autoComplete="off" />
								<input className={inputCls} value={repo} onChange={(e) => { setRepo(e.target.value); setSaved(false); }} placeholder="repo" autoComplete="off" />
								<input className={inputCls} value={ref} onChange={(e) => { setRef(e.target.value); setSaved(false); }} placeholder="ref (main)" autoComplete="off" />
							</div>
							<div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-2">
								<input className={inputCls} value={skillsPath} onChange={(e) => { setSkillsPath(e.target.value); setSaved(false); }} placeholder="skill-library" autoComplete="off" />
								<input className={inputCls} value={presetsPath} onChange={(e) => { setPresetsPath(e.target.value); setSaved(false); }} placeholder="workspace-templates" autoComplete="off" />
							</div>
						</>
					) : (
						<input className={inputCls} value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); setSaved(false); }} placeholder="https://hub.example.com" autoComplete="off" />
					)}

					<div className="flex min-w-0 flex-wrap items-center gap-2">
						<input
							className={`${inputCls} flex-1 basis-44`}
							type="password"
							value={token}
							onChange={(e) => { setToken(e.target.value); setSaved(false); }}
							placeholder={t("settings.contentHub.tokenPlaceholder", "访问令牌(私有仓库 / 提额,可选)") ?? ""}
							autoComplete="off"
						/>
						<button
							disabled={saving}
							onClick={() => void handleSave()}
							className="flex h-8 shrink-0 items-center rounded-full inno-primary-button px-3 text-xs text-white disabled:opacity-50"
						>
							{saving ? t("common.loading") : saved ? t("settings.github.saved", "已保存") : t("common.save")}
						</button>
					</div>
				</div>
			) : null}
		</div>
	);
}

/* ---------- Memory Settings (L1/L2/L3 layer toggles) ---------- */

type MemoryLayer = "l1Enabled" | "l2Enabled" | "l3Enabled";

function MemoryToggleRow({
	enabled,
	saving,
	locked,
	title,
	desc,
	onToggle,
}: {
	enabled: boolean;
	saving: boolean;
	locked?: boolean;
	title: string;
	desc: string;
	onToggle: (next: boolean) => void;
}) {
	// In Simple Mode the layers are force-locked OFF; show them as off + disabled.
	const shown = locked ? false : enabled;
	return (
		<div className={`flex items-start justify-between gap-3 ${locked ? "opacity-60" : ""}`}>
			<div className="min-w-0">
				<h4 className="text-sm font-medium text-[var(--inno-text)]">{title}</h4>
				<p className="mt-1 text-xs text-[var(--inno-text-muted)]">{desc}</p>
			</div>
			<button
				role="switch"
				aria-checked={shown}
				disabled={saving || locked}
				onClick={() => onToggle(!enabled)}
				className={`relative mt-0.5 inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${shown ? "bg-[var(--inno-accent)]" : "bg-slate-300"}`}
			>
				<span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-[var(--inno-surface)] transition-transform ${shown ? "translate-x-[18px]" : "translate-x-1"}`} />
			</button>
		</div>
	);
}

function MemorySettings({ settings }: { settings: InnoSettings }) {
	const { t } = useTranslation();
	const locked = settings.simpleMode?.enabled === true;
	const initial = {
		l1Enabled: settings.memory?.l1Enabled !== false,
		l2Enabled: settings.memory?.l2Enabled !== false,
		l3Enabled: settings.memory?.l3Enabled !== false,
	};
	const [state, setState] = useState(initial);
	const [savingKey, setSavingKey] = useState<MemoryLayer | null>(null);

	useEffect(() => {
		setState({
			l1Enabled: settings.memory?.l1Enabled !== false,
			l2Enabled: settings.memory?.l2Enabled !== false,
			l3Enabled: settings.memory?.l3Enabled !== false,
		});
	}, [settings.memory?.l1Enabled, settings.memory?.l2Enabled, settings.memory?.l3Enabled]);

	async function handleToggle(key: MemoryLayer, next: boolean) {
		setState((s) => ({ ...s, [key]: next }));
		setSavingKey(key);
		try {
			await settingsStore.saveMemory({ [key]: next });
		} catch {
			setState((s) => ({ ...s, [key]: !next }));
		} finally {
			setSavingKey(null);
		}
	}

	const layers: { key: MemoryLayer; ns: "l1" | "l2" | "memory" }[] = [
		{ key: "l1Enabled", ns: "l1" },
		{ key: "l2Enabled", ns: "l2" },
		{ key: "l3Enabled", ns: "memory" },
	];

	return (
		<div className="border-b border-[var(--inno-border)] bg-[var(--inno-surface)] p-4">
			<h4 className="mb-3 text-sm font-medium text-[var(--inno-text)]">{t("settings.memorySection")}</h4>
			{locked ? <p className="mb-3 text-xs text-amber-600">{t("settings.simpleMode.memoryLocked")}</p> : null}
			<div className="grid gap-4">
				{layers.map(({ key, ns }) => {
					const enabled = state[key];
					return (
						<MemoryToggleRow
							key={key}
							enabled={enabled}
							saving={savingKey === key}
							locked={locked}
							title={t(`settings.${ns}.title`)}
							desc={enabled ? t(`settings.${ns}.onDesc`) : t(`settings.${ns}.offDesc`)}
							onToggle={(next) => void handleToggle(key, next)}
						/>
					);
				})}
			</div>
		</div>
	);
}

/* ---------- Simple Mode (streamlined experience) ---------- */

function SimpleModeSettings({ settings }: { settings: InnoSettings }) {
	const { t } = useTranslation();
	const [enabled, setEnabled] = useState(settings.simpleMode?.enabled === true);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		setEnabled(settings.simpleMode?.enabled === true);
	}, [settings.simpleMode?.enabled]);

	async function handleToggle(next: boolean) {
		setEnabled(next);
		setSaving(true);
		try {
			await settingsStore.saveSimpleMode(next);
		} catch {
			setEnabled(!next);
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="border-b border-[var(--inno-border)] bg-[var(--inno-surface)] p-4">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<h4 className="text-sm font-medium text-[var(--inno-text)]">{t("settings.simpleMode.title")}</h4>
					<p className="mt-1 text-xs leading-relaxed text-[var(--inno-text-muted)]">
						{enabled ? t("settings.simpleMode.onDesc") : t("settings.simpleMode.offDesc")}
					</p>
				</div>
				<button
					role="switch"
					aria-checked={enabled}
					disabled={saving}
					onClick={() => void handleToggle(!enabled)}
					className={`relative mt-0.5 inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${enabled ? "bg-[var(--inno-accent)]" : "bg-slate-300"}`}
				>
					<span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-[var(--inno-surface)] transition-transform ${enabled ? "translate-x-[18px]" : "translate-x-1"}`} />
				</button>
			</div>
		</div>
	);
}

/* ---------- Main SettingsPanel ---------- */

export function SettingsPanel() {
	const { t, i18n } = useTranslation();
	const [healthOk, setHealthOk] = useState(false);
	const [wikiStats, setWikiStats] = useState<WikiStats | null>(null);
	const [editingModel, setEditingModel] = useState<string | null>(null);
	const state = useStoreSnapshot(settingsStore, () => ({
		settings: settingsStore.settings,
		isLoading: settingsStore.isLoading,
		isSavingModel: settingsStore.isSavingModel,
		isSavingProvider: settingsStore.isSavingProvider,
		error: settingsStore.error,
	}));
	const simpleMode = state.settings?.simpleMode?.enabled === true;

	useEffect(() => {
		void settingsStore.load();
		void fetch("/api/health").then((res) => setHealthOk(res.ok)).catch(() => setHealthOk(false));
		void getWikiStats().then(setWikiStats).catch(() => setWikiStats(null));
	}, []);

	const models = state.settings?.availableModels ?? state.settings?.configuredModels ?? [];

	return (
		<div className="h-full overflow-y-auto p-0">
			<div className="grid gap-0">
				{/* Status cards */}
				<div className="border-b border-[var(--inno-border)] bg-[var(--inno-surface)] p-4">
					<div className="mb-3 flex items-center justify-between">
						<h3 className="text-sm font-medium text-[var(--inno-text)]">{t("settings.title")}</h3>
						<div className="flex items-center gap-2">
							<ThemeSettings />
							<label className="flex items-center gap-1.5 text-xs text-[var(--inno-text-muted)]">
								<span>{t("settings.language")}</span>
								<select
									className="rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2 py-1 text-xs"
									value={i18n.language}
									onChange={(e) => setLocale(e.target.value as "zh-CN" | "en")}
								>
									<option value="zh-CN">{t("settings.languageOptions.zh-CN")}</option>
									<option value="en">{t("settings.languageOptions.en")}</option>
								</select>
							</label>
							<button className="rounded-full inno-primary-button px-3 py-1.5 text-sm" onClick={() => void settingsStore.load()}>
								{t("settings.refresh")}
							</button>
						</div>
					</div>
					{state.isLoading ? <div className="text-sm text-[var(--inno-text-muted)]">{t("settings.loading")}</div> : null}
					{state.error ? <div className="rounded bg-red-50 p-2 text-sm text-red-700">{state.error}</div> : null}
					<div className="grid grid-cols-3 gap-3 text-sm">
						<div className="rounded border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] p-3">
							<div className="text-xs text-[var(--inno-text-muted)]">{t("settings.stats.server")}</div>
							<div className={healthOk ? "font-medium text-green-700" : "font-medium text-red-600"}>
								{healthOk ? t("settings.stats.healthy") : t("settings.stats.offline")}
							</div>
						</div>
						<div className="rounded border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] p-3">
							<div className="text-xs text-[var(--inno-text-muted)]">{t("settings.stats.defaultModel")}</div>
							<div className="font-medium text-[var(--inno-text)]">{state.settings ? `${state.settings.defaultProvider}/${state.settings.defaultModel}` : "-"}</div>
						</div>
						<div className="rounded border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] p-3">
							<div className="text-xs text-[var(--inno-text-muted)]">{t("settings.stats.wiki")}</div>
							<div className="font-medium text-[var(--inno-text)]">
								{wikiStats ? t("settings.stats.wikiStat", { count: wikiStats.pageCount, size: formatBytes(wikiStats.totalSize) }) : "-"}
							</div>
						</div>
					</div>
				</div>

				{/* Models */}
				<div className="border-b border-[var(--inno-border)] bg-[var(--inno-surface)] p-4">
					<h4 className="mb-3 text-sm font-medium text-[var(--inno-text)]">{t("settings.models")}</h4>
					<div className="grid gap-2">
						{models.map((model) => {
							const key = modelKey(model);
							const current = state.settings?.defaultProvider === model.provider && state.settings?.defaultModel === model.id;
							const isEditing = editingModel === key;

							if (isEditing && state.settings) {
								return (
									<ModelEditForm
										key={key}
										model={model}
										settings={state.settings}
										onClose={() => setEditingModel(null)}
									/>
								);
							}

							return (
								<div key={key} className={`group flex items-center justify-between rounded border p-3 ${current ? "border-[var(--inno-accent-soft)] bg-[var(--inno-accent-soft)]" : "border-[var(--inno-border)] bg-[var(--inno-surface)]"}`}>
									<div className="min-w-0 flex-1">
										<div className="text-sm font-medium text-[var(--inno-text)]">{model.name || model.id}</div>
										<div className="text-xs text-[var(--inno-text-muted)]">{model.provider} · {formatTokens(model.contextWindow)} context · {formatTokens(model.maxTokens)} max</div>
									</div>
									<div className="flex items-center gap-1.5">
										<button
											className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--inno-text-subtle)] opacity-0 transition-opacity hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)] group-hover:opacity-100"
											title={t("common.edit", "Edit")}
											onClick={() => setEditingModel(key)}
										>
											<Pencil size={13} />
										</button>
										<button
											className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--inno-text-subtle)] opacity-0 transition-opacity hover:bg-red-50 hover:text-red-600 group-hover:opacity-100"
											title={t("common.delete", "Delete")}
											onClick={() => {
												if (window.confirm(t("settings.confirmDelete", { id: `${model.provider}/${model.id}` }) ?? "")) {
													void settingsStore.deleteModel(model.provider, model.id);
												}
											}}
										>
											<Trash2 size={13} />
										</button>
										{!current && (
											<button
												className="rounded-full border border-[var(--inno-border)] px-2.5 py-1 text-xs text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]"
												disabled={state.isSavingModel}
												onClick={() => void settingsStore.switchModel(model.provider, model.id)}
											>
												{t("settings.use")}
											</button>
										)}
										{current && <span className="rounded-md bg-[var(--inno-accent-soft)] px-2.5 py-1 text-xs font-medium text-[var(--inno-accent)]">{t("settings.current")}</span>}
									</div>
								</div>
							);
						})}
					</div>
				</div>

				{/* Simple Mode (streamlined experience; force-locks memory off) */}
				{state.settings && <SimpleModeSettings settings={state.settings} />}

				{/* Advanced sections — hidden in Simple Mode for a streamlined panel */}
				{!simpleMode && (
					<>
						{/* New Provider (collapsed by default) */}
						<NewProviderForm />

						{/* Memory Settings (L3 cross-conversation recall) */}
						{state.settings && <MemorySettings settings={state.settings} />}

						{/* Content Hub (source for skill library + presets; subsumes the
						    legacy GitHub token) */}
						{state.settings && <ContentHubSettings settings={state.settings} />}

						{/* Channels Settings */}
						{state.settings && <ChannelsSettings settings={state.settings} />}
					</>
				)}
			</div>
		</div>
	);
}
