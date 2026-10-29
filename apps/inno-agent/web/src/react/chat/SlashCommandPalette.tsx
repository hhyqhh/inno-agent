import { useEffect, useRef, type ReactNode } from "react";
import { FilePlus2, Cpu, TerminalSquare, Zap, GraduationCap, BookOpen, CalendarClock, Puzzle, Settings, History, BookmarkPlus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MenuOption, Tooltip } from "../ui/index.js";
import type { SlashPaletteEntry } from "./slash-palette-utils.js";

export interface SlashCommandPaletteProps {
	entries: SlashPaletteEntry[];
	activeIndex: number;
	query: string;
	onSelect: (entry: SlashPaletteEntry) => void;
	onActiveChange: (index: number) => void;
}

const APP_ACTION_ICONS = {
	"new-chat": <FilePlus2 size={15} />,
	model: <Cpu size={15} />,
	profile: <GraduationCap size={15} />,
	jobs: <CalendarClock size={15} />,
	skills: <Puzzle size={15} />,
	settings: <Settings size={15} />,
} as const;

const AGENT_COMMAND_ICONS: Record<string, ReactNode> = {
	recall: <History size={15} />,
	remember: <BookmarkPlus size={15} />,
	wiki: <BookOpen size={15} />,
};

function entryIcon(entry: SlashPaletteEntry) {
	if (entry.group === "app") {
		return entry.action ? APP_ACTION_ICONS[entry.action] : <TerminalSquare size={15} />;
	}
	const known = AGENT_COMMAND_ICONS[entry.name];
	if (known) return known;
	if (entry.name.startsWith("skill:")) return <Zap size={15} />;
	return <TerminalSquare size={15} />;
}

/**
 * Codex-style slash-command menu shown above the composer while the draft is
 * a bare `/query`. Purely presentational — ChatCenter owns filtering,
 * keyboard navigation, and what "select" means per entry.
 */
export function SlashCommandPalette({ entries, activeIndex, query, onSelect, onActiveChange }: SlashCommandPaletteProps) {
	const { t } = useTranslation();
	const paletteRef = useRef<HTMLDivElement | null>(null);
	const listRef = useRef<HTMLDivElement | null>(null);
	const skipMouseScrollRef = useRef(false);

	// Keep the palette above the composer without changing the model menu's
	// shared visual treatment.
	useEffect(() => {
		const palette = paletteRef.current;
		const composer = palette?.parentElement;
		if (!palette || !composer) return;
		const updateHeight = () => {
			const available = Math.max(160, Math.floor(composer.getBoundingClientRect().top - 32));
			palette.style.setProperty("--inno-slash-palette-max-height", `${available}px`);
		};
		updateHeight();
		window.addEventListener("resize", updateHeight);
		return () => {
			window.removeEventListener("resize", updateHeight);
		};
	}, []);

	// Keep the active row in view during keyboard navigation.
	useEffect(() => {
		if (skipMouseScrollRef.current) {
			skipMouseScrollRef.current = false;
			return;
		}
		const list = listRef.current;
		const active = list?.querySelector<HTMLElement>('[data-active="true"]');
		active?.scrollIntoView({ block: "nearest" });
	}, [activeIndex]);

	let lastGroup: SlashPaletteEntry["group"] | null = null;
	return (
		<div
			ref={paletteRef}
			className="inno-popover-surface inno-slash-palette"
			role="listbox"
			aria-label={t("chat.slashPalette.ariaLabel")}
		>
			<div ref={listRef} className="inno-slash-palette-list py-1">
				{entries.length === 0 ? (
					<div className="px-3 py-2 text-xs text-[var(--inno-text-muted)]">
						{t("chat.slashPalette.empty", { query })}
					</div>
				) : (
					entries.map((entry, index) => {
						const showGroupHeader = entry.group !== lastGroup;
						lastGroup = entry.group;
						return (
							<div key={entry.key}>
								{showGroupHeader ? (
									<div className="px-3 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-[var(--inno-text-subtle)]">
										{entry.group === "app" ? t("chat.slashPalette.appGroup") : t("chat.slashPalette.agentGroup")}
									</div>
								) : null}
								<MenuOption
									role="option"
									aria-selected={index === activeIndex}
									data-active={index === activeIndex}
									className={`inno-slash-command-option ${
										index === activeIndex
										? "is-selected"
											: ""
									}`}
									onMouseEnter={() => {
										if (index === activeIndex) return;
										skipMouseScrollRef.current = true;
										onActiveChange(index);
									}}
									onClick={() => onSelect(entry)}
								>
									<span className="shrink-0 text-[var(--inno-text-muted)]">{entryIcon(entry)}</span>
									<span className="shrink-0 font-medium">/{entry.name}</span>
									{entry.description ? (
										<Tooltip label={entry.description}>
											<span className="min-w-0 flex-1 truncate text-right text-xs text-[var(--inno-text-muted)]">
												{entry.description}
											</span>
										</Tooltip>
									) : null}
								</MenuOption>
							</div>
						);
					})
				)}
			</div>
		</div>
	);
}
