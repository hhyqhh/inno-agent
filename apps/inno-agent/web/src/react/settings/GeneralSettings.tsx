import { useTranslation } from "react-i18next";
import { themeStore, THEME_IDS, THEME_PREVIEW_COLORS } from "../../stores/theme-store.js";
import { settingsStore } from "../../stores/settings-store.js";
import { setLocale } from "../../i18n/index.js";
import { useStoreSnapshot } from "../hooks.js";
import type { WindowCloseBehavior } from "../../types/settings.js";
import { SettingsSection, SettingsGroup, SettingsCard, SettingsRow } from "./primitives.js";
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
						<span className="h-3.5 w-3.5 rounded-full border border-[var(--inno-border-strong)]" style={{ backgroundColor: THEME_PREVIEW_COLORS[id] }} />
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
	return (
		<Switch
			checked={followsSystem}
			aria-label={t("settings.followSystem")}
			onChange={(enabled) => void themeStore.save(enabled ? "system" : themeStore.current)}
		/>
	);
}

function LanguageSelect() {
	const { t, i18n } = useTranslation();
	return (
		<Select
			value={i18n.language}
			onValueChange={(value) => setLocale(value as "zh-CN" | "en")}
		>
			<SelectTrigger className="min-w-28 text-xs" aria-label={t("settings.language")}><SelectValue /></SelectTrigger>
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
			<SelectTrigger className="min-w-36 text-xs" aria-label={t("settings.closeBehavior.title")}><SelectValue /></SelectTrigger>
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

export function GeneralSettings() {
	const { t } = useTranslation();
	return (
		<SettingsSection
			title={t("settings.tabs.general")}
			description={t("settings.sections.general.desc", "外观、语言与应用基础偏好")}
		>
			<SettingsGroup title={t("settings.groups.appearance", "外观与语言")}>
				<SettingsCard divided>
					<SettingsRow
						label={t("settings.theme")}
						description={t("settings.sections.general.themeDesc", "选择界面配色主题")}
						control={<ThemePicker />}
					/>
					<SettingsRow
						label={t("settings.followSystem")}
						description={t("settings.followSystemDesc")}
						control={<FollowSystemToggle />}
					/>
					<SettingsRow
						label={t("settings.language")}
						description={t("settings.sections.general.languageDesc", "切换界面显示语言")}
						control={<LanguageSelect />}
					/>
				</SettingsCard>
			</SettingsGroup>

			<SettingsGroup title={t("settings.groups.appAndFormatting", "应用与排版")}>
				<SettingsCard divided>
					<SettingsRow
						label={t("settings.closeBehavior.title")}
						description={t("settings.sections.general.closeBehaviorDesc", "设置点击窗口关闭按钮时的处理方式；选择后会在所有平台记住。")}
						control={<CloseBehaviorSelect />}
					/>
					<SettingsRow
						label={t("settings.markdownMath.title")}
						description={t("settings.markdownMath.description")}
						control={<MarkdownMathToggle />}
					/>
				</SettingsCard>
			</SettingsGroup>
		</SettingsSection>
	);
}
