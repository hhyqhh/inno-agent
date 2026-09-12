import type { ReactNode, RefObject } from "react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { BookOpen, ClipboardList, FlaskConical, GraduationCap, Lightbulb, Monitor, Presentation, Shapes, Sparkles, TrendingUp } from "lucide-react";
import type { PresetMeta } from "../../types/presets.js";
import { PresetPicker } from "./PresetPicker.js";
import { ModeSegmentedControl } from "../ui/ModeSegmentedControl.js";
import { TerminalDrawer } from "../terminal/TerminalDrawer.js";

// preset.json `icon` values are lucide icon names.
const PRESET_ICONS: Record<string, typeof Sparkles> = {
	"book-open": BookOpen,
	"clipboard-list": ClipboardList,
	"flask-conical": FlaskConical,
	"graduation-cap": GraduationCap,
	lightbulb: Lightbulb,
	monitor: Monitor,
	presentation: Presentation,
	shapes: Shapes,
	sparkles: Sparkles,
	"trending-up": TrendingUp,
};

interface ChatWelcomeProps {
	welcomeLayoutRef: RefObject<HTMLDivElement | null>;
	simpleMode: boolean;
	togglingMode: boolean;
	onToggleMode: () => void;
	questionHint: ReactNode;
	busyBlocker: ReactNode;
	smartToast: ReactNode;
	composer: ReactNode;
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
	/** Floating notice rendered over the top of the welcome column. */
	topOverlay?: import("react").ReactNode;
}

// Suggestion tiles cycle through the semantic token pairs so both themes work.
const SUGGEST_TONES = [
	{ bg: "var(--inno-accent-soft)", fg: "var(--inno-accent)" },
	{ bg: "var(--inno-success-bg)", fg: "var(--inno-success)" },
	{ bg: "var(--inno-warning-bg)", fg: "var(--inno-warning)" },
	{ bg: "var(--inno-danger-bg)", fg: "var(--inno-danger)" },
];

export function ChatWelcome({
	welcomeLayoutRef,
	simpleMode,
	togglingMode,
	onToggleMode,
	questionHint,
	busyBlocker,
	smartToast,
	composer,
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
	topOverlay,
}: ChatWelcomeProps) {
	const { t } = useTranslation();
	// Suggestion cards come from the real preset catalog — nothing invented.
	const suggestions = simpleMode ? [] : presets.slice(0, 4);
	return (
		<section className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[var(--inno-chat-bg)]">
			{topOverlay}
			{smartToast}
			{/* Soft radial glow behind the welcome column */}
			<div
				aria-hidden
				className="pointer-events-none absolute left-1/2 top-[56%] h-[620px] w-[900px] -translate-x-1/2 -translate-y-1/2"
				style={{
					background:
						"radial-gradient(ellipse at center, var(--inno-glow-1) 0%, var(--inno-glow-2) 35%, var(--inno-glow-3) 60%, transparent 78%)",
				}}
			/>
			<div className="relative z-[1] flex min-h-0 flex-1 justify-center overflow-y-auto px-4">
				<div ref={welcomeLayoutRef} className="inno-welcome-layout flex w-full max-w-[760px] flex-col items-center pb-12 pt-[14vh]">
					<div className="inno-welcome-upper flex w-full flex-col items-center text-center">
						<button
							type="button"
							onClick={onToggleMode}
							disabled={togglingMode}
							title={simpleMode ? t("mode.currentSimpleClickNormal") : t("mode.currentNormalClickSimple")}
							aria-label={simpleMode ? t("mode.switchToNormal") : t("mode.switchToSimple")}
							className="flip-card-scene mb-4 rounded-xl outline-none focus-visible:shadow-[var(--inno-ring)] disabled:cursor-wait"
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
						<h1 className="text-[28px] font-normal tracking-wide text-[var(--inno-text)]">{t("welcome.greeting")}</h1>
						<ModeSegmentedControl
							simpleMode={simpleMode}
							togglingMode={togglingMode}
							onToggleMode={onToggleMode}
							className="mt-3"
						/>

						{questionHint}
						{busyBlocker}
					</div>

					<div className="inno-welcome-composer-shell w-full max-w-[620px]">
						{composer}
					</div>

					{suggestions.length > 0 ? (
						<div className="mt-10 grid w-full grid-cols-2 gap-3 lg:grid-cols-4">
							{suggestions.map((preset, index) => {
								const tone = SUGGEST_TONES[index % SUGGEST_TONES.length];
								const PresetIcon = (preset.icon && PRESET_ICONS[preset.icon]) || Sparkles;
								return (
									<button
										key={preset.id}
										type="button"
										disabled={openingPresetId !== null}
										onClick={() => onOpenPreset(preset.id)}
										title={preset.description}
										className="rounded-2xl border border-[var(--inno-border)] bg-[var(--inno-card-bg)] p-4 text-left transition duration-150 hover:-translate-y-0.5 hover:shadow-[var(--inno-shadow-soft)] disabled:opacity-50"
									>
										<span
											className="mb-2.5 flex h-8 w-8 items-center justify-center rounded-[10px]"
											style={{ background: tone.bg, color: tone.fg }}
										>
											<PresetIcon size={17} strokeWidth={1.8} />
										</span>
										<span className="mb-1 block truncate text-[13.5px] font-medium text-[var(--inno-text)]">{preset.name}</span>
										<span className="block text-xs leading-relaxed text-[var(--inno-text-subtle)]" style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
											{openingPresetId === preset.id ? t("presets.opening") : preset.description}
										</span>
									</button>
								);
							})}
						</div>
					) : null}

					{simpleMode && (presets.length > 0 || presetsLoaded || isLoadingPresets || presetsRefreshError) ? (
						<div className="w-full">
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
						</div>
					) : null}

					{wsError ? <p className="mt-2 text-xs text-[var(--inno-danger)]">{wsError}</p> : null}
				</div>
			</div>
			{simpleMode ? null : <TerminalDrawer />}
		</section>
	);
}
