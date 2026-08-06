import { useTranslation } from "react-i18next";
import { themeStore, THEME_IDS, THEME_PREVIEW_COLORS } from "../../stores/theme-store.js";
import { settingsStore } from "../../stores/settings-store.js";
import { setLocale } from "../../i18n/index.js";
import { useStoreSnapshot } from "../hooks.js";
import type { WindowCloseBehavior } from "../../types/settings.js";
import { SettingsSection, SettingsCard, SettingsRow } from "./primitives.js";

function ThemePicker() {
	const { t } = useTranslation();
	const state = useStoreSnapshot(themeStore, () => ({ current: themeStore.current }));
	return (
		<div className="flex gap-1.5">
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
								: "border-[var(--inno-border-strong)] hover:border-[var(--inno-border-strong)]"
						}`}
						style={{ backgroundColor: THEME_PREVIEW_COLORS[id] }}
					/>
				);
			})}
		</div>
	);
}

function LanguageSelect() {
	const { t, i18n } = useTranslation();
	return (
		<select
			className="rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2 py-1 text-xs"
			value={i18n.language}
			onChange={(e) => setLocale(e.target.value as "zh-CN" | "en")}
		>
			<option value="zh-CN">{t("settings.languageOptions.zh-CN")}</option>
			<option value="en">{t("settings.languageOptions.en")}</option>
		</select>
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
		<select
			className="rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2 py-1 text-xs"
			value={state.behavior}
			disabled={!state.isReady || state.isSaving}
			onChange={(e) => handleChange(e.target.value)}
		>
			<option value="ask">{t("settings.closeBehavior.options.ask")}</option>
			<option value="hide">{t("settings.closeBehavior.options.hide")}</option>
			<option value="quit">{t("settings.closeBehavior.options.quit")}</option>
		</select>
	);
}

export function GeneralSettings() {
	const { t } = useTranslation();
	return (
		<SettingsSection title={t("settings.tabs.general")} description={t("settings.sections.general.desc", "外观与语言偏好")}>
			<SettingsCard>
				<SettingsRow
					label={t("settings.theme")}
					description={t("settings.sections.general.themeDesc", "选择界面配色主题")}
					control={<ThemePicker />}
				/>
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
		</SettingsSection>
	);
}
