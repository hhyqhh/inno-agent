import { forwardRef, useRef, type HTMLAttributes, type KeyboardEvent, type ReactNode } from "react";
import { X } from "lucide-react";
import { Tooltip } from "./Tooltip.js";

export interface TabItem<Value extends string> {
	value: Value;
	label: ReactNode;
	ariaLabel?: string;
	title?: string;
	disabled?: boolean;
	close?: { label: string; onClose: () => void };
}

interface SelectableControlProps<Value extends string> {
	value: Value;
	onValueChange: (value: Value) => void;
	items: readonly TabItem<Value>[];
	ariaLabel: string;
	className?: string;
}

export interface TabsProps<Value extends string> extends SelectableControlProps<Value> {
	/** Stable prefix used to associate each tab with its tab panel. */
	id: string;
	size?: "compact" | "sm";
	spacing?: "compact" | "comfortable";
	variant?: "underline" | "pill" | "browser";
}

export function getTabTriggerId(id: string, value: string): string {
	return `${id}-tab-${value}`;
}

type ButtonRefs = { current: Array<HTMLButtonElement | null> };

function moveToNextEnabled<Value extends string>(
	event: KeyboardEvent<HTMLButtonElement>,
	items: readonly TabItem<Value>[],
	currentIndex: number,
	buttons: ButtonRefs,
	onValueChange: (value: Value) => void,
	includeVerticalKeys = true,
) {
	let nextIndex: number | null = null;
	if (event.key === "Home") nextIndex = items.findIndex((item) => !item.disabled);
	else if (event.key === "End") {
		for (let index = items.length - 1; index >= 0; index -= 1) {
			if (!items[index]?.disabled) {
				nextIndex = index;
				break;
			}
		}
	} else if (event.key === "ArrowRight" || (includeVerticalKeys && event.key === "ArrowDown")) {
		for (let offset = 1; offset <= items.length; offset += 1) {
			const index = (currentIndex + offset) % items.length;
			if (!items[index]?.disabled) {
				nextIndex = index;
				break;
			}
		}
	} else if (event.key === "ArrowLeft" || (includeVerticalKeys && event.key === "ArrowUp")) {
		for (let offset = 1; offset <= items.length; offset += 1) {
			const index = (currentIndex - offset + items.length) % items.length;
			if (!items[index]?.disabled) {
				nextIndex = index;
				break;
			}
		}
	}

	if (nextIndex === null || nextIndex < 0 || nextIndex === currentIndex) return;
	event.preventDefault();
	buttons.current[nextIndex]?.focus();
	const nextItem = items[nextIndex];
	if (nextItem) onValueChange(nextItem.value);
}

export function Tabs<Value extends string>({
	id,
	value,
	onValueChange,
	items,
	ariaLabel,
	size = "sm",
	spacing = "compact",
	variant = "underline",
	className = "",
}: TabsProps<Value>) {
	const buttons = useRef<Array<HTMLButtonElement | null>>([]);
	const selectedIndex = items.findIndex((item) => item.value === value && !item.disabled);
	const firstEnabledIndex = items.findIndex((item) => !item.disabled);

	return (
		<div
			id={`${id}-list`}
			role="tablist"
			aria-label={ariaLabel}
			className={`inno-ui-tabs inno-ui-tabs--${variant} inno-ui-tabs--size-${size} inno-ui-tabs--spacing-${spacing}${className ? ` ${className}` : ""}`}
		>
			{items.map((item, index) => {
				const selected = index === selectedIndex;
				const trigger = (
					<button
						key={item.value}
						ref={(element) => { buttons.current[index] = element; }}
						type="button"
						id={getTabTriggerId(id, item.value)}
						role="tab"
						aria-selected={selected}
						aria-controls={`${id}-panel`}
						aria-label={item.ariaLabel}
						aria-keyshortcuts={item.close ? "Delete" : undefined}
						tabIndex={selected || (selectedIndex < 0 && index === firstEnabledIndex) ? 0 : -1}
						disabled={item.disabled}
						title={item.disabled ? item.title : undefined}
						className={`inno-ui-tabs__trigger${item.close ? " inno-ui-tabs__trigger--closable" : ""}`}
						onClick={(event) => {
							if (event.target instanceof Element && event.target.closest("[data-inno-tab-close]")) {
								event.preventDefault();
								event.currentTarget.focus({ preventScroll: true });
								item.close?.onClose();
								return;
							}
							onValueChange(item.value);
						}}
						onKeyDown={(event) => {
							if (event.key === "Delete" && item.close) {
								event.preventDefault();
								item.close.onClose();
								return;
							}
							moveToNextEnabled(event, items, index, buttons, onValueChange, false);
						}}
					>
						<span className="inno-ui-tabs__label">{item.label}</span>
						{item.close ? (
							<Tooltip label={item.close.label}>
								<span data-inno-tab-close="" aria-hidden="true" className="inno-ui-tabs__close">
									<X size={12} />
								</span>
							</Tooltip>
						) : null}
					</button>
				);
				return item.title && !item.disabled ? <Tooltip key={item.value} label={item.title}>{trigger}</Tooltip> : trigger;
			})}
		</div>
	);
}

export interface TabPanelProps extends Omit<HTMLAttributes<HTMLDivElement>, "role" | "aria-labelledby" | "tabIndex"> {
	labelledBy?: string;
	tabIndex?: number;
}

export const TabPanel = forwardRef<HTMLDivElement, TabPanelProps>(function TabPanel(
	{ labelledBy, className = "", tabIndex = 0, ...props },
	ref,
) {
	return (
		<div
			{...props}
			ref={ref}
			role="tabpanel"
			aria-labelledby={labelledBy}
			tabIndex={tabIndex}
			className={`inno-ui-tab-panel${className ? ` ${className}` : ""}`}
		/>
	);
});

export type SegmentedControlProps<Value extends string> = SelectableControlProps<Value> & {
	variant?: "default" | "toolbar" | "rail";
	orientation?: "horizontal" | "vertical";
	/** Rail only: keep trailing options mounted while collapsing to the first. */
	collapsed?: boolean;
	/** Preview an option without committing navigation or a persistent selection. */
	onValuePreview?: (value: Value) => void;
};

/** Single-choice control with radio semantics and arrow-key selection. */
export function SegmentedControl<Value extends string>({
	value,
	onValueChange,
	items,
	ariaLabel,
	variant = "default",
	orientation = "horizontal",
	collapsed = false,
	onValuePreview,
	className = "",
}: SegmentedControlProps<Value>) {
	const buttons = useRef<Array<HTMLButtonElement | null>>([]);
	// Removing the file option on hover close cut off its fade before the rail
	// finished shrinking. Keep its node, but exclude it from all interaction.
	const visibleItems = variant === "rail" && collapsed ? items.slice(0, 1) : items;
	const selectedIndex = visibleItems.findIndex((item) => item.value === value && !item.disabled);
	const firstEnabledIndex = visibleItems.findIndex((item) => !item.disabled);

	return (
		<div
			role="radiogroup"
			aria-label={ariaLabel}
			aria-orientation={orientation}
			data-option-count={visibleItems.length}
			data-selected-index={selectedIndex}
			className={`inno-ui-segmented-control inno-ui-segmented-control--${variant}${className ? ` ${className}` : ""}`}
		>
			{items.map((item, index) => {
				const selected = index === selectedIndex;
				const collapsedOption = index >= visibleItems.length;
				const option = (
					<button
						key={item.value}
						ref={(element) => { buttons.current[index] = element; }}
						type="button"
						role="radio"
						aria-checked={selected}
						aria-label={item.ariaLabel}
						aria-hidden={collapsedOption || undefined}
						inert={collapsedOption || undefined}
						tabIndex={!collapsedOption && (selected || (selectedIndex < 0 && index === firstEnabledIndex)) ? 0 : -1}
						disabled={item.disabled || collapsedOption}
						title={item.disabled ? item.title : undefined}
						className="inno-ui-segmented-control__option"
						onPointerEnter={() => { if (!collapsedOption) onValuePreview?.(item.value); }}
						onFocus={() => { if (!collapsedOption) onValuePreview?.(item.value); }}
						onClick={() => onValueChange(item.value)}
						onKeyDown={(event) => moveToNextEnabled(event, visibleItems, index, buttons, onValueChange)}
					>
						{item.label}
					</button>
				);
				return item.title && !item.disabled ? <Tooltip key={item.value} label={item.title}>{option}</Tooltip> : option;
			})}
		</div>
	);
}
