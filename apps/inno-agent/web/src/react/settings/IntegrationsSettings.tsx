import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Database, KeyRound, Globe, Search } from "lucide-react";
import { settingsStore } from "../../stores/settings-store.js";
import { getWebAccessSettings, saveWebAccessSettings } from "../../api/settings.js";
import type { InnoSettings, WebAccessSettings } from "../../types/settings.js";
import { Button, Input, SegmentedControl, Select, SelectContent, SelectOption, SelectTrigger, SelectValue } from "../ui/index.js";
import { SettingsSection, SettingsGroup, SettingsCollapsibleCard, SettingsStatusBadge } from "./primitives.js";

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
		<SettingsCollapsibleCard
			icon={<Database size={15} />}
			title={t("settings.contentHub.title", "内容源(技能库 + 预设)")}
			description={t("settings.contentHub.desc", "技能库和预设工作区从这里拉取。默认公共仓库,可改为私有 GitHub 仓库或自托管服务。")}
			summary={sourceLabel}
			badge={
				<SettingsStatusBadge tone="neutral">
					{type === "github" ? "GitHub" : t("settings.contentHub.bundle", "自托管服务")}
				</SettingsStatusBadge>
			}
			open={open}
			onToggle={() => setOpen((v) => !v)}
		>
			<div className="grid gap-3">
				<div>
					<SegmentedControl
						value={type}
						onValueChange={(next) => { setType(next); setSaved(false); }}
						ariaLabel={t("settings.contentHub.title", "内容源(技能库 + 预设)")}
						items={[
							{ value: "github", label: "GitHub" },
							{ value: "bundle", label: t("settings.contentHub.bundle", "自托管服务") },
						]}
					/>
				</div>

				{type === "github" ? (
					<>
						<div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-2">
							<Input size="sm" value={owner} onChange={(e) => { setOwner(e.target.value); setSaved(false); }} placeholder="owner" autoComplete="off" />
							<Input size="sm" value={repo} onChange={(e) => { setRepo(e.target.value); setSaved(false); }} placeholder="repo" autoComplete="off" />
							<Input size="sm" value={ref} onChange={(e) => { setRef(e.target.value); setSaved(false); }} placeholder="ref (main)" autoComplete="off" />
						</div>
						<div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-2">
							<Input size="sm" value={skillsPath} onChange={(e) => { setSkillsPath(e.target.value); setSaved(false); }} placeholder="skill-library" autoComplete="off" />
							<Input size="sm" value={presetsPath} onChange={(e) => { setPresetsPath(e.target.value); setSaved(false); }} placeholder="workspace-templates" autoComplete="off" />
						</div>
					</>
				) : (
					<Input size="sm" value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); setSaved(false); }} placeholder="https://hub.example.com" autoComplete="off" />
				)}

				<div className="flex min-w-0 flex-wrap items-center gap-2">
					<Input
						size="sm"
						className="flex-1 basis-44"
						type="password"
						value={token}
						onChange={(e) => { setToken(e.target.value); setSaved(false); }}
						placeholder={t("settings.contentHub.tokenPlaceholder", "访问令牌(私有仓库 / 提额,可选)") ?? ""}
						autoComplete="off"
					/>
					<Button
						variant="primary"
						size="sm"
						disabled={saving}
						onClick={() => void handleSave()}
						className="shrink-0"
					>
						{saving ? t("common.loading") : saved ? t("settings.github.saved", "已保存") : t("common.save")}
					</Button>
				</div>
			</div>
		</SettingsCollapsibleCard>
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
		<SettingsCollapsibleCard
			icon={<KeyRound size={15} />}
			title={t("settings.ocr.title", "OCR API (图片文字识别)")}
			description={t("settings.ocr.desc", "当接入的模型不支持图片识别时，调用百度 vl-ocr API 提取图片文字。需在百度 AI Studio 获取 token。")}
			summary={hasExistingToken ? `token: ${maskedToken}` : undefined}
			badge={
				<SettingsStatusBadge tone={hasExistingToken ? "success" : "neutral"} dot={hasExistingToken}>
					{hasExistingToken ? t("settings.status.configured", "已配置") : t("settings.status.notConfigured", "未配置")}
				</SettingsStatusBadge>
			}
			open={open}
			onToggle={() => setOpen((v) => !v)}
		>
			<div className="grid gap-3">
				<div className="grid min-w-0 gap-2">
					<Input
						size="sm"
						type="password"
						value={token}
						onChange={(e) => { setToken(e.target.value); setTokenDirty(true); setSaved(false); }}
						placeholder={hasExistingToken ? maskedToken : (t("settings.ocr.tokenPlaceholder", "bearer token") ?? "")}
						autoComplete="off"
					/>
					<Input
						size="sm"
						value={model}
						onChange={(e) => { setModel(e.target.value); setSaved(false); }}
						placeholder={t("settings.ocr.modelPlaceholder", "PaddleOCR-VL-1.6") ?? ""}
						autoComplete="off"
					/>
					<Input
						size="sm"
						value={baseUrl}
						onChange={(e) => { setBaseUrl(e.target.value); setSaved(false); }}
						placeholder={t("settings.ocr.baseUrlPlaceholder", "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs") ?? ""}
						autoComplete="off"
					/>
				</div>
				<div className="flex min-w-0 flex-wrap items-center gap-2">
					<Button
						variant="primary"
						size="sm"
						disabled={saving || !dirty}
						onClick={() => void handleSave()}
						className="shrink-0"
					>
						{saving ? t("common.loading") : saved ? t("settings.ocr.saved", "已保存") : t("common.save")}
					</Button>
					{hasExistingToken ? (
						<Button
							variant="secondary"
							size="sm"
							disabled={saving}
							onClick={() => void handleClear()}
							className="shrink-0"
						>
							{t("settings.ocr.clear", "清除")}
						</Button>
					) : null}
				</div>
			</div>
		</SettingsCollapsibleCard>
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
		<SettingsCollapsibleCard
			icon={<Globe size={15} />}
			title={t("settings.tavily.title", "联网搜索 (Tavily)")}
			description={t("settings.tavily.desc", "为 agent 提供联网检索能力。需在 tavily.com 获取 API Key。")}
			summary={hasExistingKey ? `apiKey: ${maskedKey}` : undefined}
			badge={
				<SettingsStatusBadge tone={hasExistingKey ? "success" : "neutral"} dot={hasExistingKey}>
					{hasExistingKey ? t("settings.status.configured", "已配置") : t("settings.status.notConfigured", "未配置")}
				</SettingsStatusBadge>
			}
			open={open}
			onToggle={() => setOpen((v) => !v)}
		>
			<div className="grid gap-3">
				<Input
					size="sm"
					type="password"
					value={apiKey}
					onChange={(e) => { setApiKey(e.target.value); setKeyDirty(true); setSaved(false); }}
					placeholder={hasExistingKey ? maskedKey : (t("settings.tavily.placeholder", "tvly-…") ?? "")}
					autoComplete="off"
				/>
				<div className="flex min-w-0 flex-wrap items-center gap-2">
					<Button
						variant="primary"
						size="sm"
						disabled={saving || !dirty}
						onClick={() => void handleSave()}
						className="shrink-0"
					>
						{saving ? t("common.loading") : saved ? t("settings.tavily.saved", "已保存") : t("common.save")}
					</Button>
					{hasExistingKey ? (
						<Button
							variant="secondary"
							size="sm"
							disabled={saving}
							onClick={() => void handleClear()}
							className="shrink-0"
						>
							{t("settings.tavily.clear", "清除")}
						</Button>
					) : null}
				</div>
			</div>
		</SettingsCollapsibleCard>
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
		<SettingsCollapsibleCard
			icon={<Search size={15} />}
			title={t("settings.webResearch.title", "深度调研 (web_research)")}
			description={t("settings.webResearch.desc", "多角度、多源头联网调研与事实核查（source_check），支持 Tavily / Brave / Exa / Perplexity 等 20+ 搜索源；DuckDuckGo 免配置兜底。与 Tavily 快速搜索并存。")}
			summary={t("settings.webResearch.summary", "默认源: {{provider}} · 已配置 {{count}} 个源", {
				provider: data?.defaultProvider ?? "auto",
				count: configuredCount,
			})}
			badge={
				<SettingsStatusBadge tone={configuredCount > 0 ? "success" : "neutral"} dot={configuredCount > 0}>
					{configuredCount > 0
						? t("settings.status.configuredCount", "{{count}} 个已配置", { count: configuredCount })
						: t("settings.webResearch.keyless", "免配置")}
				</SettingsStatusBadge>
			}
			open={open}
			onToggle={() => setOpen((v) => !v)}
		>
			{data ? (
				<div className="grid gap-3">
					<label className="grid gap-1 text-xs font-medium text-[var(--inno-text-muted)]">
						{t("settings.webResearch.defaultProvider", "默认搜索源")}
						<Select
							value={provider}
							onValueChange={(value) => { setProvider(value); setSaved(false); }}
						>
							<SelectTrigger className="w-full text-xs" aria-label={t("settings.webResearch.defaultProvider", "默认搜索源")}><SelectValue /></SelectTrigger>
							<SelectContent>
								<SelectOption value="auto" label="auto（自动选择）" />
								{data.providers.map((p) => (
									<SelectOption key={p.id} value={p.id} label={`${p.id}${p.configured ? " ✓" : p.kind === "none" ? `（${t("settings.webResearch.keyless", "免配置")}）` : ""}`} />
								))}
							</SelectContent>
						</Select>
					</label>

					<div className="grid gap-2">
						{data.providers.map((p) =>
							p.kind === "none" ? (
								<div key={p.id} className="flex items-center justify-between gap-2 rounded-lg border border-[var(--inno-border)] bg-[var(--inno-card-bg)] px-3 py-2 text-xs text-[var(--inno-text-muted)]">
									<span className="font-medium text-[var(--inno-text)]">{p.id}</span>
									<span className="text-[var(--inno-text-subtle)]">{t("settings.webResearch.keyless", "免配置")}</span>
								</div>
							) : (
								<div key={p.id} className="flex min-w-0 items-center gap-2">
									<Input
										size="sm"
										type={p.kind === "key" ? "password" : "text"}
										value={draft[p.id] ?? ""}
										onChange={(e) => {
											setDraft((prev) => ({ ...prev, [p.id]: e.target.value }));
											setSaved(false);
										}}
										placeholder={p.configured ? p.maskedValue : p.kind === "url" ? "https://searxng.example.com" : `${p.id} API Key`}
										autoComplete="off"
									/>
									{p.configured ? (
										<Button
											variant="secondary"
											size="xs"
											disabled={saving}
											onClick={() => void handleClear(p.id)}
											className="shrink-0"
										>
											{t("settings.webResearch.clear", "清除")}
										</Button>
									) : null}
								</div>
							),
						)}
					</div>

					<div className="flex min-w-0 flex-wrap items-center gap-2">
						<Button
							variant="primary"
							size="sm"
							disabled={saving || !dirty}
							onClick={() => void handleSave()}
							className="shrink-0"
						>
							{saving ? t("common.loading") : saved ? t("settings.webResearch.saved", "已保存") : t("common.save")}
						</Button>
					</div>
					<p className="text-xs leading-relaxed text-[var(--inno-text-subtle)]">
						{t("settings.webResearch.hint", "更多搜索源与高级选项可直接编辑配置目录下的 web-search.json。")}
					</p>
				</div>
			) : null}
		</SettingsCollapsibleCard>
	);
}

/* ---------- Integrations category page ---------- */

export function IntegrationsSettings({ settings }: { settings: InnoSettings }) {
	const { t } = useTranslation();
	return (
		<SettingsSection
			title={t("settings.tabs.integrations")}
			description={t("settings.sections.integrations.desc", "联网搜索、OCR 与内容源等外部服务")}
		>
			<SettingsGroup title={t("settings.groups.webSearch", "联网检索")}>
				<WebResearchSettings />
				<TavilySettings settings={settings} />
			</SettingsGroup>

			<SettingsGroup title={t("settings.groups.mediaAndContent", "多媒体与内容源")}>
				<OcrSettings settings={settings} />
				<ContentHubSettings settings={settings} />
			</SettingsGroup>
		</SettingsSection>
	);
}
