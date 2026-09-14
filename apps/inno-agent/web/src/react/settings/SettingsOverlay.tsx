import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Settings2, FlaskConical, Cpu, Brain, Plug, Radio, Blocks, Info, X } from "lucide-react";
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
import { SmartInputSettings } from "./SmartInputSettings.js";

const TABS: { id: SettingsTab; icon: React.ReactNode }[] = [
	{ id: "general", icon: <Settings2 size={15} /> },
	{ id: "models", icon: <Cpu size={15} /> },
	{ id: "memory", icon: <Brain size={15} /> },
	{ id: "integrations", icon: <Plug size={15} /> },
	{ id: "channels", icon: <Radio size={15} /> },
	{ id: "mcp", icon: <Blocks size={15} /> },
	{ id: "lab", icon: <FlaskConical size={15} /> },
	{ id: "about", icon: <Info size={15} /> },
];

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

	if (!settingsOpen) return null;

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(32,33,36,0.45)] p-4 max-md:p-0"
			onClick={() => appStore.closeSettings()}
		>
			{/* 980x680 card with a 208px left nav, mirroring the design mockup.
				Phones go full-screen with a horizontal tab strip; narrow desktops
				(<=820px, e.g. split screen) collapse the nav to an icon rail. */}
			<div
				role="dialog"
				aria-modal="true"
				aria-label={t("settings.title")}
				className="relative flex h-[min(680px,88vh)] w-[min(980px,92vw)] overflow-hidden rounded-[20px] bg-[var(--inno-card-bg)] shadow-[0_16px_48px_rgba(0,0,0,0.22)] max-md:h-[var(--inno-viewport-height,100dvh)] max-md:w-full max-md:flex-col max-md:rounded-none"
				onClick={(event) => event.stopPropagation()}
			>
				<button
					type="button"
					onClick={() => appStore.closeSettings()}
					title={t("common.close")}
					aria-label={t("common.close")}
					className="absolute right-3.5 top-3.5 z-[5] max-md:right-2 max-md:top-[calc(7px+env(safe-area-inset-top,0px))] max-md:h-11 max-md:w-11 max-md:bg-[var(--inno-sidebar-bg)] flex h-[30px] w-[30px] items-center justify-center rounded-full text-[var(--inno-text-subtle)] transition-colors hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]"
				>
					<X size={17} />
				</button>

				{/* Left nav — horizontal tab strip on phones, icon rail on narrow desktop */}
				<aside className="flex w-[208px] shrink-0 flex-col gap-0.5 overflow-y-auto bg-[var(--inno-sidebar-bg)] px-3 py-5 md:max-[820px]:w-[64px] md:max-[820px]:px-2 max-md:w-full max-md:flex-row max-md:items-center max-md:overflow-x-auto max-md:overflow-y-hidden max-md:pb-2 max-md:pt-[calc(8px+env(safe-area-inset-top,0px))] max-md:pr-16">
					<div className="px-3 pb-3 text-sm font-semibold text-[var(--inno-text)] md:max-[820px]:hidden max-md:hidden">{t("settings.title")}</div>
					{TABS.map(({ id, icon }) => {
						const active = activeSettingsTab === id;
						return (
							<button
								key={id}
								onClick={() => appStore.setSettingsTab(id)}
								title={t(`settings.tabs.${id}`)}
								className={`flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-xl px-3 py-[9px] text-[13.5px] transition-colors md:max-[820px]:justify-center ${
									active
										? "bg-[var(--inno-sidebar-active)] font-medium text-[var(--inno-text)]"
										: "text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface)] hover:text-[var(--inno-text)]"
								}`}
							>
								{icon}
								<span className="md:max-[820px]:hidden">{t(`settings.tabs.${id}`)}</span>
								{id === "lab" ? <span className="inno-smart-beta md:max-[820px]:hidden">Beta</span> : null}
							</button>
						);
					})}
				</aside>

				{/* Content */}
				<div className="min-w-0 flex-1 overflow-y-auto px-[26px] pb-8 pt-[22px] max-md:px-4 max-md:pb-[calc(32px+env(safe-area-inset-bottom,0px))]">
					{!settings && isLoading ? (
						<div className="text-sm text-[var(--inno-text-muted)]">{t("settings.loading")}</div>
					) : (
						<>
							{activeSettingsTab === "general" && <GeneralSettings />}
							{activeSettingsTab === "lab" && <SmartInputSettings />}
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
