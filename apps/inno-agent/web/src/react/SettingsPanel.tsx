import { useEffect, useState, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Trash2, Pencil, X, ChevronDown, ChevronRight, Plus, QrCode as QrCodeIcon, CheckCircle, Wifi, WifiOff, KeyRound } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { getWikiStats } from "../api/wiki.js";
import { settingsStore } from "../stores/settings-store.js";
import { wechatQrLogin, wechatQrStatus, wechatStatus } from "../api/settings.js";
import type { InnoModelInfo, InnoProviderModel as ProviderModel, InnoSettings, ChannelsSettingsPayload, PersonalBridgeChannelConfig } from "../types/settings.js";
import type { WikiStats } from "../types/wiki.js";
import { useStoreSnapshot } from "./hooks.js";
import { setLocale } from "../i18n/index.js";

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
		<div className="rounded-lg border border-blue-200 bg-blue-50/50 p-3">
			<div className="mb-2 flex items-center justify-between">
				<span className="text-xs font-medium text-slate-700">{t("settings.editModel", "Edit Model")}</span>
				<button className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-200 hover:text-slate-700" onClick={onClose}><X size={14} /></button>
			</div>
			<div className="grid grid-cols-2 gap-2">
				<div>
					<label className="mb-0.5 block text-[10px] text-slate-500">{t("settings.form.providerId")}</label>
					<input className="w-full rounded-md border border-slate-200 bg-slate-100 px-2.5 py-1.5 text-xs text-slate-500" value={form.providerId} readOnly />
				</div>
				<div>
					<label className="mb-0.5 block text-[10px] text-slate-500">{t("settings.form.apiType", "API Type")}</label>
					<select className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-xs" value={form.api} onChange={(e) => setForm({ ...form, api: e.target.value })}>
						{apiOptions.map((api) => <option key={api} value={api}>{api}</option>)}
					</select>
				</div>
				<div className="col-span-2">
					<label className="mb-0.5 block text-[10px] text-slate-500">{t("settings.form.baseUrl")}</label>
					<input className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-xs" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
				</div>
				<div className="col-span-2">
					<label className="mb-0.5 block text-[10px] text-slate-500">{t("settings.form.apiKey")} {maskedKey && <span className="text-slate-400">({maskedKey})</span>}</label>
					<input className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-xs" type="password" placeholder={form.preserveApiKey ? t("settings.form.apiKeyPreserved", "Leave empty to keep current key") ?? "" : ""} value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />
				</div>
				<div>
					<label className="mb-0.5 block text-[10px] text-slate-500">{t("settings.form.modelId")}</label>
					<input className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-xs" value={form.modelId} onChange={(e) => setForm({ ...form, modelId: e.target.value })} />
				</div>
				<div>
					<label className="mb-0.5 block text-[10px] text-slate-500">{t("settings.form.modelName")}</label>
					<input className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-xs" value={form.modelName} onChange={(e) => setForm({ ...form, modelName: e.target.value })} />
				</div>
				<div>
					<label className="mb-0.5 block text-[10px] text-slate-500">{t("settings.form.contextWindow")}</label>
					<input className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-xs" value={form.contextWindow} onChange={(e) => setForm({ ...form, contextWindow: e.target.value })} />
				</div>
				<div>
					<label className="mb-0.5 block text-[10px] text-slate-500">{t("settings.form.maxTokens")}</label>
					<input className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-xs" value={form.maxTokens} onChange={(e) => setForm({ ...form, maxTokens: e.target.value })} />
				</div>
			</div>
			<div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-slate-600">
				<label className="flex items-center gap-1.5"><input type="checkbox" className="h-3.5 w-3.5" checked={form.reasoning} onChange={(e) => setForm({ ...form, reasoning: e.target.checked })} /> {t("settings.form.reasoning")}</label>
				<label className="flex items-center gap-1.5"><input type="checkbox" className="h-3.5 w-3.5" checked={form.makeDefault} onChange={(e) => setForm({ ...form, makeDefault: e.target.checked })} /> {t("settings.form.makeDefault")}</label>
				<label className="flex items-center gap-1.5"><input type="checkbox" className="h-3.5 w-3.5" checked={form.preserveApiKey} onChange={(e) => setForm({ ...form, preserveApiKey: e.target.checked })} /> {t("settings.form.preserveApiKey")}</label>
			</div>
			{formError ? <div className="mt-2 rounded bg-red-50 px-2 py-1 text-xs text-red-700">{formError}</div> : null}
			<div className="mt-2 flex gap-2">
				<button className="rounded-md bg-slate-900 px-3 py-1.5 text-xs text-white hover:bg-slate-800 disabled:opacity-50" disabled={saving} onClick={() => void handleSave()}>
					{saving ? t("settings.savingProvider") : t("settings.saveProvider")}
				</button>
				<button className="rounded-md border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50" onClick={onClose}>
					{t("common.cancel", "Cancel")}
				</button>
			</div>
		</div>
	);
}

/* ---------- New Provider Form (collapsible) ---------- */

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
		<div className="rounded-lg border border-slate-200 bg-white">
			<button
				className="flex w-full items-center justify-between px-4 py-3 text-left"
				onClick={() => { setExpanded((v) => !v); setFormError(null); setSaveMessage(null); }}
			>
				<div className="flex items-center gap-2">
					{expanded ? <ChevronDown size={14} className="text-slate-400" /> : <ChevronRight size={14} className="text-slate-400" />}
					<span className="text-sm font-medium text-slate-950">{t("settings.newProvider")}</span>
				</div>
				<Plus size={14} className="text-slate-400" />
			</button>
			{expanded && (
				<div className="border-t border-slate-100 px-4 pb-4 pt-3">
					<div className="grid grid-cols-2 gap-2">
						<div>
							<label className="mb-0.5 block text-[10px] text-slate-500">{t("settings.form.providerId")}</label>
							<input className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-xs" placeholder={t("settings.form.providerId") ?? ""} value={form.providerId} onChange={(e) => setForm({ ...form, providerId: e.target.value })} />
						</div>
						<div>
							<label className="mb-0.5 block text-[10px] text-slate-500">{t("settings.form.apiType", "API Type")}</label>
							<select className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-xs" value={form.api} onChange={(e) => setForm({ ...form, api: e.target.value })}>
								{apiOptions.map((api) => <option key={api} value={api}>{api}</option>)}
							</select>
						</div>
						<div className="col-span-2">
							<label className="mb-0.5 block text-[10px] text-slate-500">{t("settings.form.baseUrl")}</label>
							<input className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-xs" placeholder={t("settings.form.baseUrl") ?? ""} value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
						</div>
						<div className="col-span-2">
							<label className="mb-0.5 block text-[10px] text-slate-500">{t("settings.form.apiKey")}</label>
							<input className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-xs" type="password" placeholder={t("settings.form.apiKey") ?? ""} value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />
						</div>
						<div>
							<label className="mb-0.5 block text-[10px] text-slate-500">{t("settings.form.modelId")}</label>
							<input className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-xs" placeholder={t("settings.form.modelId") ?? ""} value={form.modelId} onChange={(e) => setForm({ ...form, modelId: e.target.value })} />
						</div>
						<div>
							<label className="mb-0.5 block text-[10px] text-slate-500">{t("settings.form.modelName")}</label>
							<input className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-xs" placeholder={t("settings.form.modelName") ?? ""} value={form.modelName} onChange={(e) => setForm({ ...form, modelName: e.target.value })} />
						</div>
						<div>
							<label className="mb-0.5 block text-[10px] text-slate-500">{t("settings.form.contextWindow")}</label>
							<input className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-xs" value={form.contextWindow} onChange={(e) => setForm({ ...form, contextWindow: e.target.value })} />
						</div>
						<div>
							<label className="mb-0.5 block text-[10px] text-slate-500">{t("settings.form.maxTokens")}</label>
							<input className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-xs" value={form.maxTokens} onChange={(e) => setForm({ ...form, maxTokens: e.target.value })} />
						</div>
					</div>
					<div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-slate-600">
						<label className="flex items-center gap-1.5"><input type="checkbox" className="h-3.5 w-3.5" checked={form.reasoning} onChange={(e) => setForm({ ...form, reasoning: e.target.checked })} /> {t("settings.form.reasoning")}</label>
						<label className="flex items-center gap-1.5"><input type="checkbox" className="h-3.5 w-3.5" checked={form.makeDefault} onChange={(e) => setForm({ ...form, makeDefault: e.target.checked })} /> {t("settings.form.makeDefault")}</label>
					</div>
					{formError ? <div className="mt-2 rounded bg-red-50 px-2 py-1 text-xs text-red-700">{formError}</div> : null}
					{saveMessage ? <div className="mt-2 rounded bg-green-50 px-2 py-1 text-xs text-green-700">{saveMessage}</div> : null}
					<button className="mt-3 rounded-md bg-slate-900 px-3 py-1.5 text-xs text-white hover:bg-slate-800 disabled:opacity-50" disabled={saving} onClick={() => void handleSave()}>
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

	const inputCls = "w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-xs";
	const labelCls = "mb-0.5 block text-[10px] text-slate-500";
	const checkCls = "flex items-center gap-1.5 text-xs text-slate-600";

	return (
		<div className="rounded-lg border border-slate-200 bg-white">
			<button
				className="flex w-full items-center justify-between px-4 py-3 text-left"
				onClick={() => { setExpanded((v) => !v); setFormError(null); setSaveMsg(null); }}
			>
				<div className="flex items-center gap-2">
					{expanded ? <ChevronDown size={14} className="text-slate-400" /> : <ChevronRight size={14} className="text-slate-400" />}
					<span className="text-sm font-medium text-slate-950">{t("settings.channels.title")}</span>
				</div>
				<div className="flex items-center gap-2 text-xs text-slate-400">
					{feishuEnabled && <span className="rounded bg-green-50 px-1.5 py-0.5 text-green-700">{t("settings.channels.feishu.title")}</span>}
					{qqEnabled && <span className="rounded bg-blue-50 px-1.5 py-0.5 text-blue-700">{t("settings.channels.qq.title")}</span>}
					{wechatEnabled && <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-700">{t("settings.channels.wechat.title")}</span>}
				</div>
			</button>
			{expanded && (
				<div className="border-t border-slate-100 px-4 pb-4 pt-3 grid gap-4">
					{/* Feishu */}
					<div className="rounded-lg border border-slate-100 p-3">
						<div className="mb-2 flex items-center justify-between">
							<div>
								<div className="text-xs font-medium text-slate-950">{t("settings.channels.feishu.title")}</div>
								<div className="text-[10px] text-slate-400">{t("settings.channels.feishu.desc")}</div>
							</div>
							<label className={checkCls}>
								<input type="checkbox" className="h-3.5 w-3.5" checked={feishuEnabled} onChange={(e) => setFeishuEnabled(e.target.checked)} />
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
									<label className={labelCls}>{t("settings.channels.feishu.appSecret")} {settings.feishu?.appSecret && <span className="text-slate-400">(••••)</span>}</label>
									<input className={inputCls} type="password" placeholder={t("settings.channels.feishu.appSecretHint") ?? ""} value={feishuAppSecret} onChange={(e) => setFeishuAppSecret(e.target.value)} />
								</div>
								<div className="col-span-2 flex items-center gap-3">
									<label className={checkCls}>
										<input type="checkbox" className="h-3.5 w-3.5" checked={feishuPersonalOnly} onChange={(e) => setFeishuPersonalOnly(e.target.checked)} />
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
					<div className="rounded-lg border border-slate-100 p-3">
						<div className="mb-2 flex items-center justify-between">
							<div>
								<div className="text-xs font-medium text-slate-950">{t("settings.channels.qq.title")}</div>
								<div className="text-[10px] text-slate-400">{t("settings.channels.qq.desc")}</div>
							</div>
							<label className={checkCls}>
								<input type="checkbox" className="h-3.5 w-3.5" checked={qqEnabled} onChange={(e) => setQqEnabled(e.target.checked)} />
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
									<label className={checkCls}>
										<input type="checkbox" className="h-3.5 w-3.5" checked={qqPersonalOnly} onChange={(e) => setQqPersonalOnly(e.target.checked)} />
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
					<div className="rounded-lg border border-slate-100 p-3">
						<div className="mb-2 flex items-center justify-between">
							<div>
								<div className="text-xs font-medium text-slate-950">{t("settings.channels.wechat.title")}</div>
								<div className="text-[10px] text-slate-400">{t("settings.channels.wechat.desc")}</div>
							</div>
							<label className={checkCls}>
								<input type="checkbox" className="h-3.5 w-3.5" checked={wechatEnabled} onChange={(e) => setWechatEnabled(e.target.checked)} />
								{t("settings.channels.enabled")}
							</label>
						</div>
						{wechatEnabled && (
							<div className="grid gap-2">
								{/* Connection status */}
								<div className="flex items-center gap-2 rounded border border-slate-100 bg-slate-50 px-2.5 py-2">
									{wxConnected ? (
										<>
											<Wifi size={14} className="text-green-600" />
											<span className="text-xs font-medium text-green-700">{t("settings.channels.wechat.connected")}</span>
											{wxBotId && <span className="text-[10px] text-slate-400 ml-1">{t("settings.channels.wechat.botId")}: {wxBotId}</span>}
										</>
									) : (
										<>
											<WifiOff size={14} className="text-slate-400" />
											<span className="text-xs text-slate-500">{t("settings.channels.wechat.disconnected")}</span>
										</>
									)}
								</div>

								{/* QR login area */}
								<div className="flex flex-col items-center gap-2 rounded border border-dashed border-slate-200 bg-white p-3">
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
										<div className="text-xs text-slate-400">{t("settings.channels.wechat.scanning")}</div>
									)}
									{qrStatus === "waitingScan" && (
										<div className="text-xs text-slate-500">{t("settings.channels.wechat.waitingScan")}</div>
									)}
									{qrStatus === "scanned" && (
										<div className="text-xs text-blue-600">{t("settings.channels.wechat.scanned")}</div>
									)}
									{(!qrStatus || qrStatus === "confirmed" || qrStatus === "expired") && (
										<button
											className="flex items-center gap-1.5 rounded-md bg-slate-900 px-3 py-1.5 text-xs text-white hover:bg-slate-800"
											onClick={() => void startQrLogin()}
										>
											<QrCodeIcon size={13} />
											{wxConnected ? t("settings.channels.wechat.relogin") : t("settings.channels.wechat.scanLogin")}
										</button>
									)}
									{qrError && (
										<div className="rounded bg-red-50 px-2 py-1 text-xs text-red-700">{qrError}</div>
									)}
								</div>
								<div className="flex items-center gap-3">
									<label className={checkCls}>
										<input type="checkbox" className="h-3.5 w-3.5" checked={wechatPersonalOnly} onChange={(e) => setWechatPersonalOnly(e.target.checked)} />
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
						<div className="rounded-lg border border-slate-100 p-3">
							<div className="text-xs font-medium text-slate-950 mb-1">{t("settings.channels.bridgeToken")}</div>
							<div className="text-[10px] text-slate-400 mb-2">{t("settings.channels.bridgeTokenHint")}</div>
							<input
								className={inputCls}
								type="password"
								placeholder={settings.bridge?.token ? t("settings.channels.bridgeTokenPlaceholder") ?? "" : ""}
								value={bridgeToken}
								onChange={(e) => setBridgeToken(e.target.value)}
							/>
							{settings.bridge?.token && <div className="mt-1 text-[10px] text-slate-400">({settings.bridge.token})</div>}
						</div>
					)}

					{formError && <div className="rounded bg-red-50 px-2 py-1 text-xs text-red-700">{formError}</div>}
					{saveMsg && <div className="rounded bg-green-50 px-2 py-1 text-xs text-green-700">{saveMsg}</div>}
					<button
						className="rounded-md bg-slate-900 px-3 py-1.5 text-xs text-white hover:bg-slate-800 disabled:opacity-50 justify-self-start"
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

/* ---------- GitHub Settings (token to raise skill-library API rate limit) ---------- */

function GithubSettings({ settings }: { settings: InnoSettings }) {
	const { t } = useTranslation();
	const hasToken = Boolean(settings.github?.token);
	const [token, setToken] = useState(settings.github?.token ?? "");
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);

	useEffect(() => {
		setToken(settings.github?.token ?? "");
		setSaved(false);
	}, [settings.github?.token]);

	const dirty = token !== (settings.github?.token ?? "");

	async function handleSave() {
		setSaving(true);
		setSaved(false);
		try {
			await settingsStore.saveGithub(token.trim());
			setSaved(true);
		} catch {
			// error surfaced via store
		} finally {
			setSaving(false);
		}
	}

	async function handleClear() {
		setSaving(true);
		setSaved(false);
		try {
			await settingsStore.saveGithub("");
			setToken("");
		} catch {
			// error surfaced via store
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="rounded-lg border border-slate-200 bg-white p-4">
			<div className="flex items-start gap-2">
				<KeyRound size={16} className="mt-0.5 shrink-0 text-slate-700" />
				<div className="min-w-0 flex-1">
					<h4 className="text-sm font-medium text-slate-950">{t("settings.github.title")}</h4>
					<p className="mt-1 text-xs leading-relaxed text-slate-500">{t("settings.github.desc")}</p>
					<div className="mt-3 flex items-center gap-2">
						<input
							type="password"
							value={token}
							onChange={(e) => { setToken(e.target.value); setSaved(false); }}
							placeholder={t("settings.github.placeholder")}
							autoComplete="off"
							className="h-8 min-w-0 flex-1 rounded-md border border-slate-200 px-2.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none"
						/>
						<button
							disabled={saving || !dirty || !token.trim()}
							onClick={() => void handleSave()}
							className="flex h-8 shrink-0 items-center rounded-md bg-slate-900 px-3 text-xs text-white hover:bg-slate-800 disabled:opacity-50"
						>
							{saving ? t("common.loading") : saved ? t("settings.github.saved") : t("common.save")}
						</button>
						{hasToken && (
							<button
								disabled={saving}
								onClick={() => void handleClear()}
								className="flex h-8 shrink-0 items-center rounded-md border border-slate-200 px-3 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
							>
								{t("settings.github.clear")}
							</button>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}

/* ---------- Memory Settings (L3 cross-conversation recall toggle) ---------- */

function MemorySettings({ settings }: { settings: InnoSettings }) {
	const { t } = useTranslation();
	const [enabled, setEnabled] = useState(settings.memory?.l3Enabled !== false);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		setEnabled(settings.memory?.l3Enabled !== false);
	}, [settings.memory?.l3Enabled]);

	async function handleToggle(next: boolean) {
		setEnabled(next);
		setSaving(true);
		try {
			await settingsStore.saveMemory(next);
		} catch {
			setEnabled(!next);
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="rounded-lg border border-slate-200 bg-white p-4">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<h4 className="text-sm font-medium text-slate-950">{t("settings.memory.title")}</h4>
					<p className="mt-1 text-xs text-slate-500">
						{enabled ? t("settings.memory.onDesc") : t("settings.memory.offDesc")}
					</p>
				</div>
				<button
					role="switch"
					aria-checked={enabled}
					disabled={saving}
					onClick={() => void handleToggle(!enabled)}
					className={`relative mt-0.5 inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${enabled ? "bg-blue-600" : "bg-slate-300"}`}
				>
					<span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${enabled ? "translate-x-[18px]" : "translate-x-1"}`} />
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

	useEffect(() => {
		void settingsStore.load();
		void fetch("/health").then((res) => setHealthOk(res.ok)).catch(() => setHealthOk(false));
		void getWikiStats().then(setWikiStats).catch(() => setWikiStats(null));
	}, []);

	const models = state.settings?.availableModels ?? state.settings?.configuredModels ?? [];

	return (
		<div className="h-full overflow-y-auto p-3">
			<div className="grid gap-3">
				{/* Status cards */}
				<div className="rounded-lg border border-slate-200 bg-white p-4">
					<div className="mb-3 flex items-center justify-between">
						<h3 className="text-sm font-medium text-slate-950">{t("settings.title")}</h3>
						<div className="flex items-center gap-2">
							<label className="flex items-center gap-1.5 text-xs text-slate-500">
								<span>{t("settings.language")}</span>
								<select
									className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs"
									value={i18n.language}
									onChange={(e) => setLocale(e.target.value as "zh-CN" | "en")}
								>
									<option value="zh-CN">{t("settings.languageOptions.zh-CN")}</option>
									<option value="en">{t("settings.languageOptions.en")}</option>
								</select>
							</label>
							<button className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-100 hover:text-slate-950" onClick={() => void settingsStore.load()}>
								{t("settings.refresh")}
							</button>
						</div>
					</div>
					{state.isLoading ? <div className="text-sm text-slate-500">{t("settings.loading")}</div> : null}
					{state.error ? <div className="rounded bg-red-50 p-2 text-sm text-red-700">{state.error}</div> : null}
					<div className="grid grid-cols-3 gap-3 text-sm">
						<div className="rounded border border-slate-200 bg-slate-50 p-3">
							<div className="text-xs text-slate-500">{t("settings.stats.server")}</div>
							<div className={healthOk ? "font-medium text-green-700" : "font-medium text-red-600"}>
								{healthOk ? t("settings.stats.healthy") : t("settings.stats.offline")}
							</div>
						</div>
						<div className="rounded border border-slate-200 bg-slate-50 p-3">
							<div className="text-xs text-slate-500">{t("settings.stats.defaultModel")}</div>
							<div className="font-medium text-slate-950">{state.settings ? `${state.settings.defaultProvider}/${state.settings.defaultModel}` : "-"}</div>
						</div>
						<div className="rounded border border-slate-200 bg-slate-50 p-3">
							<div className="text-xs text-slate-500">{t("settings.stats.wiki")}</div>
							<div className="font-medium text-slate-950">
								{wikiStats ? t("settings.stats.wikiStat", { count: wikiStats.pageCount, size: formatBytes(wikiStats.totalSize) }) : "-"}
							</div>
						</div>
					</div>
				</div>

				{/* Models */}
				<div className="rounded-lg border border-slate-200 bg-white p-4">
					<h4 className="mb-3 text-sm font-medium text-slate-950">{t("settings.models")}</h4>
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
								<div key={key} className={`group flex items-center justify-between rounded border p-3 ${current ? "border-blue-200 bg-blue-50" : "border-slate-200 bg-white"}`}>
									<div className="min-w-0 flex-1">
										<div className="text-sm font-medium text-slate-950">{model.name || model.id}</div>
										<div className="text-xs text-slate-500">{model.provider} · {formatTokens(model.contextWindow)} context · {formatTokens(model.maxTokens)} max</div>
									</div>
									<div className="flex items-center gap-1.5">
										<button
											className="flex h-7 w-7 items-center justify-center rounded text-slate-400 opacity-0 transition-opacity hover:bg-slate-100 hover:text-slate-700 group-hover:opacity-100"
											title={t("common.edit", "Edit")}
											onClick={() => setEditingModel(key)}
										>
											<Pencil size={13} />
										</button>
										<button
											className="flex h-7 w-7 items-center justify-center rounded text-slate-400 opacity-0 transition-opacity hover:bg-red-50 hover:text-red-600 group-hover:opacity-100"
											title={t("common.delete", "Delete")}
											onClick={() => {
												if (window.confirm(t("settings.confirmDelete", { id: `${model.provider}/${model.id}` }) ?? "")) {
													void settingsStore.deleteProvider(model.provider);
												}
											}}
										>
											<Trash2 size={13} />
										</button>
										{!current && (
											<button
												className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-500 hover:bg-slate-100 hover:text-slate-950"
												disabled={state.isSavingModel}
												onClick={() => void settingsStore.switchModel(model.provider, model.id)}
											>
												{t("settings.use")}
											</button>
										)}
										{current && <span className="rounded-md bg-blue-100 px-2.5 py-1 text-xs font-medium text-blue-700">{t("settings.current")}</span>}
									</div>
								</div>
							);
						})}
					</div>
				</div>

				{/* New Provider (collapsed by default) */}
				<NewProviderForm />

				{/* Memory Settings (L3 cross-conversation recall) */}
				{state.settings && <MemorySettings settings={state.settings} />}

				{/* GitHub token (raises skill-library API rate limit) */}
				{state.settings && <GithubSettings settings={state.settings} />}

				{/* Channels Settings */}
				{state.settings && <ChannelsSettings settings={state.settings} />}
			</div>
		</div>
	);
}
