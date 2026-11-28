import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { getWikiStats } from "../../api/wiki.js";
import { settingsStore } from "../../stores/settings-store.js";
import type { WikiStats } from "../../types/wiki.js";
import { useStoreSnapshot } from "../hooks.js";
import { Button } from "../ui/index.js";
import { SettingsSection, SettingsCard, SettingsStatusBadge } from "./primitives.js";
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

	function handleRefresh() {
		void settingsStore.load();
		void fetch("/api/health").then((res) => setHealthOk(res.ok)).catch(() => setHealthOk(false));
		void getWikiStats().then(setWikiStats).catch(() => setWikiStats(null));
	}

	return (
		<SettingsSection
			title={t("settings.tabs.about")}
			description={t("settings.sections.about.desc", "服务状态与存储统计")}
			action={
				<Button variant="secondary" size="xs" disabled={state.isLoading} onClick={handleRefresh}>
					<RefreshCw size={13} className={state.isLoading ? "animate-spin" : ""} />
					{t("settings.refresh")}
				</Button>
			}
		>
			<SettingsCard className="grid gap-3.5">
				<div className="flex items-center justify-between gap-2">
					<h3 className="text-sm font-medium text-[var(--inno-text)]">{t("settings.aboutOverview", "运行概览")}</h3>
					<SettingsStatusBadge tone={healthOk ? "success" : "danger"} dot>
						{healthOk ? t("settings.stats.healthy") : t("settings.stats.offline")}
					</SettingsStatusBadge>
				</div>

				{state.error ? (
					<div className="rounded-lg bg-[var(--inno-danger-bg)] px-3 py-2 text-xs text-[var(--inno-danger)]">
						{state.error}
					</div>
				) : null}

				<div className="grid grid-cols-1 gap-3 min-[30rem]:grid-cols-2">
					<div className="rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface-muted)]/55 p-3.5">
						<div className="text-xs text-[var(--inno-text-subtle)]">{t("settings.stats.version")}</div>
						<div className="mt-1 font-mono text-sm font-medium text-[var(--inno-text)]">v{packageJson.version}</div>
					</div>
					<div className="rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface-muted)]/55 p-3.5">
						<div className="text-xs text-[var(--inno-text-subtle)]">{t("settings.stats.server")}</div>
						<div className={`mt-1 text-sm font-medium ${healthOk ? "text-[var(--inno-success)]" : "text-[var(--inno-danger)]"}`}>
							{healthOk ? t("settings.stats.healthy") : t("settings.stats.offline")}
						</div>
					</div>
					<div className="min-w-0 rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface-muted)]/55 p-3.5">
						<div className="text-xs text-[var(--inno-text-subtle)]">{t("settings.stats.defaultModel")}</div>
						<div className="mt-1 font-mono text-sm font-medium text-[var(--inno-text)] [overflow-wrap:anywhere]">
							{state.settings ? `${state.settings.defaultProvider}/${state.settings.defaultModel}` : "-"}
						</div>
					</div>
					<div className="rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface-muted)]/55 p-3.5">
						<div className="text-xs text-[var(--inno-text-subtle)]">{t("settings.stats.wiki")}</div>
						<div className="mt-1 text-sm font-medium text-[var(--inno-text)]">
							{wikiStats ? t("settings.stats.wikiStat", { count: wikiStats.pageCount, size: formatBytes(wikiStats.totalSize) }) : "-"}
						</div>
					</div>
				</div>
			</SettingsCard>
		</SettingsSection>
	);
}
