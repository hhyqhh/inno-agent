import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { settingsStore } from "../../stores/settings-store.js";
import type { InnoSettings } from "../../types/settings.js";
import { Switch } from "../ui/Switch.js";
import { SettingsSection, SettingsCard, SettingsRow } from "./primitives.js";

/* ---------- Memory layer toggles (L1/L2/L3) ---------- */

type MemoryLayer = "l1Enabled" | "l2Enabled" | "l3Enabled";

function MemoryToggleRow({
	enabled,
	saving,
	title,
	desc,
	onToggle,
}: {
	enabled: boolean;
	saving: boolean;
	title: string;
	desc: string;
	onToggle: (next: boolean) => void;
}) {
	return (
		<SettingsRow
			label={title}
			description={desc}
			control={<Switch checked={enabled} onChange={onToggle} disabled={saving} />}
		/>
	);
}

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
		<SettingsCard>
			<h4 className="mb-3 text-sm font-medium text-[var(--inno-text)]">{t("settings.memorySection")}</h4>
			<div className="grid gap-4">
				{layers.map(({ key, ns }) => {
					const enabled = state[key];
					return (
						<MemoryToggleRow
							key={key}
							enabled={enabled}
							saving={savingKey === key}
							title={t(`settings.${ns}.title`)}
							desc={enabled ? t(`settings.${ns}.onDesc`) : t(`settings.${ns}.offDesc`)}
							onToggle={(next) => void handleToggle(key, next)}
						/>
					);
				})}
			</div>
		</SettingsCard>
	);
}

/* ---------- Memory category page ---------- */

export function MemorySettings({ settings }: { settings: InnoSettings }) {
	const { t } = useTranslation();
	return (
		<SettingsSection title={t("settings.tabs.memory")} description={t("settings.sections.memory.desc", "分层记忆开关")}>
			<MemoryLayersCard settings={settings} />
		</SettingsSection>
	);
}
