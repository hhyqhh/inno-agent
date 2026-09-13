import type { ReactNode, RefObject } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, Check, ClipboardList, FlaskConical, GraduationCap, Lightbulb, Monitor, Presentation, RefreshCw, Search, Shapes, Sparkles, TrendingUp, X } from "lucide-react";
import type { PresetMeta } from "../../types/presets.js";
import { matchesQuery } from "../../utils/category-grouping.js";
import { Spinner } from "../ui/Spinner.js";
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

/** Search appears once the catalog is too large to scan as cards. */
const SEARCH_MIN_PRESETS = 8;

interface ChatWelcomeProps {
	welcomeLayoutRef: RefObject<HTMLDivElement | null>;
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

// Preset cards cycle through the semantic token pairs so both themes work.
const CARD_TONES = [
	{ bg: "var(--inno-accent-soft)", fg: "var(--inno-accent)" },
	{ bg: "var(--inno-success-bg)", fg: "var(--inno-success)" },
	{ bg: "var(--inno-warning-bg)", fg: "var(--inno-warning)" },
	{ bg: "var(--inno-danger-bg)", fg: "var(--inno-danger)" },
];

export function ChatWelcome({
	welcomeLayoutRef,
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
	const refreshStatusLabel = presetRefreshStatus === "success" ? t("presets.refreshSucceeded") : t("presets.refreshFailed");
	const visiblePresets = presetQuery
		? presets.filter((preset) => matchesQuery(
			preset,
			presetQuery,
			preset.category ? t(`categories.${preset.category}`, preset.category) : undefined,
		))
		: presets;
	return (
		<section className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[var(--inno-chat-bg)]">
			<div className="inno-chat-top-drag-region" aria-hidden="true" />
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
						<div className="mb-4 flex h-12 w-12 select-none items-center justify-center rounded-xl border border-[var(--inno-border)] bg-[var(--inno-surface)] text-base font-semibold text-[var(--inno-text)] shadow-sm">IA</div>
						<h1 className="text-[28px] font-normal tracking-wide text-[var(--inno-text)]">{t("welcome.greeting")}</h1>

						{questionHint}
						{busyBlocker}
					</div>

					<div className="inno-welcome-composer-shell w-full max-w-[620px]">
						{composer}
					</div>

					{presetsLoaded || isLoadingPresets || presetsRefreshError ? (
						<div className="mt-10 w-full">
							{/* Section header: title + count + refresh (with status badge) */}
							<div className="mb-3 flex items-center gap-2">
								<div className="text-xs font-medium text-[var(--inno-text-muted)]">{t("presets.sectionTitle")}</div>
								{presets.length > 0 ? <span className="text-[10px] text-[var(--inno-text-subtle)]">· {presets.length}</span> : null}
								<div className="ml-auto flex items-center gap-1.5">
									<button
										type="button"
										disabled={isLoadingPresets || isRefreshingPresets}
										onClick={onRefreshPresets}
										title={t("presets.refresh")}
										className="relative flex h-6 w-6 items-center justify-center rounded text-[var(--inno-text-subtle)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)] disabled:cursor-wait disabled:opacity-50"
									>
										{isRefreshingPresets ? <Spinner size={12} /> : <RefreshCw size={13} />}
										{presetRefreshStatus ? (
											<span
												className={`absolute -right-1 -top-1 flex h-3 w-3 items-center justify-center rounded-full text-[8px] font-bold leading-none text-white shadow-sm ${presetRefreshStatus === "error" ? "bg-[var(--inno-danger)]" : "bg-[var(--inno-success)]"}`}
												title={refreshStatusLabel}
												aria-label={refreshStatusLabel}
											>
												{presetRefreshStatus === "error" ? "!" : <Check size={8} strokeWidth={3} />}
											</span>
										) : null}
									</button>
								</div>
							</div>

							{presets.length >= SEARCH_MIN_PRESETS ? (
								<div className="mb-3 flex items-center gap-2 rounded-[14px] border border-[var(--inno-border)] bg-[var(--inno-card-bg)] px-3 py-2">
									<Search size={14} className="shrink-0 text-[var(--inno-text-subtle)]" />
									<input
										type="text"
										value={presetQuery}
										onChange={(event) => onPresetQueryChange(event.target.value)}
										placeholder={t("presets.searchPlaceholder")}
										className="min-w-0 flex-1 bg-transparent text-xs text-[var(--inno-text)] placeholder:text-[var(--inno-text-subtle)] focus:outline-none"
									/>
									{presetQuery ? (
										<button
											type="button"
											className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--inno-text-subtle)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]"
											onClick={() => onPresetQueryChange("")}
										>
											<X size={12} />
										</button>
									) : null}
								</div>
							) : null}

							{isLoadingPresets && visiblePresets.length === 0 ? (
								<div className="flex items-center justify-center gap-2 py-6 text-xs text-[var(--inno-text-muted)]">
									<Spinner size={14} />
									{t("common.loading")}
								</div>
							) : visiblePresets.length === 0 ? (
								<div className="py-6 text-center text-xs text-[var(--inno-text-muted)]">{t("presets.noResults")}</div>
							) : (
								<div className="grid w-full grid-cols-2 gap-3 lg:grid-cols-4">
									{visiblePresets.map((preset, index) => {
										const tone = CARD_TONES[index % CARD_TONES.length];
										const PresetIcon = (preset.icon && PRESET_ICONS[preset.icon]) || Sparkles;
										const loaded = loadedPresetIds.has(preset.id);
										return (
											<button
												key={preset.id}
												type="button"
												disabled={openingPresetId !== null}
												onClick={() => onOpenPreset(preset.id)}
												title={preset.description}
												className="relative rounded-2xl border border-[var(--inno-border)] bg-[var(--inno-card-bg)] p-4 text-left transition duration-150 hover:-translate-y-0.5 hover:shadow-[var(--inno-shadow-soft)] disabled:opacity-50"
											>
												{loaded ? (
													<span className="absolute right-3 top-3 rounded-md bg-[var(--inno-success-bg)] px-1.5 py-0.5 text-[10px] font-medium leading-none text-[var(--inno-success)]">{t("presets.loaded")}</span>
												) : null}
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
							)}
						</div>
					) : null}

					{wsError ? <p className="mt-2 text-xs text-[var(--inno-danger)]">{wsError}</p> : null}
				</div>
			</div>
			<TerminalDrawer />
		</section>
	);
}
