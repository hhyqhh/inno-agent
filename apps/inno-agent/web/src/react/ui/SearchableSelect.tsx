import { Check, Search, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode, type RefObject } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "./Popover.js";
import { MenuOption } from "./Menu.js";
import { Separator } from "./Separator.js";
import { Tooltip } from "./Tooltip.js";

export interface SearchableSelectOption {
	value: string;
	label: string;
	searchText?: string;
	title?: string;
	description?: ReactNode;
	icon?: ReactNode;
	disabled?: boolean;
	className?: string;
}

export interface SearchableSelectSection {
	id: string;
	label?: string;
	options: readonly SearchableSelectOption[];
}

export interface SearchableSelectAction {
	id: string;
	label: ReactNode;
	icon?: ReactNode;
	selected?: boolean;
	disabled?: boolean;
	closeOnSelect?: boolean;
	onSelect: () => void;
}

interface SearchableSelectProps {
	trigger: ReactElement;
	sections: readonly SearchableSelectSection[];
	value?: string | null;
	open?: boolean;
	onValueChange: (value: string) => void;
	onOpenChange?: (open: boolean) => void;
	searchPlaceholder: string;
	clearSearchLabel?: string;
	emptyMessage: ReactNode;
	ariaLabel: string;
	triggerTooltip?: ReactNode;
	triggerTooltipDescription?: ReactNode;
	actions?: readonly SearchableSelectAction[];
	/** Replaces the default search/list panel for a distinct state such as item creation. */
	customContent?: ReactNode;
	initialFocusRef?: RefObject<HTMLInputElement | null>;
	contentClassName?: string;
	searchClassName?: string;
	optionClassName?: string;
	actionClassName?: string;
	maxListHeight?: number;
	side?: "top" | "right" | "bottom" | "left";
	align?: "start" | "center" | "end";
	sideOffset?: number;
	collisionPadding?: number;
}

/**
 * Standard searchable single-choice panel. Search, filtering, listbox states,
 * keyboard movement, selected marks and footer actions stay consistent while
 * callers provide only the options and their product-specific actions.
 */
export function SearchableSelect({
	trigger,
	sections,
	value = null,
	open,
	onValueChange,
	onOpenChange,
	searchPlaceholder,
	clearSearchLabel = "Clear search",
	emptyMessage,
	ariaLabel,
	triggerTooltip,
	triggerTooltipDescription,
	actions = [],
	customContent,
	initialFocusRef,
	contentClassName = "",
	searchClassName = "",
	optionClassName = "",
	actionClassName = "",
	maxListHeight = 280,
	side = "bottom",
	align = "start",
	sideOffset = 6,
	collisionPadding = 8,
}: SearchableSelectProps) {
	const generatedId = useId();
	const searchId = `${generatedId}-search`;
	const listboxId = `${generatedId}-listbox`;
	const searchRef = useRef<HTMLInputElement>(null);
	const listboxRef = useRef<HTMLDivElement>(null);
	const [internalOpen, setInternalOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [activeValue, setActiveValue] = useState<string | null>(null);
	const isControlled = open !== undefined;
	const isOpen = isControlled ? open : internalOpen;

	const filteredSections = useMemo(() => {
		const normalized = query.trim().toLocaleLowerCase();
		return sections
			.map((section) => ({
				...section,
				options: section.options.filter((option) => {
					if (!normalized) return true;
					const searchable = `${option.label} ${option.searchText ?? ""}`.toLocaleLowerCase();
					return searchable.includes(normalized);
				}),
			}))
			.filter((section) => section.options.length > 0);
	}, [query, sections]);
	const filteredOptions = useMemo(() => filteredSections.flatMap((section) => section.options), [filteredSections]);
	const activeIndex = filteredOptions.findIndex((option) => option.value === activeValue);
	const hasResults = filteredOptions.length > 0;
	const hasCustomContent = customContent !== undefined && customContent !== null;

	useEffect(() => {
		if (isOpen && hasCustomContent) initialFocusRef?.current?.focus();
	}, [hasCustomContent, initialFocusRef, isOpen]);

	const keepOptionVisible = (index: number) => {
		const listbox = listboxRef.current;
		const option = document.getElementById(`${listboxId}-option-${index}`);
		if (!listbox || !option) return;

		const listboxRect = listbox.getBoundingClientRect();
		const optionRect = option.getBoundingClientRect();
		if (optionRect.top < listboxRect.top) {
			listbox.scrollTop -= listboxRect.top - optionRect.top;
		} else if (optionRect.bottom > listboxRect.bottom) {
			listbox.scrollTop += optionRect.bottom - listboxRect.bottom;
		}
	};

	const changeOpen = (nextOpen: boolean) => {
		if (!isControlled) setInternalOpen(nextOpen);
		if (!nextOpen) {
			setQuery("");
			setActiveValue(null);
		}
		onOpenChange?.(nextOpen);
	};

	const choose = (option: SearchableSelectOption) => {
		if (option.disabled) return;
		onValueChange(option.value);
		changeOpen(false);
	};

	const moveActive = (direction: 1 | -1) => {
		if (filteredOptions.length === 0) return;
		let candidate = activeIndex < 0
			? (direction === 1 ? 0 : filteredOptions.length - 1)
			: (activeIndex + direction + filteredOptions.length) % filteredOptions.length;
		for (let count = 0; count < filteredOptions.length; count += 1) {
			if (!filteredOptions[candidate]?.disabled) {
				keepOptionVisible(candidate);
				setActiveValue(filteredOptions[candidate].value);
				return;
			}
			candidate = (candidate + direction + filteredOptions.length) % filteredOptions.length;
		}
	};

	const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "ArrowDown") {
			event.preventDefault();
			moveActive(1);
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			moveActive(-1);
		} else if (event.key === "Enter" && hasResults) {
			event.preventDefault();
			const option = activeIndex >= 0
				? filteredOptions[activeIndex]
				: filteredOptions.find((candidate) => !candidate.disabled);
			if (option) choose(option);
		}
	};

	return (
		<Popover open={isOpen} onOpenChange={changeOpen}>
			{triggerTooltip ? (
				<Tooltip label={triggerTooltip} description={triggerTooltipDescription}>
					<PopoverTrigger asChild>{trigger}</PopoverTrigger>
				</Tooltip>
			) : <PopoverTrigger asChild>{trigger}</PopoverTrigger>}
			<PopoverContent
				align={align}
				side={side}
				sideOffset={sideOffset}
				collisionPadding={collisionPadding}
				aria-label={ariaLabel}
				className={`inno-ui-searchable-select${contentClassName ? ` ${contentClassName}` : ""}`}
				onOpenAutoFocus={(event) => {
					const target = initialFocusRef?.current ?? searchRef.current;
					if (target) {
						event.preventDefault();
						target.focus();
					}
				}}
			>
				{customContent ?? (
					<>
						<div className={`inno-ui-searchable-select-search${searchClassName ? ` ${searchClassName}` : ""}`}>
							<Search size={14} aria-hidden="true" />
							<input
								ref={searchRef}
								id={searchId}
								role="combobox"
								aria-label={searchPlaceholder}
								aria-autocomplete="list"
								aria-expanded={isOpen}
								aria-controls={listboxId}
								aria-activedescendant={activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined}
								value={query}
								placeholder={searchPlaceholder}
								onChange={(event) => {
									setQuery(event.target.value);
									setActiveValue(null);
								}}
								onKeyDown={handleSearchKeyDown}
							/>
							{query ? (
								<button
									type="button"
									className="inno-ui-searchable-select-clear"
									aria-label={clearSearchLabel}
									onClick={() => {
										setQuery("");
										setActiveValue(null);
										searchRef.current?.focus();
									}}
								>
									<X size={13} />
								</button>
							) : null}
						</div>
						<div
							id={listboxId}
							role="listbox"
							aria-label={ariaLabel}
							ref={listboxRef}
							className="inno-ui-searchable-select-list"
							style={{ maxHeight: maxListHeight }}
						>
							{filteredSections.length ? filteredSections.map((section, sectionIndex) => (
								<div key={section.id} role={section.label ? "group" : undefined} aria-label={section.label}>
									{sectionIndex > 0 ? <Separator decorative={false} className="inno-ui-searchable-select-separator" /> : null}
									{section.label ? <div className="inno-ui-searchable-select-group-label">{section.label}</div> : null}
									{section.options.map((option) => {
										const optionIndex = filteredOptions.findIndex((candidate) => candidate.value === option.value);
										const selected = option.value === value;
										const active = option.value === activeValue;
										const optionId = `${listboxId}-option-${optionIndex}`;
										return (
												<MenuOption
													key={option.value}
													id={optionId}
													tabIndex={-1}
													role="option"
													aria-selected={selected}
													aria-disabled={option.disabled || undefined}
													disabled={option.disabled}
													data-active={active || undefined}
													data-selected={selected || undefined}
													className={`inno-ui-searchable-select-option${optionClassName ? ` ${optionClassName}` : ""}${option.className ? ` ${option.className}` : ""}`}
													title={option.title ?? (typeof option.description === "string" ? option.description : undefined)}
													onClick={() => choose(option)}
											>
												{option.icon ? <span className="inno-ui-searchable-select-icon" aria-hidden="true">{option.icon}</span> : null}
												<span className="inno-ui-searchable-select-copy">
													<span className="inno-ui-searchable-select-label">{option.label}</span>
													{option.description ? <span className="inno-ui-searchable-select-description">{option.description}</span> : null}
												</span>
													{selected ? <Check size={15} className="inno-ui-searchable-select-check" aria-hidden="true" /> : null}
												</MenuOption>
										);
									})}
								</div>
							)) : <div className="inno-ui-searchable-select-empty">{emptyMessage}</div>}
						</div>
						{actions.length ? (
							<div className="inno-ui-searchable-select-actions">
								<Separator decorative={false} className="inno-ui-searchable-select-actions-separator" />
								{actions.map((action) => (
									<MenuOption
										key={action.id}
										aria-pressed={action.selected}
										data-selected={action.selected || undefined}
										className={`inno-ui-searchable-select-action${actionClassName ? ` ${actionClassName}` : ""}`}
										disabled={action.disabled}
										onClick={() => {
											action.onSelect();
											if (action.closeOnSelect !== false) changeOpen(false);
										}}
									>
										{action.icon ? <span className="inno-ui-searchable-select-icon" aria-hidden="true">{action.icon}</span> : null}
										<span className="inno-ui-searchable-select-label">{action.label}</span>
										{action.selected ? <Check size={15} className="inno-ui-searchable-select-check" aria-hidden="true" /> : null}
									</MenuOption>
								))}
							</div>
						) : null}
					</>
				)}
			</PopoverContent>
		</Popover>
	);
}
