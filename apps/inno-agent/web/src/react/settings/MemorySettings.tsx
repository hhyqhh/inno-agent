import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { settingsStore } from "../../stores/settings-store.js";
import type { InnoSettings, SmartCompactPreset } from "../../types/settings.js";
import { useStoreSnapshot } from "../hooks.js";
import { Select, SelectContent, SelectOption, SelectTrigger, SelectValue, Switch } from "../ui/index.js";
import { SettingsSection, SettingsGroup, SettingsCard, SettingsRow } from "./primitives.js";

/* ---------- Memory layer toggles (L1/L2/L3) ---------- */

type MemoryLayer = "l1Enabled" | "l2Enabled" | "l3Enabled";

function MemoryLayersCard({ settings }: { settings: InnoSettings }) {
	const { t } = useTranslation();
	const initial = {
		l1Enabled: settings.memory?.l1Enabled !== false,
		l2Enabled: settings.memory?.l2Enabled !== false,
		l3Enabled: settings.memory?.l3Enabled !== false,
	};
	const [state, setState] = useState(initial);
	const [savingKey, setSavingKey] = useState<MemoryLayer | null>(null);

	useEffect(() => {
		setState({
			l1Enabled: settings.memory?.l1Enabled !== false,
			l2Enabled: settings.memory?.l2Enabled !== false,
			l3Enabled: settings.memory?.l3Enabled !== false,
		});
	}, [settings.memory?.l1Enabled, settings.memory?.l2Enabled, settings.memory?.l3Enabled]);

	async function handleToggle(key: MemoryLayer, next: boolean) {
		setState((s) => ({ ...s, [key]: next }));
		setSavingKey(key);
		try {
			await settingsStore.saveMemory({ [key]: next });
		} catch {
			setState((s) => ({ ...s, [key]: !next }));
		} finally {
			setSavingKey(null);
		}
	}

	const layers: { key: MemoryLayer; ns: "l1" | "l2" | "memory" }[] = [
		{ key: "l1Enabled", ns: "l1" },
		{ key: "l2Enabled", ns: "l2" },
		{ key: "l3Enabled", ns: "memory" },
	];

	return (
		<SettingsCard divided>
			{layers.map(({ key, ns }) => {
				const enabled = state[key];
				return (
					<SettingsRow
						key={key}
						label={t(`settings.${ns}.title`)}
						description={enabled ? t(`settings.${ns}.onDesc`) : t(`settings.${ns}.offDesc`)}
						control={
							<Switch
								checked={enabled}
								aria-label={t(`settings.${ns}.title`)}
								onChange={(next) => void handleToggle(key, next)}
								disabled={savingKey === key}
							/>
						}
					/>
				);
			})}
		</SettingsCard>
	);
}

/* ---------- Smart Compact (Context management) ---------- */

const SMART_COMPACT_PRESET_IDS: SmartCompactPreset[] = ["150k", "300k", "500k"];

function ContextManagementCard({ settings }: { settings: InnoSettings }) {
	const { t } = useTranslation();
	const [changed, setChanged] = useState(false);
	const state = useStoreSnapshot(settingsStore, () => {
		const sc = settingsStore.settings?.smartCompact ?? settings.smartCompact;
		return {
			enabled: sc?.enabled === true,
			preset: sc?.preset ?? "300k",
			runtimeSupported: sc?.runtimeSupported !== false,
			settingsError: sc?.settingsError === true,
			isSaving: settingsStore.isSavingSmartCompact,
			isReady: settingsStore.settings !== null || Boolean(settings),
		};
	});

	function handleToggle(enabled: boolean) {
		settingsStore
			.saveSmartCompact({ enabled })
			.then(() => setChanged(true))
			.catch(() => undefined);
	}

	function handlePresetChange(value: string) {
		if (!SMART_COMPACT_PRESET_IDS.includes(value as SmartCompactPreset)) return;
		void settingsStore.saveSmartCompact({ preset: value as SmartCompactPreset }).catch(() => undefined);
	}

	const toggleHint = !state.runtimeSupported
		? t("settings.smartCompact.unsupported")
		: changed
			? t("settings.smartCompact.restartHint")
			: undefined;
	const toggleHintTone = !state.runtimeSupported || changed ? "warning" : "muted";
	const thresholdDisabled = !state.isReady || state.isSaving || !state.enabled || !state.runtimeSupported || state.settingsError;

	return (
		<SettingsCard divided>
			<SettingsRow
				label={t("settings.smartCompact.title")}
				description={t("settings.smartCompact.description")}
				hint={toggleHint}
				hintTone={toggleHintTone}
				control={
					<Switch
						checked={state.enabled}
						disabled={!state.isReady || state.isSaving}
						aria-label={t("settings.smartCompact.title")}
						onChange={handleToggle}
					/>
				}
			/>
			<SettingsRow
				label={t("settings.smartCompact.thresholdTitle")}
				description={t("settings.smartCompact.thresholdDescription")}
				hint={state.settingsError ? t("settings.smartCompact.settingsError") : undefined}
				hintTone={state.settingsError ? "danger" : "muted"}
				disabled={!state.enabled}
				control={
					<Select
						value={state.preset}
						disabled={thresholdDisabled}
						onValueChange={handlePresetChange}
					>
						<SelectTrigger
							className="min-w-44 text-xs"
							aria-label={t("settings.smartCompact.thresholdTitle")}
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{state.preset === "custom" ? (
								<SelectOption value="custom" disabled label={t("settings.smartCompact.presets.custom")} />
							) : null}
							{SMART_COMPACT_PRESET_IDS.map((preset) => (
								<SelectOption key={preset} value={preset} label={t(`settings.smartCompact.presets.${preset}`)} />
							))}
						</SelectContent>
					</Select>
				}
			/>
		</SettingsCard>
	);
}

/* ---------- Memory & Context category page ---------- */

export function MemorySettings({ settings }: { settings: InnoSettings }) {
	const { t } = useTranslation();
	return (
		<SettingsSection
			title={t("settings.tabs.memory")}
			description={t("settings.sections.memory.desc", "分层记忆开关与长对话上下文管理")}
		>
			<SettingsGroup title={t("settings.memorySection", "记忆分层")}>
				<MemoryLayersCard settings={settings} />
			</SettingsGroup>
			<SettingsGroup title={t("settings.groups.contextManagement", "上下文管理")}>
				<ContextManagementCard settings={settings} />
			</SettingsGroup>
		</SettingsSection>
	);
}
