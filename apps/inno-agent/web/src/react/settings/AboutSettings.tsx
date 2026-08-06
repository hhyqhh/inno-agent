import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getWikiStats } from "../../api/wiki.js";
import { settingsStore } from "../../stores/settings-store.js";
import type { WikiStats } from "../../types/wiki.js";
import { useStoreSnapshot } from "../hooks.js";
import { SettingsSection, SettingsCard } from "./primitives.js";
import { formatBytes } from "./shared.js";
import packageJson from "../../../package.json";

export function AboutSettings() {
	const { t } = useTranslation();
	const [healthOk, setHealthOk] = useState(false);
	const [wikiStats, setWikiStats] = useState<WikiStats | null>(null);
	const state = useStoreSnapshot(settingsStore, () => ({
		settings: settingsStore.settings,
		isLoading: settingsStore.isLoading,
		error: settingsStore.error,
	}));

	useEffect(() => {
		void fetch("/api/health").then((res) => setHealthOk(res.ok)).catch(() => setHealthOk(false));
		void getWikiStats().then(setWikiStats).catch(() => setWikiStats(null));
	}, []);

	return (
		<SettingsSection title={t("settings.tabs.about")} description={t("settings.sections.about.desc", "服务状态与存储统计")}>
			<SettingsCard>
				<div className="mb-3 flex items-center justify-between">
					<h4 className="text-sm font-medium text-[var(--inno-text)]">{t("settings.title")}</h4>
					<button className="shrink-0 rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-1.5 text-sm text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]" onClick={() => void settingsStore.load()}>
						{t("settings.refresh")}
					</button>
				</div>
				{state.isLoading ? <div className="text-sm text-[var(--inno-text-muted)]">{t("settings.loading")}</div> : null}
				{state.error ? <div className="rounded bg-[var(--inno-danger-bg)] p-2 text-sm text-[var(--inno-danger)]">{state.error}</div> : null}
				<div className="settings-stats-grid grid gap-3 text-sm">
					<div className="rounded border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] p-3">
						<div className="text-xs text-[var(--inno-text-muted)]">{t("settings.stats.version")}</div>
						<div className="font-medium text-[var(--inno-text)]">v{packageJson.version}</div>
					</div>
					<div className="rounded border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] p-3">
						<div className="text-xs text-[var(--inno-text-muted)]">{t("settings.stats.server")}</div>
						<div className={healthOk ? "font-medium text-[var(--inno-success)]" : "font-medium text-[var(--inno-danger)]"}>
							{healthOk ? t("settings.stats.healthy") : t("settings.stats.offline")}
						</div>
					</div>
					<div className="min-w-0 rounded border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] p-3">
						<div className="text-xs text-[var(--inno-text-muted)]">{t("settings.stats.defaultModel")}</div>
						<div className="font-medium text-[var(--inno-text)] [overflow-wrap:anywhere]">{state.settings ? `${state.settings.defaultProvider}/${state.settings.defaultModel}` : "-"}</div>
					</div>
					<div className="rounded border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] p-3">
						<div className="text-xs text-[var(--inno-text-muted)]">{t("settings.stats.wiki")}</div>
						<div className="font-medium text-[var(--inno-text)]">
							{wikiStats ? t("settings.stats.wikiStat", { count: wikiStats.pageCount, size: formatBytes(wikiStats.totalSize) }) : "-"}
						</div>
					</div>
				</div>
			</SettingsCard>
		</SettingsSection>
	);
}
