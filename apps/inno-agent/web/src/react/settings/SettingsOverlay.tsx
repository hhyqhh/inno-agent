import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Settings2, Cpu, Brain, Plug, Radio, Blocks, Info } from "lucide-react";
import { appStore, type SettingsTab } from "../../stores/app-store.js";
import { settingsStore } from "../../stores/settings-store.js";
import { useStoreSnapshot } from "../hooks.js";
import { GeneralSettings } from "./GeneralSettings.js";
import { ModelsSettings } from "./ModelsSettings.js";
import { MemorySettings } from "./MemorySettings.js";
import { IntegrationsSettings } from "./IntegrationsSettings.js";
import { ChannelsSettings } from "./ChannelsSettings.js";
import { McpSettings } from "./McpSettings.js";
import { AboutSettings } from "./AboutSettings.js";

const TABS: { id: SettingsTab; icon: React.ReactNode }[] = [
	{ id: "general", icon: <Settings2 size={15} /> },
	{ id: "models", icon: <Cpu size={15} /> },
	{ id: "memory", icon: <Brain size={15} /> },
	{ id: "integrations", icon: <Plug size={15} /> },
	{ id: "channels", icon: <Radio size={15} /> },
	{ id: "mcp", icon: <Blocks size={15} /> },
	{ id: "about", icon: <Info size={15} /> },
];

// In Simple Mode the advanced categories are hidden, mirroring the workspace tabs.
const HIDDEN_IN_SIMPLE: SettingsTab[] = ["integrations", "channels", "mcp"];

export function SettingsOverlay() {
	const { t } = useTranslation();
	const { settingsOpen, activeSettingsTab } = useStoreSnapshot(appStore, () => ({
		settingsOpen: appStore.settingsOpen,
		activeSettingsTab: appStore.activeSettingsTab,
	}));
	const { settings, isLoading } = useStoreSnapshot(settingsStore, () => ({
		settings: settingsStore.settings,
		isLoading: settingsStore.isLoading,
	}));
	const simpleMode = settings?.simpleMode?.enabled === true;

	// Revalidate settings each time the overlay opens.
	useEffect(() => {
		if (settingsOpen) void settingsStore.load();
	}, [settingsOpen]);

	// ESC closes the overlay.
	useEffect(() => {
		if (!settingsOpen) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") appStore.closeSettings();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [settingsOpen]);

	// If Simple Mode turns on while a hidden tab is active, fall back to general.
	useEffect(() => {
		if (simpleMode && HIDDEN_IN_SIMPLE.includes(activeSettingsTab)) {
			appStore.setSettingsTab("general");
		}
	}, [simpleMode, activeSettingsTab]);

	if (!settingsOpen) return null;

	const visibleTabs = simpleMode ? TABS.filter((tab) => !HIDDEN_IN_SIMPLE.includes(tab.id)) : TABS;

	return (
		<div className="absolute inset-0 z-50 flex bg-[var(--inno-background)]">
			{/* Sidebar */}
			<aside className="flex w-[240px] shrink-0 flex-col border-r border-[var(--inno-border)] bg-[var(--inno-sidebar-bg)]">
				<div className="flex h-12 shrink-0 items-center border-b border-[var(--inno-border)] px-4 text-sm font-semibold text-[var(--inno-text)]">
					{t("settings.title")}
				</div>
				<nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 py-2">
					{visibleTabs.map(({ id, icon }) => {
						const active = activeSettingsTab === id;
						return (
							<button
								key={id}
								onClick={() => appStore.setSettingsTab(id)}
								className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
									active
										? "bg-[var(--inno-sidebar-active)] font-medium text-[var(--inno-text)]"
										: "text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface)] hover:text-[var(--inno-text)]"
								}`}
							>
								{icon}
								<span>{t(`settings.tabs.${id}`)}</span>
							</button>
						);
					})}
				</nav>
				<div className="shrink-0 border-t border-[var(--inno-border)] p-2">
					<button
						onClick={() => appStore.closeSettings()}
						className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-[var(--inno-text-muted)] transition-colors hover:bg-[var(--inno-surface)] hover:text-[var(--inno-text)]"
					>
						<ArrowLeft size={15} />
						<span>{t("settings.back")}</span>
					</button>
				</div>
			</aside>

			{/* Content */}
			<div className="min-w-0 flex-1 overflow-y-auto">
				<div className="mx-auto max-w-[860px] px-6 py-8">
					{!settings && isLoading ? (
						<div className="text-sm text-[var(--inno-text-muted)]">{t("settings.loading")}</div>
					) : (
						<>
							{activeSettingsTab === "general" && <GeneralSettings />}
							{activeSettingsTab === "models" && settings && <ModelsSettings settings={settings} />}
							{activeSettingsTab === "memory" && settings && <MemorySettings settings={settings} />}
							{activeSettingsTab === "integrations" && settings && <IntegrationsSettings settings={settings} />}
							{activeSettingsTab === "channels" && settings && <ChannelsSettings settings={settings} />}
							{activeSettingsTab === "mcp" && settings && <McpSettings settings={settings} />}
							{activeSettingsTab === "about" && <AboutSettings />}
						</>
					)}
				</div>
			</div>
		</div>
	);
}
