import { useState } from "react";
import { useTranslation } from "react-i18next";
import { themeStore, THEME_IDS, THEME_PREVIEW_COLORS } from "../../stores/theme-store.js";
import { settingsStore } from "../../stores/settings-store.js";
import { setLocale } from "../../i18n/index.js";
import { useStoreSnapshot } from "../hooks.js";
import type { WindowCloseBehavior } from "../../types/settings.js";
import { SettingsSection, SettingsCard, SettingsRow } from "./primitives.js";
import { Select, SelectContent, SelectOption, SelectTrigger, SelectValue, Switch, Button } from "../ui/index.js";

function ThemePicker() {
	const { t } = useTranslation();
	const state = useStoreSnapshot(themeStore, () => ({ current: themeStore.current, preference: themeStore.preference }));
	return (
		<div className="flex flex-wrap gap-2">
			{THEME_IDS.map((id) => {
				const active = state.current === id;
				return (
					<Button
						key={id}
						variant={active ? "primary" : "secondary"}
						size="xs"
						shape="pill"
						aria-label={t(`settings.themeOptions.${id}`)}
						aria-pressed={active}
						disabled={state.preference === "system"}
						onClick={() => void themeStore.save(id)}
					>
						<span className="h-4 w-4 rounded-full border border-[var(--inno-border-strong)]" style={{ backgroundColor: THEME_PREVIEW_COLORS[id] }} />
						{t(`settings.themeOptions.${id}`)}
					</Button>
				);
			})}
		</div>
	);
}

function FollowSystemToggle() {
	const { t } = useTranslation();
	const followsSystem = useStoreSnapshot(themeStore, () => themeStore.preference === "system");
	return <Switch
		checked={followsSystem}
		aria-label={t("settings.followSystem")}
		onChange={(enabled) => void themeStore.save(enabled ? "system" : themeStore.current)}
	/>;
}

function LanguageSelect() {
	const { t, i18n } = useTranslation();
	return (
		<Select
			value={i18n.language}
			onValueChange={(value) => setLocale(value as "zh-CN" | "en")}
		>
			<SelectTrigger className="text-xs" aria-label={t("settings.language")}><SelectValue /></SelectTrigger>
			<SelectContent>
				<SelectOption value="zh-CN" label={t("settings.languageOptions.zh-CN")} />
				<SelectOption value="en" label={t("settings.languageOptions.en")} />
			</SelectContent>
		</Select>
	);
}

function CloseBehaviorSelect() {
	const { t } = useTranslation();
	const state = useStoreSnapshot(settingsStore, () => ({
		behavior: settingsStore.settings?.ui?.closeBehavior ?? "ask",
		isSaving: settingsStore.isSavingCloseBehavior,
		isReady: settingsStore.settings !== null,
	}));

	function handleChange(value: string) {
		if (value !== "ask" && value !== "hide" && value !== "quit") return;
		void settingsStore.saveCloseBehavior(value as WindowCloseBehavior).catch(() => undefined);
	}

	return (
		<Select
			value={state.behavior}
			disabled={!state.isReady || state.isSaving}
			onValueChange={handleChange}
		>
			<SelectTrigger className="text-xs" aria-label={t("settings.closeBehavior.title")}><SelectValue /></SelectTrigger>
			<SelectContent>
				<SelectOption value="ask" label={t("settings.closeBehavior.options.ask")} />
				<SelectOption value="hide" label={t("settings.closeBehavior.options.hide")} />
				<SelectOption value="quit" label={t("settings.closeBehavior.options.quit")} />
			</SelectContent>
		</Select>
	);
}

function MarkdownMathToggle() {
	const { t } = useTranslation();
	const state = useStoreSnapshot(settingsStore, () => ({
		enabled: settingsStore.settings?.ui?.mathSingleDollar === true,
		isSaving: settingsStore.isSavingMarkdown,
		isReady: settingsStore.settings !== null,
	}));
	return (
		<Switch
			checked={state.enabled}
			disabled={!state.isReady || state.isSaving}
			aria-label={t("settings.markdownMath.title")}
			onChange={(enabled) => void settingsStore.saveMathSingleDollar(enabled).catch(() => undefined)}
		/>
	);
}

function ComputerUseToggle() {
	const { t } = useTranslation();
	const [changed, setChanged] = useState(false);
	const state = useStoreSnapshot(settingsStore, () => ({
		enabled: settingsStore.settings?.computerUse?.enabled === true,
		isSaving: settingsStore.isSavingComputerUse,
		isReady: settingsStore.settings !== null,
	}));

	function handleChange(enabled: boolean) {
		settingsStore
			.saveComputerUse(enabled)
			.then(() => setChanged(true))
			.catch(() => undefined);
	}

	return (
		<div className="flex flex-col items-end gap-1">
			<Switch
				checked={state.enabled}
				disabled={!state.isReady || state.isSaving}
				aria-label={t("settings.computerUse.title")}
				onChange={handleChange}
			/>
			{changed && (
				<span className="text-[11px] text-[var(--inno-text-muted)]">
					{t("settings.computerUse.restartHint")}
				</span>
			)}
		</div>
	);
}

function CodemodeToggle() {
	const { t } = useTranslation();
	const [changed, setChanged] = useState(false);
	const state = useStoreSnapshot(settingsStore, () => ({
		enabled: settingsStore.settings?.codemode?.enabled === true,
		isSaving: settingsStore.isSavingCodemode,
		isReady: settingsStore.settings !== null,
	}));

	function handleChange(enabled: boolean) {
		settingsStore
			.saveCodemode(enabled)
			.then(() => setChanged(true))
			.catch(() => undefined);
	}

	return (
		<div className="flex flex-col items-end gap-1">
			<Switch
				checked={state.enabled}
				disabled={!state.isReady || state.isSaving}
				aria-label={t("settings.codemode.title")}
				onChange={handleChange}
			/>
			{changed && (
				<span className="text-[11px] text-[var(--inno-text-muted)]">
					{t("settings.codemode.restartHint")}
				</span>
			)}
		</div>
	);
}

export function GeneralSettings() {
	const { t } = useTranslation();
	return (
		<>
			<SettingsSection title={t("settings.tabs.general")} description={t("settings.sections.general.desc", "外观与语言偏好")}>
			<SettingsCard className="space-y-4">
				<SettingsRow
					label={t("settings.theme")}
					description={t("settings.sections.general.themeDesc", "选择界面配色主题")}
					control={<ThemePicker />}
				/>
				<SettingsRow label={t("settings.followSystem")} description={t("settings.followSystemDesc")} control={<FollowSystemToggle />} />
			</SettingsCard>
			<SettingsCard>
				<SettingsRow
					label={t("settings.language")}
					description={t("settings.sections.general.languageDesc", "切换界面显示语言")}
					control={<LanguageSelect />}
				/>
			</SettingsCard>
			<SettingsCard>
				<SettingsRow
					label={t("settings.closeBehavior.title")}
					description={t("settings.sections.general.closeBehaviorDesc", "设置点击窗口关闭按钮时的处理方式；选择后会在所有平台记住。")}
					control={<CloseBehaviorSelect />}
				/>
			</SettingsCard>
			<SettingsCard>
				<SettingsRow
					label={t("settings.markdownMath.title")}
					description={t("settings.markdownMath.description")}
					control={<MarkdownMathToggle />}
				/>
			</SettingsCard>
			<SettingsCard>
				<SettingsRow
					label={t("settings.computerUse.title")}
					description={t("settings.computerUse.description")}
					control={<ComputerUseToggle />}
				/>
			</SettingsCard>
			<SettingsCard>
				<SettingsRow
					label={t("settings.codemode.title")}
					description={t("settings.codemode.description")}
					control={<CodemodeToggle />}
				/>
			</SettingsCard>
			</SettingsSection>
		</>
	);
}
