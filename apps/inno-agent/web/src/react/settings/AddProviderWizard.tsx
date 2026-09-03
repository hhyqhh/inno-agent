import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Plus, ExternalLink, RefreshCw, Check } from "lucide-react";
import { settingsStore } from "../../stores/settings-store.js";
import { probeProviderModels } from "../../api/settings.js";
import type { InnoProviderModel as ProviderModel, InnoProviderSettings } from "../../types/settings.js";
import { checkboxCls } from "../ui/checkbox.js";
import { formatTokens } from "./shared.js";
import { PROVIDER_PRESETS, findPreset, type ProviderPreset } from "./provider-presets.js";
import { inferModelMetadata } from "./model-metadata.js";

const apiOptions = ["openai-completions", "openai-responses", "anthropic-messages"];

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

interface WizardFormState {
	providerId: string;
	baseUrl: string;
	apiKey: string;
	api: string;
	modelId: string;
	contextWindow: string;
	maxTokens: string;
	reasoning: boolean;
	supportsImages: boolean;
	authHeader: boolean;
	bypassProxy: boolean;
	makeDefault: boolean;
}

function formFromPreset(preset: ProviderPreset, existingProviders: Record<string, InnoProviderSettings>): WizardFormState {
	return {
		providerId: preset.id === "custom" ? "" : preset.id,
		baseUrl: preset.baseUrl,
		apiKey: "",
		api: preset.api,
		modelId: "",
		contextWindow: "128000",
		maxTokens: "8192",
		reasoning: false,
		supportsImages: false,
		authHeader: false,
		bypassProxy: false,
		// First configured model becomes the default automatically.
		makeDefault: Object.keys(existingProviders).length === 0,
	};
}

const inputCls = "w-full rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2.5 py-1.5 text-xs text-[var(--inno-text)] focus:border-[var(--inno-accent)] focus:outline-none";
const labelCls = "mb-0.5 block text-xs text-[var(--inno-text-muted)]";

/**
 * Guided add-provider wizard (cc-switch style): pick a preset, paste an API
 * key, pull the model list from the provider, pick a model — context and
 * capability fields are auto-filled and tucked into an advanced section.
 */
export function AddProviderWizard({ providers }: { providers: Record<string, InnoProviderSettings> }) {
	const { t } = useTranslation();
	const [expanded, setExpanded] = useState(false);
	const [preset, setPreset] = useState<ProviderPreset | null>(null);
	const [form, setForm] = useState<WizardFormState | null>(null);
	const [showAdvanced, setShowAdvanced] = useState(false);
	const [fetchedModels, setFetchedModels] = useState<string[] | null>(null);
	const [modelPickerOpen, setModelPickerOpen] = useState(false);
	const [activeModelIndex, setActiveModelIndex] = useState(-1);
	const [probing, setProbing] = useState(false);
	const [probeError, setProbeError] = useState<string | null>(null);
	const [formError, setFormError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const modelPickerRef = useRef<HTMLDivElement>(null);

	// Close the fetched-model listbox on outside click or Escape while open.
	useEffect(() => {
		if (!modelPickerOpen) return;
		function onPointerDown(event: MouseEvent) {
			if (modelPickerRef.current && !modelPickerRef.current.contains(event.target as Node)) {
				setModelPickerOpen(false);
			}
		}
		function onKeyDown(event: KeyboardEvent) {
			if (event.key === "Escape") setModelPickerOpen(false);
		}
		document.addEventListener("mousedown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("mousedown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [modelPickerOpen]);

	const existingProviders = providers;

	function reset() {
		setPreset(null);
		setForm(null);
		setShowAdvanced(false);
		setFetchedModels(null);
		setModelPickerOpen(false);
		setProbeError(null);
		setFormError(null);
	}

	function selectPreset(p: ProviderPreset) {
		setPreset(p);
		setForm(formFromPreset(p, existingProviders));
		setFetchedModels(null);
		setModelPickerOpen(false);
		setProbeError(null);
		setFormError(null);
	}

	function applyModel(modelId: string) {
		if (!form) return;
		const meta = inferModelMetadata(modelId);
		setForm({
			...form,
			modelId,
			contextWindow: String(meta.contextWindow),
			maxTokens: String(meta.maxTokens),
			reasoning: meta.reasoning,
			supportsImages: meta.supportsImages,
		});
	}

	function selectModel(modelId: string) {
		applyModel(modelId);
		setModelPickerOpen(false);
	}

	function toggleModelPicker() {
		setModelPickerOpen((open) => {
			if (!open && fetchedModels?.length) {
				setActiveModelIndex(Math.max(0, fetchedModels.indexOf(form?.modelId ?? "")));
			}
			return !open;
		});
	}

	/** Combobox keyboard navigation: arrows move the active option, Enter selects. */
	function handleModelKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
		if (!fetchedModels?.length) return;
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			if (!modelPickerOpen) {
				setModelPickerOpen(true);
				setActiveModelIndex(Math.max(0, fetchedModels.indexOf(form?.modelId ?? "")));
				return;
			}
			const delta = event.key === "ArrowDown" ? 1 : -1;
			setActiveModelIndex((index) => {
				const next = Math.min(fetchedModels.length - 1, Math.max(0, index + delta));
				document.getElementById(`inno-probed-model-${next}`)?.scrollIntoView({ block: "nearest" });
				return next;
			});
		} else if (event.key === "Enter" && modelPickerOpen && activeModelIndex >= 0) {
			event.preventDefault();
			selectModel(fetchedModels[activeModelIndex]);
		}
	}

	async function handleProbe() {
		if (!form) return;
		setProbing(true);
		setProbeError(null);
		try {
			const existing = existingProviders[form.providerId];
			const result = await probeProviderModels({
				baseUrl: form.baseUrl,
				apiKey: form.apiKey,
				providerId: existing?.apiKey ? form.providerId : undefined,
				api: form.api,
			});
			const models = [...new Set(result.models.map((id) => id.trim()).filter(Boolean))];
			setFetchedModels(models);
			setModelPickerOpen(false);
			if (models.length > 0 && !form.modelId) applyModel(models[0]);
		} catch (err) {
			setFetchedModels(null);
			setProbeError(err instanceof Error ? err.message : String(err));
		} finally {
			setProbing(false);
		}
	}

	async function handleSave() {
		if (!form) return;
		const contextWindow = Number(form.contextWindow);
		const maxTokens = Number(form.maxTokens);
		if (!form.providerId.trim()) return setFormError(t("settings.errors.providerRequired"));
		if (!form.baseUrl.trim()) return setFormError(t("settings.errors.baseUrlRequired"));
		if (!form.modelId.trim()) return setFormError(t("settings.errors.modelRequired"));
		if (!Number.isFinite(contextWindow) || contextWindow <= 0 || !Number.isFinite(maxTokens) || maxTokens <= 0) {
			return setFormError(t("settings.errors.tokensInvalid"));
		}
		setSaving(true);
		setFormError(null);
		try {
			const providerId = form.providerId.trim();
			const existing = existingProviders[providerId];
			const model: ProviderModel = {
				id: form.modelId.trim(),
				name: form.modelId.trim(),
				reasoning: form.reasoning,
				input: form.supportsImages ? ["text", "image"] : ["text"],
				contextWindow: Math.trunc(contextWindow),
				maxTokens: Math.trunc(maxTokens),
			};
			// Adding to an existing provider merges with its models instead of
			// replacing them; the new model goes first so makeDefault targets it
			// (the backend takes models[0] as the default). Leaving the key
			// blank keeps the stored one.
			const models = [model, ...(existing?.models ?? []).filter((m) => m.id !== model.id)];
			await settingsStore.saveProvider({
				providerId,
				baseUrl: form.baseUrl.trim(),
				apiKey: form.apiKey,
				api: form.api,
				authHeader: form.authHeader,
				bypassProxy: form.bypassProxy,
				models,
				makeDefault: form.makeDefault,
				preserveApiKey: true,
			});
			setExpanded(false);
			reset();
		} catch (err) {
			setFormError(err instanceof Error ? err.message : "Save failed");
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)]">
			<button
				className="flex w-full items-center justify-between px-4 py-3 text-left"
				onClick={() => { setExpanded((v) => !v); reset(); }}
			>
				<div className="flex items-center gap-2">
					{expanded ? <ChevronDown size={14} className="text-[var(--inno-text-subtle)]" /> : <ChevronRight size={14} className="text-[var(--inno-text-subtle)]" />}
					<span className="text-sm font-medium text-[var(--inno-text)]">{t("settings.newProvider")}</span>
				</div>
				<Plus size={14} className="text-[var(--inno-text-subtle)]" />
			</button>

			{expanded && (
				<div className="border-t border-[var(--inno-border)] px-4 pb-4 pt-3">
					{/* Step 1: preset picker */}
					{!form && (
						<div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
							{PROVIDER_PRESETS.map((p) => (
								<button
									key={p.id}
									className="flex items-center gap-2.5 rounded-lg border border-[var(--inno-border)] p-2.5 text-left transition-colors hover:border-[var(--inno-accent)] hover:bg-[var(--inno-surface-muted)]"
									onClick={() => selectPreset(p)}
								>
									<ProviderIcon providerId={p.id} size={30} />
									<span className="min-w-0">
										<span className="block truncate text-xs font-medium text-[var(--inno-text)]">{p.name}</span>
										<span className="block truncate text-xs text-[var(--inno-text-subtle)]">{p.description}</span>
									</span>
								</button>
							))}
						</div>
					)}

					{/* Step 2: guided form */}
					{form && preset && (
						<div>
							<div className="mb-3 flex items-center justify-between">
								<div className="flex items-center gap-2.5">
									<ProviderIcon providerId={preset.id} size={26} />
									<span className="text-sm font-medium text-[var(--inno-text)]">{preset.name}</span>
									{preset.docsUrl && (
										<a className="flex items-center gap-0.5 text-xs text-[var(--inno-text-subtle)] hover:text-[var(--inno-accent)]" href={preset.docsUrl} target="_blank" rel="noreferrer">
											{t("settings.wizard.docs", "文档")} <ExternalLink size={10} />
										</a>
									)}
								</div>
								<button className="text-xs text-[var(--inno-text-subtle)] hover:text-[var(--inno-text)]" onClick={reset}>
									{t("settings.wizard.changePreset", "更换提供方")}
								</button>
							</div>

							<div className="grid gap-2">
								{/* Custom providers need an identity and endpoint before they can be saved. */}
								{preset.id === "custom" && (
									<>
										<div>
											<label className={labelCls}>{t("settings.form.providerId")}</label>
											<input
												className={inputCls}
												value={form.providerId}
												onChange={(e) => setForm({ ...form, providerId: e.target.value })}
												required
											/>
										</div>
										<div>
											<label className={labelCls}>{t("settings.form.baseUrl")}</label>
											<input
												className={inputCls}
												type="url"
												placeholder="https://api.example.com/v1"
												value={form.baseUrl}
												onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
												required
											/>
										</div>
									</>
								)}

								{/* API key + console link */}
								<div>
									<div className="mb-0.5 flex items-center justify-between">
										<label className="text-xs text-[var(--inno-text-muted)]">{t("settings.form.apiKey")}</label>
										{preset.consoleUrl && (
											<a className="flex items-center gap-0.5 text-xs text-[var(--inno-accent)] hover:underline" href={preset.consoleUrl} target="_blank" rel="noreferrer">
												{t("settings.wizard.getApiKey", "获取 API Key")} <ExternalLink size={10} />
											</a>
										)}
									</div>
									<input
										className={inputCls}
										type="password"
										placeholder={existingProviders[form.providerId] ? t("settings.form.apiKeyPreserved") ?? "" : "sk-..."}
										value={form.apiKey}
										onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
									/>
								</div>

								{/* Model fetch + pick */}
								<div>
									<div className="mb-0.5 flex items-center justify-between">
										<label className="text-xs text-[var(--inno-text-muted)]">{t("settings.form.modelId")}</label>
										<button
											className="flex items-center gap-1 text-xs text-[var(--inno-accent)] hover:underline disabled:opacity-50"
											disabled={probing || !form.baseUrl.trim()}
											onClick={() => void handleProbe()}
										>
											<RefreshCw size={10} className={probing ? "animate-spin" : ""} />
											{probing
												? t("settings.wizard.fetching", "拉取中…")
												: fetchedModels
													? t("settings.wizard.fetchedCount", { count: fetchedModels.length })
													: t("settings.wizard.fetchModels", "拉取模型列表")}
										</button>
									</div>
									<div className="relative" ref={modelPickerRef}>
										<input
											className={`${inputCls}${fetchedModels?.length ? " pr-8" : ""}`}
											role="combobox"
											aria-controls="inno-probed-models"
											aria-expanded={modelPickerOpen}
											aria-activedescendant={modelPickerOpen && activeModelIndex >= 0 ? `inno-probed-model-${activeModelIndex}` : undefined}
											placeholder={t("settings.wizard.modelPlaceholder", "输入或从拉取的列表中选择") ?? ""}
											value={form.modelId}
											onChange={(e) => applyModel(e.target.value)}
											onKeyDown={handleModelKeyDown}
										/>
										{fetchedModels?.length ? (
											<button
												type="button"
												aria-label={modelPickerOpen ? t("settings.wizard.collapseModelList", "收起模型列表") : t("settings.wizard.expandModelList", "展开模型列表")}
												className="absolute right-0 top-0 flex h-full w-8 items-center justify-center text-[var(--inno-text-subtle)] hover:text-[var(--inno-text)]"
												onClick={toggleModelPicker}
											>
												<ChevronDown size={14} className={`transition-transform${modelPickerOpen ? " rotate-180" : ""}`} />
											</button>
										) : null}
										{modelPickerOpen && fetchedModels?.length ? (
											<div id="inno-probed-models" role="listbox" className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] p-1 shadow-lg">
												{fetchedModels.map((id, index) => (
													<button
														key={id}
														id={`inno-probed-model-${index}`}
														type="button"
														role="option"
														aria-selected={form.modelId === id}
																className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs text-[var(--inno-text)] hover:bg-[var(--inno-surface-muted)]${index === activeModelIndex ? " bg-[var(--inno-surface-muted)]" : ""}`}
														onMouseEnter={() => setActiveModelIndex(index)}
														onClick={() => selectModel(id)}
															>
																<span className="block truncate">{id}</span>
																{form.modelId === id && <Check size={14} className="shrink-0 text-[var(--inno-accent)]" />}
															</button>
												))}
											</div>
										) : null}
									</div>
									{preset.modelHint && <p className="mt-1 text-xs text-[var(--inno-text-subtle)]">{preset.modelHint}</p>}
									{probeError && <p className="mt-1 text-xs text-[var(--inno-danger)]">{probeError}</p>}
									{form.modelId && (
										<div className="mt-1.5 flex flex-wrap items-center gap-1.5">
											<span className="rounded bg-[var(--inno-surface-muted)] px-1.5 py-0.5 text-xs text-[var(--inno-text-muted)]">{formatTokens(Number(form.contextWindow) || 0)} context</span>
											<span className="rounded bg-[var(--inno-surface-muted)] px-1.5 py-0.5 text-xs text-[var(--inno-text-muted)]">{formatTokens(Number(form.maxTokens) || 0)} max</span>
											{form.reasoning && <span className="rounded bg-[var(--inno-accent-soft)] px-1.5 py-0.5 text-xs text-[var(--inno-accent)]">{t("settings.form.reasoning")}</span>}
											{form.supportsImages && <span className="rounded bg-[var(--inno-accent-soft)] px-1.5 py-0.5 text-xs text-[var(--inno-accent)]">{t("settings.wizard.vision", "视觉")}</span>}
											<span className="flex items-center gap-0.5 text-xs text-[var(--inno-success)]"><Check size={10} />{t("settings.wizard.autoFilled", "参数已自动填充")}</span>
										</div>
									)}
								</div>

								{/* Advanced */}
								<button
									className="mt-1 flex items-center gap-1 text-xs text-[var(--inno-text-subtle)] hover:text-[var(--inno-text)]"
									onClick={() => setShowAdvanced((v) => !v)}
								>
									{showAdvanced ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
									{t("settings.wizard.advanced", "高级选项")}
								</button>
								{showAdvanced && (
									<div className="grid grid-cols-2 gap-2 rounded-md bg-[var(--inno-surface-muted)] p-2.5">
										{preset.id !== "custom" && (
											<div>
												<label className={labelCls}>{t("settings.form.providerId")}</label>
												<input className={inputCls} value={form.providerId} onChange={(e) => setForm({ ...form, providerId: e.target.value })} />
											</div>
										)}
										<div>
											<label className={labelCls}>{t("settings.form.apiType", "API Type")}</label>
											<select className={inputCls} value={form.api} onChange={(e) => setForm({ ...form, api: e.target.value })}>
												{apiOptions.map((api) => <option key={api} value={api}>{api}</option>)}
											</select>
										</div>
										{preset.id !== "custom" && (
											<div className="col-span-2">
												<label className={labelCls}>{t("settings.form.baseUrl")}</label>
												<input className={inputCls} value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
											</div>
										)}
										<div>
											<label className={labelCls}>{t("settings.form.contextWindow")}</label>
											<input className={inputCls} value={form.contextWindow} onChange={(e) => setForm({ ...form, contextWindow: e.target.value })} />
										</div>
										<div>
											<label className={labelCls}>{t("settings.form.maxTokens")}</label>
											<input className={inputCls} value={form.maxTokens} onChange={(e) => setForm({ ...form, maxTokens: e.target.value })} />
										</div>
										<div className="col-span-2 flex flex-wrap items-center gap-3 text-xs text-[var(--inno-text-muted)]">
											<label className="flex items-center gap-1.5"><input type="checkbox" className={checkboxCls} checked={form.reasoning} onChange={(e) => setForm({ ...form, reasoning: e.target.checked })} /> {t("settings.form.reasoning")}</label>
											<label className="flex items-center gap-1.5"><input type="checkbox" className={checkboxCls} checked={form.supportsImages} onChange={(e) => setForm({ ...form, supportsImages: e.target.checked })} /> {t("settings.form.supportsImages")}</label>
											<label className="flex items-center gap-1.5"><input type="checkbox" className={checkboxCls} checked={form.authHeader} onChange={(e) => setForm({ ...form, authHeader: e.target.checked })} /> {t("settings.form.authHeader")}</label>
											<label className="flex items-center gap-1.5"><input type="checkbox" className={checkboxCls} checked={form.bypassProxy} onChange={(e) => setForm({ ...form, bypassProxy: e.target.checked })} /> {t("settings.form.bypassProxy")}</label>
										</div>
									</div>
								)}

								<label className="mt-1 flex items-center gap-1.5 text-xs text-[var(--inno-text-muted)]">
									<input type="checkbox" className={checkboxCls} checked={form.makeDefault} onChange={(e) => setForm({ ...form, makeDefault: e.target.checked })} />
									{t("settings.form.makeDefault")}
								</label>
							</div>

							{formError ? <div className="mt-2 rounded bg-[var(--inno-danger-bg)] px-2 py-1 text-xs text-[var(--inno-danger)]">{formError}</div> : null}
							<div className="mt-3 flex gap-2">
								<button className="rounded-md inno-primary-button px-3 py-1.5 text-xs text-white disabled:opacity-50" disabled={saving} onClick={() => void handleSave()}>
									{saving ? t("settings.savingProvider") : t("settings.saveProvider")}
								</button>
								<button className="rounded-md border border-[var(--inno-border)] px-3 py-1.5 text-xs text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)]" onClick={() => { setExpanded(false); reset(); }}>
									{t("common.cancel", "Cancel")}
								</button>
							</div>
						</div>
					)}
				</div>
			)}
		</div>
	);
}
