import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Database, KeyRound, Globe, Search } from "lucide-react";
import { settingsStore } from "../../stores/settings-store.js";
import { getWebAccessSettings, saveWebAccessSettings } from "../../api/settings.js";
import type { InnoSettings, WebAccessSettings } from "../../types/settings.js";
import { inputCls } from "../ui/input.js";
import { SettingsSection } from "./primitives.js";

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

	const sourceLabel = type === "github"
		? `GitHub · ${owner || "?"}/${repo || "?"}`
		: `${t("settings.contentHub.bundle", "自托管服务")} · ${baseUrl || "?"}`;

	return (
		<div className="min-w-0 rounded-lg bg-[var(--inno-surface)] p-4">
			<button className="inno-settings-card-toggle flex w-full min-w-0 items-start gap-2 text-left" onClick={() => setOpen((v) => !v)}>
				<Database size={16} className="mt-0.5 shrink-0 text-[var(--inno-text)]" />
				<div className="min-w-0 flex-1">
					<h4 className="break-words text-sm font-medium text-[var(--inno-text)]">{t("settings.contentHub.title", "内容源(技能库 + 预设)")}</h4>
					<p className="mt-1 max-w-full break-words text-xs leading-relaxed text-[var(--inno-text-muted)]">
						{t("settings.contentHub.desc", "技能库和预设工作区从这里拉取。默认公共仓库,可改为私有 GitHub 仓库或自托管服务。")}
					</p>
					{!open && <p className="mt-1 break-all text-xs leading-relaxed text-[var(--inno-text-subtle)]">{sourceLabel}</p>}
				</div>
				<ChevronDown size={14} className={`mt-1 shrink-0 text-[var(--inno-text-subtle)] transition-transform ${open ? "rotate-180" : ""}`} />
			</button>

			{open ? (
				<div className="mt-3 grid gap-2.5">
					{/* Type selector */}
					<div className="flex flex-wrap items-center gap-1.5">
						<button
							onClick={() => setType("github")}
							className={`flex h-7 items-center rounded-md border px-2.5 text-xs ${type === "github" ? "border-[var(--inno-accent)] bg-[var(--inno-accent-soft)] text-[var(--inno-accent)]" : "border-[var(--inno-border)] text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)]"}`}
						>
							GitHub
						</button>
						<button
							onClick={() => setType("bundle")}
							className={`flex h-7 items-center rounded-md border px-2.5 text-xs ${type === "bundle" ? "border-[var(--inno-accent)] bg-[var(--inno-accent-soft)] text-[var(--inno-accent)]" : "border-[var(--inno-border)] text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)]"}`}
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
							className="flex h-8 shrink-0 items-center rounded-md inno-primary-button px-3 text-xs text-white disabled:opacity-50"
						>
							{saving ? t("common.loading") : saved ? t("settings.github.saved", "已保存") : t("common.save")}
						</button>
					</div>
				</div>
			) : null}
		</div>
	);
}

/* ---------- OCR API Settings (Baidu PaddleOCR-VL token) ---------- */

function OcrSettings({ settings }: { settings: InnoSettings }) {
	const { t } = useTranslation();
	const ocr = settings.ocrApi;
	const [open, setOpen] = useState(false);
	const [token, setToken] = useState("");
	const [model, setModel] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);

	const maskedToken = ocr?.token ?? "";
	const hasExistingToken = Boolean(maskedToken);
	const [tokenDirty, setTokenDirty] = useState(false);

	useEffect(() => {
		setModel(ocr?.model ?? "");
		setBaseUrl(ocr?.baseUrl ?? "");
		setToken("");
		setTokenDirty(false);
		setSaved(false);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [maskedToken, ocr?.model, ocr?.baseUrl]);

	const dirty = tokenDirty || model !== (ocr?.model ?? "") || baseUrl !== (ocr?.baseUrl ?? "");

	async function handleSave() {
		setSaving(true);
		setSaved(false);
		try {
			const tokenToSend = tokenDirty ? token.trim() : maskedToken;
			await settingsStore.saveOcr({
				token: tokenToSend,
				model: model.trim() || undefined,
				baseUrl: baseUrl.trim() || undefined,
			});
			setSaved(true);
			setToken("");
			setTokenDirty(false);
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
			await settingsStore.saveOcr({ token: "" });
			setSaved(true);
			setToken("");
			setTokenDirty(false);
		} catch {
			// error surfaced via store
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="min-w-0 rounded-lg bg-[var(--inno-surface)] p-4">
			<button className="inno-settings-card-toggle flex w-full min-w-0 items-start gap-2 text-left" onClick={() => setOpen((v) => !v)}>
				<KeyRound size={16} className="mt-0.5 shrink-0 text-[var(--inno-text)]" />
				<div className="min-w-0 flex-1">
					<h4 className="break-words text-sm font-medium text-[var(--inno-text)]">{t("settings.ocr.title", "OCR API (图片文字识别)")}</h4>
					<p className="mt-1 max-w-full break-words text-xs leading-relaxed text-[var(--inno-text-muted)]">
						{t("settings.ocr.desc", "当接入的模型不支持图片识别时，调用百度 vl-ocr API 提取图片文字。需在百度 AI Studio 获取 token。")}
					</p>
					{!open && (
						<p className="mt-1 break-all text-xs leading-relaxed text-[var(--inno-text-subtle)]">
							{hasExistingToken ? `token: ${maskedToken}` : t("settings.ocr.tokenPlaceholder", "未配置")}
						</p>
					)}
				</div>
				<ChevronDown size={14} className={`mt-1 shrink-0 text-[var(--inno-text-subtle)] transition-transform ${open ? "rotate-180" : ""}`} />
			</button>

			{open ? (
				<div className="mt-3 grid gap-2.5">
					<div className="grid min-w-0 gap-2">
						<input
							className={inputCls}
							type="password"
							value={token}
							onChange={(e) => { setToken(e.target.value); setTokenDirty(true); setSaved(false); }}
							placeholder={hasExistingToken ? maskedToken : (t("settings.ocr.tokenPlaceholder", "bearer token") ?? "")}
							autoComplete="off"
						/>
						<input
							className={inputCls}
							value={model}
							onChange={(e) => { setModel(e.target.value); setSaved(false); }}
							placeholder={t("settings.ocr.modelPlaceholder", "PaddleOCR-VL-1.6") ?? ""}
							autoComplete="off"
						/>
						<input
							className={inputCls}
							value={baseUrl}
							onChange={(e) => { setBaseUrl(e.target.value); setSaved(false); }}
							placeholder={t("settings.ocr.baseUrlPlaceholder", "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs") ?? ""}
							autoComplete="off"
						/>
					</div>
					<div className="flex min-w-0 flex-wrap items-center gap-2">
						<button
							disabled={saving || !dirty}
							onClick={() => void handleSave()}
							className="flex h-8 shrink-0 items-center rounded-md inno-primary-button px-3 text-xs text-white disabled:opacity-50"
						>
							{saving ? t("common.loading") : saved ? t("settings.ocr.saved", "已保存") : t("common.save")}
						</button>
						{hasExistingToken && (
							<button
								disabled={saving}
								onClick={() => void handleClear()}
								className="flex h-8 shrink-0 items-center rounded-md border border-[var(--inno-border)] px-3 text-xs text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]"
							>
								{t("settings.ocr.clear", "清除")}
							</button>
						)}
					</div>
				</div>
			) : null}
		</div>
	);
}

/* ---------- Tavily Settings (web_search tool API key) ---------- */

function TavilySettings({ settings }: { settings: InnoSettings }) {
	const { t } = useTranslation();
	const tavily = settings.tavily;
	const [open, setOpen] = useState(false);
	const [apiKey, setApiKey] = useState("");
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);

	const maskedKey = tavily?.apiKey ?? "";
	const hasExistingKey = Boolean(maskedKey);
	const [keyDirty, setKeyDirty] = useState(false);

	useEffect(() => {
		setApiKey("");
		setKeyDirty(false);
		setSaved(false);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [maskedKey]);

	const dirty = keyDirty;

	async function handleSave() {
		setSaving(true);
		setSaved(false);
		try {
			await settingsStore.saveTavily(keyDirty ? apiKey.trim() : maskedKey);
			setSaved(true);
			setApiKey("");
			setKeyDirty(false);
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
			await settingsStore.saveTavily("");
			setSaved(true);
			setApiKey("");
			setKeyDirty(false);
		} catch {
			// error surfaced via store
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="min-w-0 rounded-lg bg-[var(--inno-surface)] p-4">
			<button className="inno-settings-card-toggle flex w-full min-w-0 items-start gap-2 text-left" onClick={() => setOpen((v) => !v)}>
				<Globe size={16} className="mt-0.5 shrink-0 text-[var(--inno-text)]" />
				<div className="min-w-0 flex-1">
					<h4 className="break-words text-sm font-medium text-[var(--inno-text)]">{t("settings.tavily.title", "联网搜索 (Tavily)")}</h4>
					<p className="mt-1 max-w-full break-words text-xs leading-relaxed text-[var(--inno-text-muted)]">
						{t("settings.tavily.desc", "为 agent 提供联网检索能力。需在 tavily.com 获取 API Key。")}
					</p>
					{!open && (
						<p className="mt-1 break-all text-xs leading-relaxed text-[var(--inno-text-subtle)]">
							{hasExistingKey ? `apiKey: ${maskedKey}` : t("settings.tavily.placeholder", "tvly-…")}
						</p>
					)}
				</div>
				<ChevronDown size={14} className={`mt-1 shrink-0 text-[var(--inno-text-subtle)] transition-transform ${open ? "rotate-180" : ""}`} />
			</button>

			{open ? (
				<div className="mt-3 grid gap-2.5">
					<input
						className={inputCls}
						type="password"
						value={apiKey}
						onChange={(e) => { setApiKey(e.target.value); setKeyDirty(true); setSaved(false); }}
						placeholder={hasExistingKey ? maskedKey : (t("settings.tavily.placeholder", "tvly-…") ?? "")}
						autoComplete="off"
					/>
					<div className="flex min-w-0 flex-wrap items-center gap-2">
						<button
							disabled={saving || !dirty}
							onClick={() => void handleSave()}
							className="flex h-8 shrink-0 items-center rounded-md inno-primary-button px-3 text-xs text-white disabled:opacity-50"
						>
							{saving ? t("common.loading") : saved ? t("settings.tavily.saved", "已保存") : t("common.save")}
						</button>
						{hasExistingKey && (
							<button
								disabled={saving}
								onClick={() => void handleClear()}
								className="flex h-8 shrink-0 items-center rounded-md border border-[var(--inno-border)] px-3 text-xs text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]"
							>
								{t("settings.tavily.clear", "清除")}
							</button>
						)}
					</div>
				</div>
			) : null}
		</div>
	);
}

/* ---------- Web Research Settings (pi-web-access: web_research / source_check / fetch_content) ---------- */

function WebResearchSettings() {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const [data, setData] = useState<WebAccessSettings | null>(null);
	const [provider, setProvider] = useState("auto");
	const [draft, setDraft] = useState<Record<string, string>>({});
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);

	useEffect(() => {
		let cancelled = false;
		getWebAccessSettings()
			.then((d) => {
				if (cancelled) return;
				setData(d);
				setProvider(d.defaultProvider);
			})
			.catch(() => {});
		return () => { cancelled = true; };
	}, []);

	const configuredCount = data?.providers.filter((p) => p.configured).length ?? 0;
	const dirty = Boolean(data) && (provider !== data!.defaultProvider || Object.keys(draft).length > 0);

	async function handleSave() {
		if (!data) return;
		setSaving(true);
		setSaved(false);
		try {
			const values: Record<string, string> = {};
			for (const [id, v] of Object.entries(draft)) values[id] = v.trim();
			const next = await saveWebAccessSettings({ provider, values });
			setData(next);
			setProvider(next.defaultProvider);
			setDraft({});
			setSaved(true);
		} catch {
			// surfaced by api client
		} finally {
			setSaving(false);
		}
	}

	async function handleClear(id: string) {
		setSaving(true);
		setSaved(false);
		try {
			const next = await saveWebAccessSettings({ values: { [id]: "" } });
			setData(next);
			setProvider(next.defaultProvider);
			setDraft((prev) => {
				const { [id]: _drop, ...rest } = prev;
				return rest;
			});
		} catch {
			// surfaced by api client
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="min-w-0 rounded-lg bg-[var(--inno-surface)] p-4">
			<button className="inno-settings-card-toggle flex w-full min-w-0 items-start gap-2 text-left" onClick={() => setOpen((v) => !v)}>
				<Search size={16} className="mt-0.5 shrink-0 text-[var(--inno-text)]" />
				<div className="min-w-0 flex-1">
					<h4 className="break-words text-sm font-medium text-[var(--inno-text)]">{t("settings.webResearch.title", "深度调研 (web_research)")}</h4>
					<p className="mt-1 max-w-full break-words text-xs leading-relaxed text-[var(--inno-text-muted)]">
						{t("settings.webResearch.desc", "多角度、多源头联网调研与事实核查（source_check），支持 Tavily / Brave / Exa / Perplexity 等 20+ 搜索源；DuckDuckGo 免配置兜底。与上方 Tavily 快速搜索并存。")}
					</p>
					{!open && (
						<p className="mt-1 break-all text-xs leading-relaxed text-[var(--inno-text-subtle)]">
							{t("settings.webResearch.summary", "默认源: {{provider}} · 已配置 {{count}} 个源", {
								provider: data?.defaultProvider ?? "auto",
								count: configuredCount,
							})}
						</p>
					)}
				</div>
				<ChevronDown size={14} className={`mt-1 shrink-0 text-[var(--inno-text-subtle)] transition-transform ${open ? "rotate-180" : ""}`} />
			</button>

			{open && data ? (
				<div className="mt-3 grid gap-2.5">
					<label className="grid gap-1 text-xs text-[var(--inno-text-muted)]">
						{t("settings.webResearch.defaultProvider", "默认搜索源")}
						<select
							className={inputCls}
							value={provider}
							onChange={(e) => { setProvider(e.target.value); setSaved(false); }}
						>
							<option value="auto">auto（自动选择）</option>
							{data.providers.map((p) => (
								<option key={p.id} value={p.id}>
									{p.id}{p.configured ? " ✓" : p.kind === "none" ? `（${t("settings.webResearch.keyless", "免配置")}）` : ""}
								</option>
							))}
						</select>
					</label>

					{data.providers.map((p) =>
						p.kind === "none" ? (
							<div key={p.id} className="flex items-center justify-between gap-2 text-xs text-[var(--inno-text-muted)]">
								<span>{p.id}</span>
								<span className="text-[var(--inno-text-subtle)]">{t("settings.webResearch.keyless", "免配置")}</span>
							</div>
						) : (
							<div key={p.id} className="flex min-w-0 items-center gap-2">
								<input
									className={inputCls}
									type={p.kind === "key" ? "password" : "text"}
									value={draft[p.id] ?? ""}
									onChange={(e) => {
										setDraft((prev) => ({ ...prev, [p.id]: e.target.value }));
										setSaved(false);
									}}
									placeholder={p.configured ? p.maskedValue : p.kind === "url" ? "https://searxng.example.com" : `${p.id} API Key`}
									autoComplete="off"
								/>
								{p.configured && (
									<button
										disabled={saving}
										onClick={() => void handleClear(p.id)}
										className="flex h-8 shrink-0 items-center rounded-md border border-[var(--inno-border)] px-3 text-xs text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]"
									>
										{t("settings.webResearch.clear", "清除")}
									</button>
								)}
							</div>
						),
					)}

					<div className="flex min-w-0 flex-wrap items-center gap-2">
						<button
							disabled={saving || !dirty}
							onClick={() => void handleSave()}
							className="flex h-8 shrink-0 items-center rounded-md inno-primary-button px-3 text-xs text-white disabled:opacity-50"
						>
							{saving ? t("common.loading") : saved ? t("settings.webResearch.saved", "已保存") : t("common.save")}
						</button>
					</div>
					<p className="text-xs leading-relaxed text-[var(--inno-text-subtle)]">
						{t("settings.webResearch.hint", "更多搜索源与高级选项可直接编辑配置目录下的 web-search.json。")}
					</p>
				</div>
			) : null}
		</div>
	);
}

/* ---------- Integrations category page ---------- */

export function IntegrationsSettings({ settings }: { settings: InnoSettings }) {
	const { t } = useTranslation();
	return (
		<SettingsSection title={t("settings.tabs.integrations")} description={t("settings.sections.integrations.desc", "内容源、OCR 与联网搜索等外部服务")}>
			<ContentHubSettings settings={settings} />
			<OcrSettings settings={settings} />
			<TavilySettings settings={settings} />
			<WebResearchSettings />
		</SettingsSection>
	);
}
