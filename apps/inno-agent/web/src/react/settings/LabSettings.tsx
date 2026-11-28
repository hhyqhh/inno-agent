import { useState } from "react";
import { useTranslation } from "react-i18next";
import { settingsStore } from "../../stores/settings-store.js";
import { useStoreSnapshot } from "../hooks.js";
import { Switch } from "../ui/index.js";
import { SettingsSection, SettingsGroup, SettingsCard, SettingsRow } from "./primitives.js";
import { SmartInputContent } from "./SmartInputSettings.js";

function AgentCapabilitiesCard() {
	const { t } = useTranslation();
	const [computerUseChanged, setComputerUseChanged] = useState(false);
	const [codemodeChanged, setCodemodeChanged] = useState(false);

	const state = useStoreSnapshot(settingsStore, () => ({
		computerUseEnabled: settingsStore.settings?.computerUse?.enabled === true,
		isSavingComputerUse: settingsStore.isSavingComputerUse,
		codemodeEnabled: settingsStore.settings?.codemode?.enabled === true,
		isSavingCodemode: settingsStore.isSavingCodemode,
		isReady: settingsStore.settings !== null,
	}));

	function handleComputerUseChange(enabled: boolean) {
		settingsStore
			.saveComputerUse(enabled)
			.then(() => setComputerUseChanged(true))
			.catch(() => undefined);
	}

	function handleCodemodeChange(enabled: boolean) {
		settingsStore
			.saveCodemode(enabled)
			.then(() => setCodemodeChanged(true))
			.catch(() => undefined);
	}

	return (
		<SettingsCard divided>
			<SettingsRow
				label={t("settings.computerUse.title")}
				description={t("settings.computerUse.description")}
				hint={computerUseChanged ? t("settings.computerUse.restartHint") : undefined}
				hintTone="warning"
				control={
					<Switch
						checked={state.computerUseEnabled}
						disabled={!state.isReady || state.isSavingComputerUse}
						aria-label={t("settings.computerUse.title")}
						onChange={handleComputerUseChange}
					/>
				}
			/>
			<SettingsRow
				label={t("settings.codemode.title")}
				description={t("settings.codemode.description")}
				hint={codemodeChanged ? t("settings.codemode.restartHint") : undefined}
				hintTone="warning"
				control={
					<Switch
						checked={state.codemodeEnabled}
						disabled={!state.isReady || state.isSavingCodemode}
						aria-label={t("settings.codemode.title")}
						onChange={handleCodemodeChange}
					/>
				}
			/>
		</SettingsCard>
	);
}

export function LabSettings() {
	const { t } = useTranslation();
	return (
		<SettingsSection
			title={
				<span className="inline-flex items-center gap-2">
					{t("settings.tabs.lab")}
					<span className="inno-smart-beta inno-smart-beta--settings">Beta</span>
				</span>
			}
			description={t("settings.sections.lab.desc", "实验性 Agent 能力与便捷输入设置")}
		>
			<SettingsGroup title={t("settings.groups.agentCapabilities", "Agent 能力")}>
				<AgentCapabilitiesCard />
			</SettingsGroup>

			<SettingsGroup
				title={t("settings.smartInput.title", "便捷输入")}
				description={t("settings.smartInput.desc", "在输入框输入关键词即可转为文件气泡，把文件明确绑定到指代词")}
			>
				<SmartInputContent />
			</SettingsGroup>
		</SettingsSection>
	);
}
