import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Trash2, Pencil, X, ChevronDown, ChevronRight } from "lucide-react";
import { settingsStore } from "../../stores/settings-store.js";
import type { InnoModelInfo, InnoProviderModel as ProviderModel, InnoSettings } from "../../types/settings.js";
import { useStoreSnapshot } from "../hooks.js";
import { Button, Checkbox, IconButton, Input, Select, SelectContent, SelectOption, SelectTrigger, SelectValue } from "../ui/index.js";
import { SettingsSection, SettingsCard } from "./primitives.js";
import { formatTokens, modelKey } from "./shared.js";
import { AddProviderWizard, ProviderIcon } from "./AddProviderWizard.js";
import { findPreset } from "./provider-presets.js";

const apiOptions = ["openai-completions", "openai-responses", "anthropic-messages"];

const labelCls = "mb-0.5 block text-xs text-[var(--inno-text-muted)]";

interface ModelEditFormState {
	baseUrl: string;
	apiKey: string;
	api: string;
	modelId: string;
	modelName: string;
	contextWindow: string;
	maxTokens: string;
	reasoning: boolean;
	supportsImages: boolean;
	authHeader: boolean;
	bypassProxy: boolean;
	makeDefault: boolean;
}

/* ---------- Model Edit Form (inline) ---------- */

function ModelEditForm({ model, settings, onClose }: {
	model: InnoModelInfo;
	settings: NonNullable<typeof settingsStore.settings>;
	onClose: () => void;
}) {
	const { t } = useTranslation();
	const provider = settings.providers[model.provider];
	const [form, setForm] = useState<ModelEditFormState>({
		baseUrl: provider?.baseUrl ?? "",
		apiKey: "",
		api: provider?.api ?? "openai-completions",
		modelId: model.id,
		modelName: model.name || model.id,
		contextWindow: String(model.contextWindow),
		maxTokens: String(model.maxTokens),
		reasoning: model.reasoning,
		supportsImages: model.input.includes("image"),
		authHeader: provider?.authHeader === true,
		bypassProxy: provider?.bypassProxy === true,
		makeDefault: settings.defaultProvider === model.provider && settings.defaultModel === model.id,
	});
	const [showAdvanced, setShowAdvanced] = useState(false);
	const [formError, setFormError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	async function handleSave() {
		const contextWindow = Number(form.contextWindow);
		const maxTokens = Number(form.maxTokens);
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
				input: form.supportsImages ? ["text", "image"] : ["text"],
				contextWindow: Math.trunc(contextWindow),
				maxTokens: Math.trunc(maxTokens),
			};
			// Merge with the provider's other models (upsert replaces the whole
			// list); the edited model goes first so makeDefault targets it.
			const models = [providerModel, ...(provider?.models ?? []).filter((m) => m.id !== model.id)];
			await settingsStore.saveProvider({
				providerId: model.provider,
				baseUrl: form.baseUrl.trim(),
				apiKey: form.apiKey,
				api: form.api,
				authHeader: form.authHeader,
				bypassProxy: form.bypassProxy,
				models,
				makeDefault: form.makeDefault,
				// Empty key field means "keep the stored key".
				preserveApiKey: true,
			});
			onClose();
		} catch (err) {
			setFormError(err instanceof Error ? err.message : "Save failed");
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="rounded-lg bg-[var(--inno-surface)] p-3">
			<div className="mb-2 flex items-center justify-between">
				<div className="flex items-center gap-2">
					<ProviderIcon providerId={model.provider} size={22} />
					<span className="text-xs font-medium text-[var(--inno-text)]">{t("settings.editModel", "Edit Model")}</span>
				</div>
				<IconButton size="xs" aria-label={t("common.close", "关闭")} title={t("common.close", "关闭")} onClick={onClose}>
					<X size={14} />
				</IconButton>
			</div>
			<div className="grid grid-cols-2 gap-2">
				<div>
					<label className={labelCls}>{t("settings.form.modelId")}</label>
					<Input size="sm" value={form.modelId} onChange={(e) => setForm({ ...form, modelId: e.target.value })} />
				</div>
				<div>
					<label className={labelCls}>{t("settings.form.modelName")}</label>
					<Input size="sm" value={form.modelName} onChange={(e) => setForm({ ...form, modelName: e.target.value })} />
				</div>
				<div className="col-span-2">
					<label className={labelCls}>
						{t("settings.form.apiKey")} {provider?.apiKey ? <span className="text-[var(--inno-text-subtle)]">(••••••••)</span> : null}
					</label>
					<Input size="sm" type="password" placeholder={provider?.apiKey ? t("settings.form.apiKeyPreserved") ?? "" : ""} value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />
				</div>
				<div className="col-span-2">
					<label className={labelCls}>{t("settings.form.baseUrl")}</label>
					<Input size="sm" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
				</div>
				<div>
					<label className={labelCls}>{t("settings.form.contextWindow")}</label>
					<Input size="sm" value={form.contextWindow} onChange={(e) => setForm({ ...form, contextWindow: e.target.value })} />
				</div>
				<div>
					<label className={labelCls}>{t("settings.form.maxTokens")}</label>
					<Input size="sm" value={form.maxTokens} onChange={(e) => setForm({ ...form, maxTokens: e.target.value })} />
				</div>
			</div>

			<button className="mt-2 flex items-center gap-1 text-xs text-[var(--inno-text-subtle)] hover:text-[var(--inno-text)]" onClick={() => setShowAdvanced((v) => !v)}>
				{showAdvanced ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
				{t("settings.wizard.advanced", "高级选项")}
			</button>
			{showAdvanced && (
				<div className="mt-1.5 grid gap-2 rounded-md bg-[var(--inno-surface-muted)] p-2.5">
					<div>
						<label className={labelCls}>{t("settings.form.apiType", "API Type")}</label>
						<Select value={form.api} onValueChange={(api) => setForm({ ...form, api })}>
							<SelectTrigger className="w-full text-xs" aria-label={t("settings.form.apiType", "API Type")}><SelectValue /></SelectTrigger>
							<SelectContent>
								{apiOptions.map((api) => <SelectOption key={api} value={api} label={api} />)}
							</SelectContent>
						</Select>
					</div>
					<div className="flex flex-wrap items-center gap-3 text-xs text-[var(--inno-text-muted)]">
						<label className="flex items-center gap-1.5"><Checkbox checked={form.reasoning} onChange={(e) => setForm({ ...form, reasoning: e.target.checked })} /> {t("settings.form.reasoning")}</label>
						<label className="flex items-center gap-1.5"><Checkbox checked={form.supportsImages} onChange={(e) => setForm({ ...form, supportsImages: e.target.checked })} /> {t("settings.form.supportsImages")}</label>
						<label className="flex items-center gap-1.5"><Checkbox checked={form.authHeader} onChange={(e) => setForm({ ...form, authHeader: e.target.checked })} /> {t("settings.form.authHeader")}</label>
						<label className="flex items-center gap-1.5"><Checkbox checked={form.bypassProxy} onChange={(e) => setForm({ ...form, bypassProxy: e.target.checked })} /> {t("settings.form.bypassProxy")}</label>
					</div>
					<p className="text-xs text-[var(--inno-text-subtle)]">{t("settings.form.supportsImagesHint")}</p>
				</div>
			)}

			<label className="mt-2 flex items-center gap-1.5 text-xs text-[var(--inno-text-muted)]">
				<Checkbox checked={form.makeDefault} onChange={(e) => setForm({ ...form, makeDefault: e.target.checked })} />
				{t("settings.form.makeDefault")}
			</label>
			{formError ? <div className="mt-2 rounded bg-[var(--inno-danger-bg)] px-2 py-1 text-xs text-[var(--inno-danger)]">{formError}</div> : null}
			<div className="mt-2 flex gap-2">
				<Button variant="primary" size="sm" disabled={saving} onClick={() => void handleSave()}>
					{saving ? t("settings.savingProvider") : t("settings.saveProvider")}
				</Button>
				<Button variant="secondary" size="sm" onClick={onClose}>
					{t("common.cancel", "Cancel")}
				</Button>
			</div>
		</div>
	);
}

/* ---------- Models category page ---------- */

export function ModelsSettings({ settings }: { settings: InnoSettings }) {
	const { t } = useTranslation();
	const [editingModel, setEditingModel] = useState<string | null>(null);
	const { isSavingModel, storeError } = useStoreSnapshot(settingsStore, () => ({
		isSavingModel: settingsStore.isSavingModel,
		storeError: settingsStore.error,
	}));

	// Only configured (config.json) models are manageable. availableModels also
	// contains the built-in provider catalog (e.g. anthropic/*), whose rows
	// cannot be edited or deleted and only confused the delete action.
	const models = settings.configuredModels ?? [];

	// Group models by provider, preserving first-seen order.
	const groups = new Map<string, InnoModelInfo[]>();
	for (const model of models) {
		const list = groups.get(model.provider) ?? [];
		list.push(model);
		groups.set(model.provider, list);
	}

	return (
		<SettingsSection title={t("settings.tabs.models")} description={t("settings.sections.models.desc", "配置模型提供商与默认模型")}>
			<SettingsCard>
				<h4 className="mb-3 text-sm font-medium text-[var(--inno-text)]">{t("settings.models")}</h4>
				{storeError ? <div className="mb-3 rounded bg-[var(--inno-danger-bg)] p-2 text-sm text-[var(--inno-danger)]">{storeError}</div> : null}
				<div className="grid gap-4">
					{[...groups.entries()].map(([providerId, providerModels]) => {
						const preset = findPreset(providerId);
						return (
							<div key={providerId}>
								<div className="mb-1.5 flex items-center gap-2">
									<ProviderIcon providerId={providerId} size={20} />
									<span className="text-xs font-medium text-[var(--inno-text)]">{preset?.name ?? providerId}</span>
									{preset?.docsUrl && (
										<a className="text-xs text-[var(--inno-text-subtle)] hover:text-[var(--inno-accent)]" href={preset.docsUrl} target="_blank" rel="noreferrer">
											{t("settings.wizard.docs", "文档")}
										</a>
									)}
								</div>
								<div className="grid gap-2">
									{providerModels.map((model) => {
										const key = modelKey(model);
										const current = settings.defaultProvider === model.provider && settings.defaultModel === model.id;
										const isEditing = editingModel === key;

										if (isEditing) {
											return (
												<ModelEditForm
													key={key}
													model={model}
													settings={settings}
													onClose={() => setEditingModel(null)}
												/>
											);
										}

										return (
											<div key={key} className={`group flex items-center justify-between rounded border p-3 ${current ? "border-[var(--inno-accent-soft)] bg-[var(--inno-accent-soft)]" : "border-[var(--inno-border)] bg-[var(--inno-surface)]"}`}>
												<div className="min-w-0 flex-1">
													<div className="flex items-center gap-1.5 text-sm font-medium text-[var(--inno-text)]">
														{model.name || model.id}
														{model.reasoning && <span className="rounded bg-[var(--inno-surface-muted)] px-1 py-px text-xs font-normal text-[var(--inno-text-muted)]">{t("settings.form.reasoning")}</span>}
														{model.input.includes("image") && <span className="rounded bg-[var(--inno-surface-muted)] px-1 py-px text-xs font-normal text-[var(--inno-text-muted)]">{t("settings.wizard.vision", "视觉")}</span>}
													</div>
													<div className="text-xs text-[var(--inno-text-muted)]">{formatTokens(model.contextWindow)} context · {formatTokens(model.maxTokens)} max</div>
												</div>
												<div className="flex items-center gap-1.5">
								<IconButton
									size="xs"
									className="opacity-0 transition-opacity group-hover:opacity-100"
									title={t("common.edit", "Edit")}
									aria-label={t("common.edit", "Edit")}
									onClick={() => setEditingModel(key)}
								>
									<Pencil size={14} />
								</IconButton>
								{!current && (
									<IconButton
										variant="danger"
										size="xs"
										className="opacity-0 transition-opacity group-hover:opacity-100"
										title={t("common.delete", "Delete")}
										aria-label={t("common.delete", "Delete")}
										onClick={() => {
										if (window.confirm(t("settings.confirmDelete", { id: `${model.provider}/${model.id}` }) ?? "")) {
											void settingsStore.deleteModel(model.provider, model.id);
										}
									}}
									>
										<Trash2 size={14} />
									</IconButton>
													)}
													{!current && (
														<button
															className="rounded-md border border-[var(--inno-border)] px-2.5 py-1 text-xs text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]"
															disabled={isSavingModel}
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
						);
					})}
				</div>
			</SettingsCard>

			{/* New Provider */}
			<AddProviderWizard providers={settings.providers} />
		</SettingsSection>
	);
}
