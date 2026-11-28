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
import { IconButton, Tooltip } from "../ui/index.js";

const TABS: { id: SettingsTab; icon: React.ReactNode }[] = [
	{ id: "general", icon: <Settings2 size={16} /> },
	{ id: "models", icon: <Cpu size={16} /> },
	{ id: "memory", icon: <Brain size={16} /> },
	{ id: "integrations", icon: <Plug size={16} /> },
	{ id: "channels", icon: <Radio size={16} /> },
	{ id: "mcp", icon: <Blocks size={16} /> },
	{ id: "lab", icon: <FlaskConical size={16} /> },
	{ id: "about", icon: <Info size={16} /> },
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
			className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(32,33,36,0.45)] p-4 backdrop-blur-[2px] max-md:p-0"
			onClick={() => appStore.closeSettings()}
		>
			{/* 980x680 card with a 208px left nav, mirroring the design mockup.
				Phones go full-screen with a horizontal tab strip; narrow desktops
				(<=820px, e.g. split screen) collapse the nav to an icon rail. */}
			<div
				role="dialog"
				aria-modal="true"
				aria-label={t("settings.title")}
				className="relative flex h-[min(680px,88vh)] w-[min(980px,92vw)] overflow-hidden rounded-2xl border border-[var(--inno-border)] bg-[var(--inno-card-bg)] shadow-[0_16px_48px_rgba(0,0,0,0.22)] max-md:h-[var(--inno-viewport-height,100dvh)] max-md:w-full max-md:flex-col max-md:rounded-none max-md:border-0"
				onClick={(event) => event.stopPropagation()}
			>
				<IconButton
					size="xs"
					shape="pill"
					onClick={() => appStore.closeSettings()}
					aria-label={t("common.close")}
					title={t("common.close")}
					className="absolute right-4 top-4 z-[5] max-md:right-2 max-md:top-[calc(7px+env(safe-area-inset-top,0px))] max-md:h-11 max-md:w-11 max-md:bg-[var(--inno-sidebar-bg)]"
				>
					<X size={16} />
				</IconButton>

				{/* Left nav — horizontal tab strip on phones, icon rail on narrow desktop */}
				<aside className="flex w-[208px] shrink-0 flex-col gap-1 overflow-y-auto border-r border-[var(--inno-border)] bg-[var(--inno-sidebar-bg)] px-3 py-5 md:max-[820px]:w-[64px] md:max-[820px]:px-2 max-md:w-full max-md:flex-row max-md:items-center max-md:overflow-x-auto max-md:overflow-y-hidden max-md:border-b max-md:border-r-0 max-md:pb-2 max-md:pt-[calc(8px+env(safe-area-inset-top,0px))] max-md:pr-16">
					<div className="px-2.5 pb-2.5 text-sm font-semibold text-[var(--inno-text)] md:max-[820px]:hidden max-md:hidden">{t("settings.title")}</div>
					{TABS.map(({ id, icon }) => {
						const active = activeSettingsTab === id;
						return (
							<Tooltip key={id} label={t(`settings.tabs.${id}`)} side="right">
								<button
									type="button"
									onClick={() => appStore.setSettingsTab(id)}
									aria-label={t(`settings.tabs.${id}`)}
									aria-current={active ? "page" : undefined}
									className={`flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-lg px-2.5 py-2 text-sm transition-colors md:max-[820px]:justify-center ${
										active
											? "bg-[var(--inno-sidebar-active)] font-medium text-[var(--inno-text)]"
											: "text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]"
									}`}
								>
									<span className={active ? "text-[var(--inno-text)]" : "text-[var(--inno-text-subtle)]"}>{icon}</span>
									<span className="md:max-[820px]:hidden">{t(`settings.tabs.${id}`)}</span>
									{id === "lab" ? <span className="inno-smart-beta md:max-[820px]:hidden">Beta</span> : null}
								</button>
							</Tooltip>
						);
					})}
				</aside>

				{/* Content */}
				<div className="min-w-0 flex-1 overflow-y-auto px-7 pb-8 pt-6 max-md:px-4 max-md:pb-[calc(32px+env(safe-area-inset-bottom,0px))]">
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
