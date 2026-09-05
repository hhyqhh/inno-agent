import type { ReactNode, RefObject } from "react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import type { PresetMeta } from "../../types/presets.js";
import { PresetPicker } from "./PresetPicker.js";
import { ModeSegmentedControl } from "../ui/ModeSegmentedControl.js";
import { TerminalDrawer } from "../terminal/TerminalDrawer.js";

interface ChatWelcomeProps {
	welcomeLayoutRef: RefObject<HTMLDivElement | null>;
	simpleMode: boolean;
	togglingMode: boolean;
	onToggleMode: () => void;
	questionHint: ReactNode;
	busyBlocker: ReactNode;
	smartToast: ReactNode;
	composer: ReactNode;
	workspaceContext: ReactNode;
	presets: PresetMeta[];
	presetsLoaded: boolean;
	isLoadingPresets: boolean;
	isRefreshingPresets: boolean;
	presetsRefreshError: string | null;
	presetRefreshStatus: "success" | "error" | null;
	loadedPresetIds: ReadonlySet<string>;
	onRefreshPresets: () => void;
	openingPresetId: string | null;
	onOpenPreset: (presetId: string) => void;
	presetQuery: string;
	onPresetQueryChange: (value: string) => void;
	wsError: string;
}

export function ChatWelcome({
	welcomeLayoutRef,
	simpleMode,
	togglingMode,
	onToggleMode,
	questionHint,
	busyBlocker,
	smartToast,
	composer,
	workspaceContext,
	presets,
	presetsLoaded,
	isLoadingPresets,
	isRefreshingPresets,
	presetsRefreshError,
	presetRefreshStatus,
	loadedPresetIds,
	onRefreshPresets,
	openingPresetId,
	onOpenPreset,
	presetQuery,
	onPresetQueryChange,
	wsError,
}: ChatWelcomeProps) {
	const { t } = useTranslation();
	return (
		<section className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[var(--inno-chat-bg)]">
			{smartToast}
			<div className="inno-chat-grid flex flex-1 min-h-0 justify-center overflow-y-auto px-4">
				<div ref={welcomeLayoutRef} className="inno-welcome-layout w-full max-w-2xl pt-[18vh] pb-12">
					<div className="inno-welcome-upper">
						<div className="flex flex-col items-center text-center">
							<button
								type="button"
								onClick={onToggleMode}
								disabled={togglingMode}
								title={simpleMode ? t("mode.currentSimpleClickNormal") : t("mode.currentNormalClickSimple")}
								aria-label={simpleMode ? t("mode.switchToNormal") : t("mode.switchToSimple")}
								className="flip-card-scene mb-3 rounded-xl outline-none focus-visible:shadow-[var(--inno-ring)] disabled:cursor-wait"
							>
								<motion.div
									animate={{ rotateY: simpleMode ? 180 : 0 }}
									transition={{ type: "spring", stiffness: 320, damping: 22 }}
									className="flip-card flex h-12 w-12 items-center justify-center"
								>
									<span className="flip-card-face absolute inset-0 flex items-center justify-center rounded-xl border border-[var(--inno-border)] bg-[var(--inno-surface)] text-base font-semibold text-[var(--inno-accent)] shadow-sm transition-colors hover:border-[var(--inno-accent)]">IA</span>
									<span className="flip-card-back absolute inset-0 flex items-center justify-center rounded-xl border border-[var(--inno-accent)] bg-[var(--inno-accent)] text-base font-semibold text-white shadow-sm">IA</span>
								</motion.div>
							</button>
							<h2 className="text-lg font-medium text-[var(--inno-text)]">Inno Agent</h2>
							<ModeSegmentedControl
								simpleMode={simpleMode}
								togglingMode={togglingMode}
								onToggleMode={onToggleMode}
								className="mt-2"
							/>
						</div>

						{questionHint}
						{busyBlocker}
					</div>

					<div className="inno-welcome-composer-shell">
						{composer}
						{workspaceContext ? <div className="mt-2">{workspaceContext}</div> : null}
					</div>

					{simpleMode && (presets.length > 0 || presetsLoaded || isLoadingPresets || presetsRefreshError) ? (
						<PresetPicker
							presets={presets}
							loadedPresetIds={loadedPresetIds}
							isLoading={isLoadingPresets}
							isRefreshing={isRefreshingPresets}
							refreshStatus={presetRefreshStatus}
							openingPresetId={openingPresetId}
							onOpen={onOpenPreset}
							onRefresh={onRefreshPresets}
							query={presetQuery}
							onQueryChange={onPresetQueryChange}
						/>
					) : null}

					{wsError ? <p className="mt-2 text-xs text-[var(--inno-danger)]">{wsError}</p> : null}
				</div>
			</div>
			{simpleMode ? null : <TerminalDrawer />}
		</section>
	);
}
