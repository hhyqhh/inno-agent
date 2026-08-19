import { Search, X } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { PresetMeta } from "../../types/presets.js";
import { groupByCategory, matchesQuery } from "../../utils/category-grouping.js";

interface PresetPickerProps {
	presets: PresetMeta[];
	openingPresetId: string | null;
	query: string;
	onQueryChange: (value: string) => void;
	onOpen: (id: string) => void;
}

/** Searchable, grouped preset grid used by Simple Mode's welcome screen. */
export function PresetPicker({ presets, openingPresetId, query, onQueryChange, onOpen }: PresetPickerProps) {
	const { t } = useTranslation();
	const uncategorizedLabel = t("presets.uncategorized");
	const groups = useMemo(
		() => groupByCategory(
			presets.filter((preset) => matchesQuery(
				preset,
				query,
				preset.category ? t(`categories.${preset.category}`, preset.category) : undefined,
			)),
			uncategorizedLabel,
		),
		[presets, query, uncategorizedLabel, t],
	);
	const totalMatched = useMemo(() => groups.reduce((sum, [, items]) => sum + items.length, 0), [groups]);
	const showSearch = presets.length >= 4;

	return (
		<div className="mt-5">
			<div className="mb-2 flex items-center gap-2">
				<div className="text-xs font-medium text-[var(--inno-text-muted)]">{t("presets.simpleModeHeader")}</div>
				<span className="text-[10px] text-[var(--inno-text-subtle)]">· {presets.length}</span>
			</div>

			{showSearch ? (
				<div className="mb-2 flex items-center gap-2 rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2 py-1.5">
					<Search size={14} className="shrink-0 text-[var(--inno-text-subtle)]" />
					<input
						type="text"
						value={query}
						onChange={(event) => onQueryChange(event.target.value)}
						placeholder={t("presets.searchPlaceholder")}
						className="min-w-0 flex-1 bg-transparent text-xs text-[var(--inno-text)] placeholder:text-[var(--inno-text-subtle)] focus:outline-none"
					/>
					{query ? (
						<button
							type="button"
							className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--inno-text-subtle)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]"
							onClick={() => onQueryChange("")}
						>
							<X size={12} />
						</button>
					) : null}
				</div>
			) : null}

			<div className="max-h-[50vh] overflow-y-auto rounded-md">
				{totalMatched === 0 ? (
					<div className="py-6 text-center text-xs text-[var(--inno-text-muted)]">{t("presets.noResults")}</div>
				) : (
					groups.map(([category, items]) => (
						<div key={category} className="mb-3 last:mb-0">
							{groups.length > 1 ? (
								<div className="mb-1.5 px-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--inno-text-subtle)]">
									{t(`categories.${category}`, category)} <span className="ml-1 text-[var(--inno-text-subtle)]">· {items.length}</span>
								</div>
							) : null}
							<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
								{items.map((preset) => (
									<button
										key={preset.id}
										type="button"
										disabled={openingPresetId !== null}
										onClick={() => onOpen(preset.id)}
										title={preset.description}
										className="group flex flex-col items-start rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-2.5 text-left transition-colors hover:border-[var(--inno-accent)] hover:bg-[var(--inno-surface-muted)] disabled:opacity-50"
									>
										<span className="text-sm font-medium text-[var(--inno-text)] group-hover:text-[var(--inno-accent)]">{preset.name}</span>
										{preset.description ? (
											<span className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-[var(--inno-text-muted)]">{preset.description}</span>
										) : null}
										{openingPresetId === preset.id ? (
											<span className="mt-1 text-[10px] text-[var(--inno-accent)]">{t("presets.opening")}</span>
										) : null}
									</button>
								))}
							</div>
						</div>
					))
				)}
			</div>
		</div>
	);
}
