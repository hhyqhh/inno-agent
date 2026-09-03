import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";
import { settingsStore } from "../../stores/settings-store.js";
import { useStoreSnapshot } from "../hooks.js";
import { Switch } from "../ui/Switch.js";
import { Spinner } from "../ui/Spinner.js";
import { SettingsCard, SettingsRow, SettingsSection } from "./primitives.js";
import { kindFromRule } from "../chat/smart-input/kinds.js";
import { FileTypeIcon } from "../FileTypeIcon.js";
import type { SmartInputRule, SmartInputSettings } from "../../types/settings.js";

/**
 * Smart Input (便捷输入) settings: master switch + interaction toggles and a
 * keyword-rule manager. A rule can use a compact allow-list, accept every
 * format, and optionally carry a separate exclusion list.
 */

const EXT_PATTERN = /^\.[a-z0-9]+$/i;

function normalizeExt(raw: string): string | null {
	const trimmed = raw.trim().toLowerCase();
	if (!trimmed) return null;
	const withDot = trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
	return EXT_PATTERN.test(withDot) ? withDot : null;
}

type ExtensionListKind = "include" | "exclude";

interface RuleDraft {
	keyword: string;
	extensions: string[];
	allExtensions: boolean;
	excludeExtensions: string[];
	isPreset: boolean;
}

type FormatRule = Pick<SmartInputRule, "extensions" | "allExtensions" | "excludeExtensions" | "isPreset">;

export function SmartInputSettings() {
	const { t } = useTranslation();
	const state = useStoreSnapshot(settingsStore, () => ({
		smartInput: settingsStore.settings?.smartInput,
		isSaving: settingsStore.isSavingSmartInput,
	}));
	const smartInput = state.smartInput;

	const [draft, setDraft] = useState<SmartInputSettings | null>(smartInput ?? null);
	const [editingKeywordId, setEditingKeywordId] = useState<string | null>(null);
	const [keywordInput, setKeywordInput] = useState("");
	const [extInputTarget, setExtInputTarget] = useState<{ id: string; kind: ExtensionListKind } | null>(null);
	const [extInput, setExtInput] = useState("");
	const [newRule, setNewRule] = useState<RuleDraft | null>(null);
	const [error, setError] = useState("");
	const extInputRef = useRef<HTMLInputElement | null>(null);
	const keywordInputRef = useRef<HTMLInputElement | null>(null);
	const newKeywordRef = useRef<HTMLInputElement | null>(null);

	// Server responses are the source of truth once a save settles.
	useEffect(() => {
		if (!state.isSaving && smartInput) setDraft(smartInput);
	}, [smartInput, state.isSaving]);

	if (!draft) return null;

	const persist = (next: SmartInputSettings) => {
		setDraft(next);
		setError("");
		void settingsStore.saveSmartInput(next).catch(() => {
			// Revert to the last server-known value on failure.
			setDraft(settingsStore.settings?.smartInput ?? next);
			setError(t("settings.smartInput.saveFailed", "保存失败，已恢复上次配置"));
		});
	};

	const patchConfig = (patch: Partial<SmartInputSettings>) => persist({ ...draft, ...patch });

	const patchRule = (id: string, patch: Partial<SmartInputRule>) => {
		patchConfig({ rules: draft.rules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)) });
	};

	const closeExtensionInput = () => {
		setExtInputTarget(null);
		setExtInput("");
	};

	const beginExtensionInput = (id: string, kind: ExtensionListKind) => {
		setExtInputTarget({ id, kind });
		setExtInput("");
		requestAnimationFrame(() => extInputRef.current?.focus());
	};

	const commitKeyword = (rule: SmartInputRule): void => {
		const keyword = keywordInput.trim();
		if (!keyword) {
			setError(t("settings.smartInput.keywordEmpty", "关键词不能为空"));
			return;
		}
		if (draft.rules.some((entry) => entry.id !== rule.id && entry.keyword === keyword)) {
			setError(t("settings.smartInput.keywordDuplicate", "关键词已存在"));
			return;
		}
		setError("");
		setEditingKeywordId(null);
		patchRule(rule.id, { keyword });
	};

	const extensionsFor = (rule: FormatRule, kind: ExtensionListKind): string[] =>
		kind === "include" ? rule.extensions : rule.excludeExtensions;

	const commitExtension = (rule: SmartInputRule, kind: ExtensionListKind): void => {
		const ext = normalizeExt(extInput);
		if (!ext) {
			setError(t("settings.smartInput.extInvalid", "后缀格式无效（例：pdf 或 .pdf）"));
			return;
		}
		const values = extensionsFor(rule, kind);
		if (values.includes(ext)) {
			setError(t("settings.smartInput.extDuplicate", "该后缀已存在"));
			return;
		}
		setError("");
		closeExtensionInput();
		patchRule(rule.id, kind === "include"
			? { extensions: [...values, ext] }
			: { excludeExtensions: [...values, ext] });
	};

	const commitNewExtension = (kind: ExtensionListKind): void => {
		if (!newRule) return;
		const ext = normalizeExt(extInput);
		if (!ext) {
			setError(t("settings.smartInput.extInvalid", "后缀格式无效（例：pdf 或 .pdf）"));
			return;
		}
		const values = extensionsFor(newRule, kind);
		if (values.includes(ext)) {
			setError(t("settings.smartInput.extDuplicate", "该后缀已存在"));
			return;
		}
		setError("");
		setExtInput("");
		setNewRule({
			...newRule,
			...(kind === "include"
				? { extensions: [...values, ext] }
				: { excludeExtensions: [...values, ext] }),
		});
		requestAnimationFrame(() => extInputRef.current?.focus());
	};

	const commitNewRule = (): void => {
		if (!newRule) return;
		const keyword = newRule.keyword.trim();
		if (!keyword) {
			setError(t("settings.smartInput.keywordEmpty", "关键词不能为空"));
			return;
		}
		if (draft.rules.some((rule) => rule.keyword === keyword)) {
			setError(t("settings.smartInput.keywordDuplicate", "关键词已存在"));
			return;
		}
		// A rule may be saved before formats are configured. It simply remains
		// inactive for file matching until the user adds an allow-list or turns
		// on all-formats mode.
		setError("");
		setNewRule(null);
		closeExtensionInput();
		patchConfig({
			rules: [
				{ id: `smart-rule-${Date.now().toString(36)}`, isPreset: false, keyword, extensions: newRule.extensions, allExtensions: newRule.allExtensions, excludeExtensions: newRule.excludeExtensions, enabled: true },
				...draft.rules,
			],
		});
	};

	const masterDisabled = !draft.enabled;

	const renderKeywordPill = (rule: SmartInputRule) => {
		const kind = kindFromRule(rule);
		const editing = editingKeywordId === rule.id;
		if (editing) {
			return (
				<input
					ref={keywordInputRef}
					className="inno-smart-set-keyword-input"
					value={keywordInput}
					spellCheck={false}
					onChange={(event) => setKeywordInput(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") { event.preventDefault(); commitKeyword(rule); }
						if (event.key === "Escape") { setEditingKeywordId(null); setError(""); }
					}}
					onBlur={() => commitKeyword(rule)}
				/>
			);
		}
		return (
			<button
				type="button"
				className={`inno-smart-set-pill ${rule.enabled ? "" : "is-off"}`}
				title={t("settings.smartInput.renameKeyword", "点击重命名关键词")}
				onClick={() => {
					setEditingKeywordId(rule.id);
					setKeywordInput(rule.keyword);
					requestAnimationFrame(() => keywordInputRef.current?.select());
				}}
			>
				<FileTypeIcon kind={kind} size={13} color={rule.enabled ? undefined : "var(--inno-text-subtle)"} />
				{rule.keyword}
			</button>
		);
	};

	const renderExtensionList = (
		id: string,
		kind: ExtensionListKind,
		values: string[],
		emptyText: string,
		onRemove: (ext: string) => void,
		onCommit: () => void,
	) => {
		const editing = extInputTarget?.id === id && extInputTarget.kind === kind;
		return (
			<div className="inno-smart-set-exts">
					{values.length === 0 && emptyText ? <span className="inno-smart-set-empty">{emptyText}</span> : null}
				{values.map((ext) => (
					<span key={ext} className="inno-smart-set-ext">
						{ext}
						<button
							type="button"
							className="inno-smart-set-ext-x"
							title={t("settings.smartInput.removeExt", "移除格式")}
							onClick={() => onRemove(ext)}
						>
							×
						</button>
					</span>
				))}
				{editing ? (
					<input
						ref={extInputRef}
						className="inno-smart-set-ext-input"
						placeholder={t("settings.smartInput.extensionPlaceholder", "如 pdf")}
						aria-label={kind === "include"
							? t("settings.smartInput.allowFormats", "允许格式")
							: t("settings.smartInput.excludeFormats", "排除格式")}
						value={extInput}
						spellCheck={false}
						onChange={(event) => setExtInput(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") { event.preventDefault(); onCommit(); }
							if (event.key === "Escape") { closeExtensionInput(); setError(""); }
						}}
						onBlur={() => { if (extInput.trim()) onCommit(); else closeExtensionInput(); }}
					/>
				) : (
					<button
						type="button"
						className="inno-smart-set-ext-add"
						title={kind === "include"
							? t("settings.smartInput.addIncludeExt", "添加允许格式")
							: t("settings.smartInput.addExcludeExt", "添加排除格式")}
						disabled={state.isSaving}
						onClick={() => beginExtensionInput(id, kind)}
					>
						<Plus size={11} />
					</button>
				)}
			</div>
		);
	};

	const renderFormatSections = (
		id: string,
		rule: FormatRule,
		onToggleAll: () => void,
		onRemove: (kind: ExtensionListKind, ext: string) => void,
		onCommit: (kind: ExtensionListKind) => void,
	) => {
		// Every rule — presets included — exposes the all-formats switch; the
		// "文件" preset itself ships in all-formats mode.
		const canUseAllFormats = true;
		const allFormats = canUseAllFormats && rule.allExtensions;
		return (
			<div className="inno-smart-set-format-grid">
				<div className="inno-smart-set-format-block">
					<div className="inno-smart-set-format-label">
						<span>{t("settings.smartInput.allowFormats", "允许格式")}</span>
						<span className="inno-smart-set-format-head">
							<span className={`inno-smart-set-format-count ${!allFormats && rule.extensions.length === 0 ? "is-empty" : ""}`}>
								{allFormats
									? t("settings.smartInput.allFormatsShort", "全部")
									: rule.extensions.length > 0
										? t("settings.smartInput.formatCount", "{{count}} 项", { count: rule.extensions.length })
										: t("settings.smartInput.noFormats", "尚未添加（暂不匹配文件）")}
							</span>
							{canUseAllFormats ? (
								<span className="inno-smart-set-all-row">
									<span className="inno-smart-set-all-text">{t("settings.smartInput.allFormats", "全部格式均可")}</span>
									<Switch checked={allFormats} disabled={state.isSaving} onChange={onToggleAll} aria-label={t("settings.smartInput.allFormats", "全部格式均可")} />
								</span>
							) : null}
						</span>
					</div>
					<div className="inno-smart-set-format-values">
						{allFormats ? (
							rule.extensions.length > 0 ? (
								<span className="inno-smart-set-all-hint">
									{t("settings.smartInput.allFormatsSavedHint", "已保留 {{count}} 项具体格式，关闭后可继续编辑", { count: rule.extensions.length })}
								</span>
							) : null
						) : (
							renderExtensionList(
								id,
								"include",
								rule.extensions,
								"",
								(ext) => onRemove("include", ext),
								() => onCommit("include"),
							)
						)}
					</div>
				</div>
			<div className="inno-smart-set-format-block is-exclude">
				<div className="inno-smart-set-format-label">
					<span>{t("settings.smartInput.excludeFormats", "排除格式")}</span>
					<span className="inno-smart-set-format-count">
						{rule.excludeExtensions.length > 0
							? t("settings.smartInput.formatCount", "{{count}} 项", { count: rule.excludeExtensions.length })
							: t("settings.smartInput.none", "无")}
					</span>
				</div>
				{renderExtensionList(
					id,
					"exclude",
					rule.excludeExtensions,
					t("settings.smartInput.noExclusions", "不排除任何格式"),
					(ext) => onRemove("exclude", ext),
					() => onCommit("exclude"),
				)}
			</div>
		</div>
		);
	};

	const renderRuleRow = (rule: SmartInputRule) => (
		<div key={rule.id} className={`inno-smart-set-row ${rule.enabled ? "" : "is-off"}`}>
			<div className="inno-smart-set-row-head">
				<div className="inno-smart-set-identity">
					{renderKeywordPill(rule)}
					<span className="inno-smart-set-mode">
						{rule.allExtensions
							? t("settings.smartInput.allFormatsShort", "全部格式")
							: rule.extensions.length > 0
								? t("settings.smartInput.formatCount", "{{count}} 项", { count: rule.extensions.length })
								: t("settings.smartInput.notConfigured", "未配置")}
					</span>
				</div>
				<span className="flex shrink-0 items-center gap-2.5">
					<Switch
						checked={rule.enabled}
						disabled={state.isSaving}
						aria-label={t("settings.smartInput.toggleRule", "启用该关键词")}
						onChange={(value) => patchRule(rule.id, { enabled: value })}
					/>
					<button
						type="button"
						className="inno-smart-set-delete"
						title={rule.isPreset
							? t("settings.smartInput.presetRuleHint", "系统预设关键词不可删除，只能关闭")
							: t("settings.smartInput.deleteRule", "删除规则")}
						disabled={state.isSaving || rule.isPreset}
						onClick={rule.isPreset ? undefined : () => patchConfig({ rules: draft.rules.filter((entry) => entry.id !== rule.id) })}
					>
						<Trash2 size={14} />
					</button>
				</span>
			</div>
			{renderFormatSections(
				rule.id,
				rule,
				() => patchRule(rule.id, { allExtensions: !rule.allExtensions }),
				(kind, ext) => patchRule(rule.id, kind === "include"
					? { extensions: rule.extensions.filter((entry) => entry !== ext) }
					: { excludeExtensions: rule.excludeExtensions.filter((entry) => entry !== ext) }),
				(kind) => commitExtension(rule, kind),
			)}
		</div>
	);

	const renderNewRuleRow = () => newRule ? (
		<div className="inno-smart-set-row is-new">
			<div className="inno-smart-set-row-head">
				<input
					ref={newKeywordRef}
					className="inno-smart-set-keyword-input is-primary"
					placeholder={t("settings.smartInput.newKeywordPlaceholder", "关键词")}
					value={newRule.keyword}
					spellCheck={false}
					onChange={(event) => setNewRule({ ...newRule, keyword: event.target.value })}
					onKeyDown={(event) => {
						if (event.key === "Enter") { event.preventDefault(); commitNewRule(); }
						if (event.key === "Escape") { setNewRule(null); closeExtensionInput(); setError(""); }
					}}
				/>
				<span className="inno-smart-set-new-hint">{t("settings.smartInput.newRuleHint", "格式可稍后配置")}</span>
				<span className="flex shrink-0 items-center gap-2">
					<button type="button" className="inno-smart-set-action is-ghost" onClick={() => { setNewRule(null); closeExtensionInput(); setError(""); }}>
						{t("common.cancel", "取消")}
					</button>
					<button type="button" className="inno-smart-set-action is-primary" disabled={state.isSaving} onClick={commitNewRule}>
						{t("common.save", "保存")}
					</button>
				</span>
			</div>
			{renderFormatSections(
				"__new__",
				newRule,
				() => setNewRule({ ...newRule, allExtensions: !newRule.allExtensions }),
				(kind, ext) => setNewRule({
					...newRule,
					...(kind === "include"
						? { extensions: newRule.extensions.filter((entry) => entry !== ext) }
						: { excludeExtensions: newRule.excludeExtensions.filter((entry) => entry !== ext) }),
				}),
				(kind) => commitNewExtension(kind),
			)}
		</div>
	) : null;

	return (
		<SettingsSection
			title={<span className="inline-flex items-center gap-1">{t("settings.smartInput.title", "便捷输入")} <span className="inno-smart-beta inno-smart-beta--settings">Beta</span></span>}
			description={t("settings.smartInput.desc", "在输入框输入关键词即可转为文件气泡，把文件明确绑定到指代词")}
		>
			<SettingsCard>
				<SettingsRow
					label={<span className="inline-flex items-center gap-1">{t("settings.smartInput.master", "便捷输入")} <span className="inno-smart-beta inno-smart-beta--settings">Beta</span></span>}
					description={t("settings.smartInput.masterDesc", "开启后输入 pdf / word 等关键词出现红色下划线，点击或拖入文件转为气泡")}
					control={<Switch checked={draft.enabled} disabled={state.isSaving} onChange={(value) => patchConfig({ enabled: value })} />}
				/>
				<div className={`mt-3 ml-0.5 border-l-2 border-[var(--inno-border)] pl-3 ${masterDisabled ? "opacity-60" : ""}`}>
					<div className="grid gap-3">
						<SettingsRow
							label={t("settings.smartInput.allowDrag", "允许拖入填充")}
							description={t("settings.smartInput.allowDragDesc", "拖文件到气泡绑定；拖文件悬停关键词 1 秒自动转换")}
							control={<Switch checked={draft.allowDrag} disabled={masterDisabled || state.isSaving} onChange={(value) => patchConfig({ allowDrag: value })} />}
						/>
						<SettingsRow
							label={t("settings.smartInput.allowRightClick", "允许右键附件转气泡")}
							description={t("settings.smartInput.allowRightClickDesc", "附件右键「插入为气泡」")}
							control={<Switch checked={draft.allowRightClick} disabled={masterDisabled || state.isSaving} onChange={(value) => patchConfig({ allowRightClick: value })} />}
						/>
						<SettingsRow
							label={t("settings.smartInput.allowAgentCommands", "允许 Agent 命令转气泡")}
							description={t("settings.smartInput.allowAgentCommandsDesc", "输入“技能”或 skill 可选择技能；从 / Agent 命令中选择后生成命令气泡")}
							control={<Switch checked={draft.allowAgentCommands} disabled={masterDisabled || state.isSaving} onChange={(value) => patchConfig({ allowAgentCommands: value })} />}
						/>
					</div>
				</div>
			</SettingsCard>

			<SettingsCard className={`inno-smart-set-card ${masterDisabled ? "opacity-60" : ""}`}>
				<div className="inno-smart-set-card-head">
					<div className="flex min-w-0 items-center gap-2">
						<h4 className="text-sm font-medium text-[var(--inno-text)]">{t("settings.smartInput.rules", "关键词规则")}</h4>
						<span className="inno-smart-set-count">{t("settings.smartInput.ruleCount", "共 {{count}} 条", { count: draft.rules.length })}</span>
						{state.isSaving ? <Spinner size={12} className="text-[var(--inno-text-subtle)]" /> : null}
					</div>
					<button
						type="button"
						className="inno-smart-set-add"
						disabled={state.isSaving || Boolean(newRule)}
						onClick={() => {
							closeExtensionInput();
							setNewRule({ keyword: "", extensions: [], allExtensions: false, excludeExtensions: [], isPreset: false });
							requestAnimationFrame(() => newKeywordRef.current?.focus());
						}}
					>
						<Plus size={13} />
						{t("settings.smartInput.addRule", "新增关键词")}
					</button>
				</div>
				{error ? <div className="inno-smart-set-error">{error}</div> : null}
				<div className="inno-smart-set-list">
					{renderNewRuleRow()}
					{draft.rules.map((rule) => renderRuleRow(rule))}
					{draft.rules.length === 0 && !newRule ? (
						<div className="rounded-md border border-dashed border-[var(--inno-border)] px-3 py-4 text-center text-xs text-[var(--inno-text-subtle)]">
							{t("settings.smartInput.rulesEmpty", "暂无规则，点击「新增关键词」创建")}
						</div>
					) : null}
				</div>
				<p className="mt-3 text-xs leading-relaxed text-[var(--inno-text-subtle)]">
					{t("settings.smartInput.rulesHint", "关键词按字面匹配；可限制允许格式，也可选择全部格式并设置排除项。后缀直接输入 pdf 即可，无需输入句点。设置仅影响后续输入。")}
				</p>
			</SettingsCard>
		</SettingsSection>
	);
}
