import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Check, ChevronDown, ChevronRight, ExternalLink, Plus, RefreshCw, Search, SlidersHorizontal, X } from "lucide-react";
import { settingsStore } from "../../stores/settings-store.js";
import { probeProviderModels } from "../../api/settings.js";
import type { InnoProviderModel as ProviderModel, InnoProviderSettings } from "../../types/settings.js";
import { Button, Checkbox, Dialog, IconButton, Input, SegmentedControl, Spinner } from "../ui/index.js";
import { formatTokens } from "./shared.js";
import { PROVIDER_PRESETS, findPreset, type ProviderPreset } from "./provider-presets.js";
import { catalogForProvider, type CatalogModel } from "./model-catalog.js";
import { inferModelMetadata } from "./model-metadata.js";

const API_OPTIONS = [
	{ value: "openai-completions", label: "OpenAI Chat" },
	{ value: "openai-responses", label: "OpenAI Responses" },
	{ value: "anthropic-messages", label: "Anthropic" },
] as const;

/** Brand icon for a provider, with a colored glyph tile as the fallback. */
export function ProviderIcon({ providerId, size = 28 }: { providerId: string; size?: number }) {
	const preset = findPreset(providerId);
	const color = preset?.brandColor ?? "#8A8F98";
	const glyph = preset?.glyph ?? providerId.trim().charAt(0).toUpperCase() ?? "?";
	const iconSrc = preset?.iconSrc;
	return (
		<span
			className="flex shrink-0 items-center justify-center overflow-hidden rounded-md font-semibold text-white"
			style={{ width: size, height: size, backgroundColor: iconSrc ? "transparent" : color, fontSize: Math.round(size * 0.38) }}
		>
			{iconSrc ? <img src={iconSrc} alt="" aria-hidden="true" className="h-full w-full object-contain" /> : glyph}
		</span>
	);
}

interface ConnectionForm {
	providerId: string;
	baseUrl: string;
	apiKey: string;
	api: string;
	authHeader: boolean;
	bypassProxy: boolean;
}

interface TokenOverride { contextWindow: string; maxTokens: string }

const labelCls = "mb-1 block text-xs text-[var(--inno-text-muted)]";
const chipCls = "rounded bg-[var(--inno-surface-muted)] px-1.5 py-0.5 text-xs text-[var(--inno-text-muted)]";
const accentChipCls = "rounded bg-[var(--inno-accent-soft)] px-1.5 py-0.5 text-xs text-[var(--inno-accent)]";

function connectionFromPreset(preset: ProviderPreset): ConnectionForm {
	return {
		providerId: preset.id === "custom" ? "" : preset.id,
		baseUrl: preset.baseUrl,
		apiKey: "",
		api: preset.api,
		authHeader: false,
		bypassProxy: false,
	};
}

/** Same display name can repeat across dated versions (e.g. Seed 2.1 Pro); disambiguate with the id. */
function displayName(model: CatalogModel, pool: CatalogModel[]): string {
	const dup = pool.some((m) => m.id !== model.id && m.name === model.name);
	return dup ? `${model.name} (${model.id})` : model.name;
}

/**
 * Add-model dialog: pick a provider, paste an API key, tick models from the
 * provider's known catalog (context / output / capabilities are pre-filled from
 * real vendor data and individually adjustable). Online model discovery and
 * manual ids supplement the catalog; custom endpoints use the same flow.
 */
function AddModelDialog({ providers, onClose }: { providers: Record<string, InnoProviderSettings>; onClose: () => void }) {
	const { t } = useTranslation();
	const [preset, setPreset] = useState<ProviderPreset | null>(null);
	const [conn, setConn] = useState<ConnectionForm | null>(null);
	const [pickQuery, setPickQuery] = useState("");
	const [modelQuery, setModelQuery] = useState("");
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [extra, setExtra] = useState<CatalogModel[]>([]);
	const [overrides, setOverrides] = useState<Record<string, TokenOverride>>({});
	const [adjusting, setAdjusting] = useState<string | null>(null);
	const [showConnection, setShowConnection] = useState(false);
	const [manualId, setManualId] = useState("");
	const [probing, setProbing] = useState(false);
	const [probeInfo, setProbeInfo] = useState<{ ok: boolean; text: string } | null>(null);
	const [formError, setFormError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [makeDefault, setMakeDefault] = useState(Object.keys(providers).length === 0);

	const providerKey = conn?.providerId.trim() ?? "";
	const existingModels = providers[providerKey]?.models ?? [];
	const existingIds = useMemo(() => new Set(existingModels.map((m) => m.id)), [existingModels]);
	const catalog = useMemo(() => (preset ? catalogForProvider(preset.id) : []), [preset]);
	const candidates = useMemo(() => {
		const known = new Set(catalog.map((m) => m.id));
		return [...catalog, ...extra.filter((m) => !known.has(m.id))];
	}, [catalog, extra]);
	const visibleCandidates = useMemo(() => {
		const q = modelQuery.trim().toLowerCase();
		if (!q) return candidates;
		return candidates.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
	}, [candidates, modelQuery]);

	function selectPreset(p: ProviderPreset) {
		const known = catalogForProvider(p.id);
		const existing = new Set((providers[p.id]?.models ?? []).map((m) => m.id));
		setPreset(p);
		setConn(connectionFromPreset(p));
		// Pre-tick the recommended models so a pasted key is all that is needed.
		setSelected(new Set(known.filter((m) => m.recommended && !existing.has(m.id)).map((m) => m.id)));
		setExtra([]);
		setOverrides({});
		setAdjusting(null);
		setModelQuery("");
		setManualId("");
		setProbeInfo(null);
		setFormError(null);
		setShowConnection(p.id === "custom");
	}

	function back() {
		setPreset(null);
		setConn(null);
		setFormError(null);
	}

	function toggle(id: string) {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}

	function setOverride(id: string, patch: Partial<TokenOverride>, base: CatalogModel) {
		setOverrides((prev) => ({
			...prev,
			[id]: { ...(prev[id] ?? { contextWindow: String(base.contextWindow), maxTokens: String(base.maxTokens) }), ...patch },
		}));
	}

	function addManual() {
		const id = manualId.trim();
		if (!id || !preset) return;
		if (!candidates.some((m) => m.id === id)) {
			const meta = inferModelMetadata(id, preset.id);
			setExtra((prev) => [...prev, { id, name: id, ...meta }]);
		}
		setSelected((prev) => new Set(prev).add(id));
		setManualId("");
	}

	/** Doubles as a connection test: success proves the key and endpoint work. */
	async function handleProbe() {
		if (!conn || !preset) return;
		setProbing(true);
		setProbeInfo(null);
		try {
			const existing = providers[conn.providerId];
			const result = await probeProviderModels({
				baseUrl: conn.baseUrl,
				apiKey: conn.apiKey,
				providerId: existing?.apiKey ? conn.providerId : undefined,
				api: conn.api,
			});
			const ids = [...new Set(result.models.map((id) => id.trim()).filter(Boolean))];
			setExtra(ids.map((id) => ({ id, name: id, ...inferModelMetadata(id, preset.id) })));
			setProbeInfo({ ok: true, text: t("settings.wizard.probeOk", { count: ids.length, defaultValue: "连接成功，发现 {{count}} 个模型" }) });
		} catch (err) {
			setProbeInfo({ ok: false, text: err instanceof Error ? err.message : String(err) });
		} finally {
			setProbing(false);
		}
	}

	async function handleSave() {
		if (!conn || !preset) return;
		const providerId = conn.providerId.trim();
		if (!providerId) return setFormError(t("settings.errors.providerRequired"));
		if (!conn.baseUrl.trim()) return setFormError(t("settings.errors.baseUrlRequired"));
		const chosen = candidates.filter((m) => selected.has(m.id));
		if (chosen.length === 0) return setFormError(t("settings.wizard.pickAtLeastOne", "请至少选择一个模型"));
		const built: ProviderModel[] = [];
		for (const m of chosen) {
			const o = overrides[m.id];
			const contextWindow = Number(o?.contextWindow ?? m.contextWindow);
			const maxTokens = Number(o?.maxTokens ?? m.maxTokens);
			if (!Number.isFinite(contextWindow) || contextWindow <= 0 || !Number.isFinite(maxTokens) || maxTokens <= 0) {
				return setFormError(t("settings.errors.tokensInvalid"));
			}
			built.push({
				id: m.id,
				name: displayName(m, candidates),
				reasoning: m.reasoning,
				input: m.supportsImages ? ["text", "image"] : ["text"],
				contextWindow: Math.trunc(contextWindow),
				maxTokens: Math.trunc(maxTokens),
			});
		}
		setSaving(true);
		setFormError(null);
		try {
			// Merge with the provider's existing models; new ones go first because
			// the backend treats models[0] as the default when makeDefault is set.
			const ids = new Set(built.map((m) => m.id));
			const models = [...built, ...existingModels.filter((m) => !ids.has(m.id))];
			await settingsStore.saveProvider({
				providerId,
				baseUrl: conn.baseUrl.trim(),
				apiKey: conn.apiKey,
				api: conn.api,
				authHeader: conn.authHeader,
				bypassProxy: conn.bypassProxy,
				models,
				makeDefault,
				// Blank key keeps the stored one for an existing provider.
				preserveApiKey: true,
			});
			onClose();
		} catch (err) {
			setFormError(err instanceof Error ? err.message : "Save failed");
		} finally {
			setSaving(false);
		}
	}

	const pickList = PROVIDER_PRESETS.filter((p) => {
		const q = pickQuery.trim().toLowerCase();
		return !q || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q) || p.id.includes(q);
	});
	const isCustom = preset?.id === "custom";

	return (
		<Dialog
			label={t("settings.wizard.title", "添加模型")}
			className="inno-confirm-dialog w-[720px] max-h-[86vh] flex-col overflow-hidden rounded-xl border border-[var(--inno-border)] bg-[var(--inno-surface)] p-0 text-[var(--inno-text)] shadow-xl open:flex"
			onClose={() => { if (!saving) onClose(); }}
		>
			{/* Header */}
			<div className="flex items-center justify-between gap-3 border-b border-[var(--inno-border)] px-5 py-3.5">
				<div className="flex min-w-0 items-center gap-2.5">
					{preset ? (
						<IconButton size="xs" aria-label={t("settings.wizard.changePreset", "更换提供方")} title={t("settings.wizard.changePreset", "更换提供方")} onClick={back}>
							<ArrowLeft size={14} />
						</IconButton>
					) : null}
					{preset ? <ProviderIcon providerId={preset.id} size={24} /> : null}
					<div className="min-w-0">
						<h2 className="truncate text-sm font-medium">{preset ? preset.name : t("settings.wizard.title", "添加模型")}</h2>
						<p className="truncate text-xs text-[var(--inno-text-subtle)]">
							{preset
								? (isCustom ? t("settings.wizard.customHint", "接入任意 OpenAI / Anthropic 兼容端点") : preset.description)
								: t("settings.wizard.pickHint", "选择提供方，已知模型的上下文等参数会自动预置")}
						</p>
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					{preset?.docsUrl ? (
						<a className="flex items-center gap-0.5 text-xs text-[var(--inno-text-subtle)] hover:text-[var(--inno-accent)]" href={preset.docsUrl} target="_blank" rel="noreferrer">
							{t("settings.wizard.docs", "文档")} <ExternalLink size={10} />
						</a>
					) : null}
					<IconButton size="xs" aria-label={t("common.close", "关闭")} title={t("common.close", "关闭")} onClick={onClose}>
						<X size={14} />
					</IconButton>
				</div>
			</div>

			{/* Body */}
			<div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
				{!preset || !conn ? (
					<div>
						<div className="relative mb-3">
							<Search size={14} className="inno-ui-input-leading-adornment" aria-hidden="true" />
							<Input
								size="sm"
								hasLeadingAdornment
								data-autofocus
								className="w-full"
								placeholder={t("settings.wizard.searchProvider", "搜索提供方") ?? ""}
								value={pickQuery}
								onChange={(e) => setPickQuery(e.target.value)}
							/>
						</div>
						<div className="grid grid-cols-2 gap-2.5">
							{pickList.map((p) => {
								const count = catalogForProvider(p.id).length;
								const added = providers[p.id] ? providers[p.id].models.length : 0;
								return (
									<button
										key={p.id}
										type="button"
										className="flex items-center gap-3 rounded-lg border border-[var(--inno-border)] p-3 text-left transition-colors hover:border-[var(--inno-accent)] hover:bg-[var(--inno-surface-muted)]"
										onClick={() => selectPreset(p)}
									>
										<ProviderIcon providerId={p.id} size={34} />
										<span className="min-w-0 flex-1">
											<span className="block truncate text-sm font-medium">{p.name}</span>
											<span className="block truncate text-xs text-[var(--inno-text-subtle)]">{p.description}</span>
										</span>
										<span className="shrink-0 text-right text-xs text-[var(--inno-text-subtle)]">
											{count > 0 ? <span className="block">{t("settings.wizard.presetCount", { count, defaultValue: "{{count}} 个预置" })}</span> : null}
											{added > 0 ? <span className="block text-[var(--inno-success)]">{t("settings.wizard.addedCount", { count: added, defaultValue: "已添加 {{count}}" })}</span> : null}
										</span>
									</button>
								);
							})}
							{pickList.length === 0 ? <p className="col-span-2 py-6 text-center text-xs text-[var(--inno-text-subtle)]">{t("settings.wizard.noMatchingProvider", "没有匹配的提供方")}</p> : null}
						</div>
					</div>
				) : (
					<div className="grid gap-4">
						{/* Connection */}
						<section className="grid gap-3">
							{isCustom ? (
								<div>
									<label className={labelCls}>{t("settings.wizard.customName", "提供方名称")}</label>
									<Input
										size="sm"
										className="w-full"
										placeholder="my-gateway"
										value={conn.providerId}
										onChange={(e) => setConn({ ...conn, providerId: e.target.value })}
									/>
								</div>
							) : null}
							<div>
								<div className="mb-1 flex items-center justify-between">
									<label className="text-xs text-[var(--inno-text-muted)]">{t("settings.form.apiKey")}</label>
									{preset.consoleUrl ? (
										<a className="flex items-center gap-0.5 text-xs text-[var(--inno-accent)] hover:underline" href={preset.consoleUrl} target="_blank" rel="noreferrer">
											{t("settings.wizard.getApiKey", "获取 API Key")} <ExternalLink size={10} />
										</a>
									) : null}
								</div>
								<div className="flex gap-2">
									<Input
										size="sm"
										className="min-w-0 flex-1"
										type="password"
										autoComplete="off"
										placeholder={providers[providerKey] ? t("settings.form.apiKeyPreserved") ?? "" : "sk-..."}
										value={conn.apiKey}
										onChange={(e) => setConn({ ...conn, apiKey: e.target.value })}
									/>
									<Button size="sm" variant="secondary" disabled={probing || !conn.baseUrl.trim()} onClick={() => void handleProbe()}>
										{probing ? <Spinner size={12} /> : <RefreshCw size={12} />}
										{t("settings.wizard.testAndFetch", "测试连接")}
									</Button>
								</div>
								{probeInfo ? (
									<p className={`mt-1 flex items-center gap-1 text-xs ${probeInfo.ok ? "text-[var(--inno-success)]" : "text-[var(--inno-danger)]"}`}>
										{probeInfo.ok ? <Check size={11} /> : null}{probeInfo.text}
									</p>
								) : null}
							</div>

							<div>
								<button
									type="button"
									className="flex items-center gap-1 text-xs text-[var(--inno-text-subtle)] hover:text-[var(--inno-text)]"
									onClick={() => setShowConnection((v) => !v)}
								>
									{showConnection ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
									{t("settings.wizard.connectionSettings", "连接设置")}
									<span className="text-[var(--inno-text-subtle)]">· {conn.baseUrl || t("settings.wizard.notSet", "未设置")}</span>
								</button>
								{showConnection ? (
									<div className="mt-2 grid gap-3 rounded-lg bg-[var(--inno-surface-muted)] p-3">
										<div>
											<label className={labelCls}>{t("settings.form.baseUrl")}</label>
											<Input
												size="sm"
												className="w-full"
												type="url"
												placeholder="https://api.example.com/v1"
												value={conn.baseUrl}
												onChange={(e) => setConn({ ...conn, baseUrl: e.target.value })}
											/>
										</div>
										<div>
											<label className={labelCls}>{t("settings.wizard.protocol", "接口协议")}</label>
											<SegmentedControl
												ariaLabel={t("settings.form.apiType", "API Type")}
												value={conn.api}
												onValueChange={(api) => setConn({ ...conn, api })}
												items={API_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
											/>
										</div>
										<div className="flex flex-wrap items-center gap-4 text-xs text-[var(--inno-text-muted)]">
											<label className="flex items-center gap-1.5"><Checkbox checked={conn.authHeader} onChange={(e) => setConn({ ...conn, authHeader: e.target.checked })} />{t("settings.form.authHeader")}</label>
											<label className="flex items-center gap-1.5"><Checkbox checked={conn.bypassProxy} onChange={(e) => setConn({ ...conn, bypassProxy: e.target.checked })} />{t("settings.form.bypassProxy")}</label>
										</div>
									</div>
								) : null}
							</div>
							{preset.modelHint ? <p className="text-xs text-[var(--inno-text-subtle)]">{preset.modelHint}</p> : null}
						</section>

						{/* Models */}
						<section>
							<div className="mb-2 flex items-center justify-between gap-3">
								<h3 className="text-xs font-medium">
									{t("settings.wizard.models", "选择模型")}
									<span className="ml-1.5 font-normal text-[var(--inno-text-subtle)]">{t("settings.wizard.selectedCount", { count: selected.size, defaultValue: "已选 {{count}}" })}</span>
								</h3>
								{candidates.length > 6 ? (
									<div className="relative w-48">
										<Search size={14} className="inno-ui-input-leading-adornment" aria-hidden="true" />
										<Input size="sm" hasLeadingAdornment className="w-full" placeholder={t("settings.wizard.filterModels", "筛选模型") ?? ""} value={modelQuery} onChange={(e) => setModelQuery(e.target.value)} />
									</div>
								) : null}
							</div>

							{candidates.length > 0 ? (
								<ul className="grid max-h-[280px] gap-1.5 overflow-y-auto pr-0.5">
									{visibleCandidates.map((m) => {
										const added = existingIds.has(m.id);
										const checked = selected.has(m.id);
										const o = overrides[m.id];
										const ctx = Number(o?.contextWindow ?? m.contextWindow) || 0;
										const out = Number(o?.maxTokens ?? m.maxTokens) || 0;
										return (
											<li key={m.id} className={`rounded-lg border ${checked ? "border-[var(--inno-accent)] bg-[var(--inno-accent-soft)]" : "border-[var(--inno-border)]"} ${added ? "opacity-60" : ""}`}>
												<div className="flex items-center gap-2.5 px-3 py-2">
													<Checkbox checked={checked} disabled={added} onChange={() => toggle(m.id)} aria-label={m.name} />
													<button type="button" disabled={added} className="min-w-0 flex-1 text-left" onClick={() => toggle(m.id)}>
														<span className="flex flex-wrap items-center gap-1.5">
															<span className="truncate text-sm font-medium">{displayName(m, candidates)}</span>
															{m.recommended ? <span className={accentChipCls}>{t("settings.wizard.recommended", "推荐")}</span> : null}
															{added ? <span className={chipCls}>{t("settings.wizard.added", "已添加")}</span> : null}
														</span>
														<span className="mt-0.5 flex flex-wrap items-center gap-1.5">
															<code className="truncate text-xs text-[var(--inno-text-subtle)]">{m.id}</code>
														</span>
													</button>
													<div className="hidden shrink-0 flex-wrap items-center justify-end gap-1 sm:flex">
														<span className={chipCls}>{formatTokens(ctx)} context</span>
														<span className={chipCls}>{formatTokens(out)} max</span>
														{m.reasoning ? <span className={accentChipCls}>{t("settings.form.reasoning")}</span> : null}
														{m.supportsImages ? <span className={accentChipCls}>{t("settings.wizard.vision", "视觉")}</span> : null}
													</div>
													{!added ? (
														<IconButton
															size="xs"
															aria-label={t("settings.wizard.adjust", "调整参数")}
															title={t("settings.wizard.adjust", "调整参数")}
															onClick={() => setAdjusting(adjusting === m.id ? null : m.id)}
														>
															<SlidersHorizontal size={13} />
														</IconButton>
													) : null}
												</div>
												{adjusting === m.id ? (
													<div className="grid grid-cols-2 gap-2 border-t border-[var(--inno-border)] px-3 py-2.5">
														<div>
															<label className={labelCls}>{t("settings.form.contextWindow")}</label>
															<Input size="sm" className="w-full" inputMode="numeric" value={o?.contextWindow ?? String(m.contextWindow)} onChange={(e) => setOverride(m.id, { contextWindow: e.target.value }, m)} />
														</div>
														<div>
															<label className={labelCls}>{t("settings.form.maxTokens")}</label>
															<Input size="sm" className="w-full" inputMode="numeric" value={o?.maxTokens ?? String(m.maxTokens)} onChange={(e) => setOverride(m.id, { maxTokens: e.target.value }, m)} />
														</div>
													</div>
												) : null}
											</li>
										);
									})}
									{visibleCandidates.length === 0 ? <li className="py-4 text-center text-xs text-[var(--inno-text-subtle)]">{t("settings.wizard.noMatchingModels", "没有匹配的模型")}</li> : null}
								</ul>
							) : (
								<p className="rounded-lg border border-dashed border-[var(--inno-border)] px-3 py-4 text-center text-xs text-[var(--inno-text-subtle)]">
									{t("settings.wizard.noCatalog", "该提供方没有内置预置，请测试连接拉取模型，或手动输入模型 ID")}
								</p>
							)}

							{/* Manual id */}
							<div className="mt-2.5 flex gap-2">
								<Input
									size="sm"
									className="min-w-0 flex-1"
									placeholder={t("settings.wizard.manualPlaceholder", "手动添加模型 ID，回车确认") ?? ""}
									value={manualId}
									onChange={(e) => setManualId(e.target.value)}
									onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addManual(); } }}
								/>
								<Button size="sm" variant="secondary" disabled={!manualId.trim()} onClick={addManual}>
									<Plus size={12} />{t("settings.wizard.add", "添加")}
								</Button>
							</div>
						</section>
					</div>
				)}
			</div>

			{/* Footer */}
			{preset && conn ? (
				<div className="flex items-center justify-between gap-3 border-t border-[var(--inno-border)] px-5 py-3">
					<label className="flex items-center gap-1.5 text-xs text-[var(--inno-text-muted)]">
						<Checkbox checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} />
						{t("settings.form.makeDefault")}
					</label>
					<div className="flex min-w-0 items-center gap-3">
						{formError ? <span className="truncate text-xs text-[var(--inno-danger)]" title={formError}>{formError}</span> : null}
						<Button size="sm" variant="secondary" disabled={saving} onClick={onClose}>{t("common.cancel", "Cancel")}</Button>
						<Button size="sm" variant="primary" disabled={saving || selected.size === 0} onClick={() => void handleSave()}>
							{saving ? t("settings.savingProvider") : t("settings.wizard.saveCount", { count: selected.size, defaultValue: "添加 {{count}} 个模型" })}
						</Button>
					</div>
				</div>
			) : null}
		</Dialog>
	);
}

/** Primary "add model" button that opens the guided dialog. */
export function AddProviderWizard({ providers }: { providers: Record<string, InnoProviderSettings> }) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	return (
		<>
			<Button size="sm" variant="primary" onClick={() => setOpen(true)}>
				<Plus size={13} />{t("settings.wizard.title", "添加模型")}
			</Button>
			{open ? <AddModelDialog providers={providers} onClose={() => setOpen(false)} /> : null}
		</>
	);
}
