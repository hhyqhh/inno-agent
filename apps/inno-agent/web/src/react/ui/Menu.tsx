import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Check, ChevronRight } from "lucide-react";
import { forwardRef, type ComponentPropsWithoutRef, type ComponentRef, type ReactNode } from "react";
import { Tooltip } from "./Tooltip.js";

export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuGroup = DropdownMenuPrimitive.Group;
export const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;
export const DropdownMenuSub = DropdownMenuPrimitive.Sub;
export const DropdownMenuItemIndicator = DropdownMenuPrimitive.ItemIndicator;

type DropdownMenuTriggerProps = ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Trigger>;

export const DropdownMenuTrigger = forwardRef<ComponentRef<typeof DropdownMenuPrimitive.Trigger>, DropdownMenuTriggerProps>(
	function DropdownMenuTrigger({ title, disabled, ...props }, ref) {
		const trigger = <DropdownMenuPrimitive.Trigger ref={ref} disabled={disabled} title={disabled ? title : undefined} {...props} />;
		return title && !disabled ? <Tooltip label={title}>{trigger}</Tooltip> : trigger;
	},
);

type MenuOptionProps = ComponentPropsWithoutRef<"button">;

/** Plain button row for caller-controlled candidate and option lists. */
export const MenuOption = forwardRef<HTMLButtonElement, MenuOptionProps>(function MenuOption(
	{ className = "", type = "button", title, ...props },
	ref,
) {
	const disabled = Boolean(props.disabled || props["aria-disabled"] === true || props["aria-disabled"] === "true");
	const option = (
		<button
			ref={ref}
			type={type}
			className={`inno-menu-option${className ? ` ${className}` : ""}`}
			title={disabled ? title : undefined}
			{...props}
		/>
	);
	return title && !disabled ? <Tooltip label={title}>{option}</Tooltip> : option;
});

type DropdownMenuSubTriggerProps = ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger>;

export const DropdownMenuSubTrigger = forwardRef<ComponentRef<typeof DropdownMenuPrimitive.SubTrigger>, DropdownMenuSubTriggerProps>(
	function DropdownMenuSubTrigger({ className = "", children, title, ...props }, ref) {
		const disabled = Boolean(props.disabled || props["aria-disabled"] === true || props["aria-disabled"] === "true");
		const trigger = (
			<DropdownMenuPrimitive.SubTrigger
				ref={ref}
				className={`inno-menu-option inno-ui-menu-item inno-ui-menu-subtrigger${className ? ` ${className}` : ""}`}
				{...props}
				title={disabled ? title : undefined}
			>
				{children}
				<ChevronRight className="inno-ui-menu-subtrigger-icon" size={14} aria-hidden="true" />
			</DropdownMenuPrimitive.SubTrigger>
		);
		return title && !disabled ? <Tooltip label={title}>{trigger}</Tooltip> : trigger;
	},
);

type DropdownMenuContentProps = ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>;

export const DropdownMenuContent = forwardRef<ComponentRef<typeof DropdownMenuPrimitive.Content>, DropdownMenuContentProps>(
	function DropdownMenuContent({ className = "", collisionPadding = 8, sideOffset = 4, loop = true, ...props }, ref) {
		return (
			<DropdownMenuPrimitive.Portal>
				<DropdownMenuPrimitive.Content
					ref={ref}
					className={`inno-popover-surface inno-ui-menu-content${className ? ` ${className}` : ""}`}
					collisionPadding={collisionPadding}
					sideOffset={sideOffset}
					loop={loop}
					{...props}
				/>
			</DropdownMenuPrimitive.Portal>
		);
	},
);

type DropdownMenuItemProps = ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & {
	variant?: "default" | "danger";
};

export const DropdownMenuItem = forwardRef<ComponentRef<typeof DropdownMenuPrimitive.Item>, DropdownMenuItemProps>(
	function DropdownMenuItem({ className = "", variant = "default", title, ...props }, ref) {
		const disabled = Boolean(props.disabled || props["aria-disabled"] === true || props["aria-disabled"] === "true");
		const item = (
			<DropdownMenuPrimitive.Item
				ref={ref}
				className={`inno-menu-option inno-ui-menu-item${variant === "danger" ? " is-danger" : ""}${className ? ` ${className}` : ""}`}
				title={disabled ? title : undefined}
				{...props}
			/>
		);
		return title && !disabled ? <Tooltip label={title}>{item}</Tooltip> : item;
	},
);

type DropdownMenuCheckboxItemProps = ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>;

export const DropdownMenuCheckboxItem = forwardRef<ComponentRef<typeof DropdownMenuPrimitive.CheckboxItem>, DropdownMenuCheckboxItemProps>(
	function DropdownMenuCheckboxItem({ className = "", children, title, ...props }, ref) {
		const disabled = Boolean(props.disabled || props["aria-disabled"] === true || props["aria-disabled"] === "true");
		const item = (
			<DropdownMenuPrimitive.CheckboxItem
				ref={ref}
				className={`inno-menu-option inno-ui-menu-item inno-ui-menu-item--checkable${className ? ` ${className}` : ""}`}
				title={disabled ? title : undefined}
				{...props}
			>
				{children}
				<DropdownMenuPrimitive.ItemIndicator className="inno-ui-menu-item-indicator" aria-hidden="true">
					<Check size={14} />
				</DropdownMenuPrimitive.ItemIndicator>
			</DropdownMenuPrimitive.CheckboxItem>
		);
		return title && !disabled ? <Tooltip label={title}>{item}</Tooltip> : item;
	},
);

type DropdownMenuRadioItemProps = ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioItem>;

export const DropdownMenuRadioItem = forwardRef<ComponentRef<typeof DropdownMenuPrimitive.RadioItem>, DropdownMenuRadioItemProps>(
	function DropdownMenuRadioItem({ className = "", children, title, ...props }, ref) {
		const disabled = Boolean(props.disabled || props["aria-disabled"] === true || props["aria-disabled"] === "true");
		const item = (
			<DropdownMenuPrimitive.RadioItem
				ref={ref}
				className={`inno-menu-option inno-ui-menu-item inno-ui-menu-item--checkable inno-ui-menu-radio-item${className ? ` ${className}` : ""}`}
				title={disabled ? title : undefined}
				{...props}
			>
				{children}
				<DropdownMenuPrimitive.ItemIndicator className="inno-ui-menu-item-indicator" aria-hidden="true">
					<Check size={14} />
				</DropdownMenuPrimitive.ItemIndicator>
			</DropdownMenuPrimitive.RadioItem>
		);
		return title && !disabled ? <Tooltip label={title}>{item}</Tooltip> : item;
	},
);

type DropdownMenuChoiceItemProps = Omit<DropdownMenuRadioItemProps, "children"> & {
	icon?: ReactNode;
	label: ReactNode;
	description?: ReactNode;
};

/** Complete, data-shaped radio row for settings and workspace menus. */
export function DropdownMenuChoiceItem({ icon, label, description, className = "", ...props }: DropdownMenuChoiceItemProps) {
	return (
		<DropdownMenuRadioItem
			className={`inno-ui-menu-choice${className ? ` ${className}` : ""}`}
			{...props}
		>
			{icon ? <span className="inno-ui-menu-choice-icon" aria-hidden="true">{icon}</span> : null}
			<span className="inno-ui-menu-choice-copy">
				<span className="inno-ui-menu-choice-label">{label}</span>
				{description ? <span className="inno-ui-menu-choice-description">{description}</span> : null}
			</span>
		</DropdownMenuRadioItem>
	);
}

type DropdownMenuOptionItemProps = Omit<DropdownMenuRadioItemProps, "children"> & {
	icon?: ReactNode;
	label: ReactNode;
};

/** Compact single-line radio row for model, theme, and other short options. */
export function DropdownMenuOptionItem({ icon, label, className = "", ...props }: DropdownMenuOptionItemProps) {
	return (
		<DropdownMenuRadioItem
			className={`inno-ui-menu-option-row${className ? ` ${className}` : ""}`}
			{...props}
		>
			{icon ? <span className="inno-ui-menu-choice-icon" aria-hidden="true">{icon}</span> : null}
			<span className="inno-ui-menu-option-row-label">{label}</span>
		</DropdownMenuRadioItem>
	);
}

type DropdownMenuActionItemProps = Omit<DropdownMenuItemProps, "children"> & {
	icon?: ReactNode;
	label: ReactNode;
	shortcut?: ReactNode;
};

/** Complete action row for common icon + label + shortcut menu items. */
export function DropdownMenuActionItem({ icon, label, shortcut, ...props }: DropdownMenuActionItemProps) {
	return (
		<DropdownMenuItem {...props}>
			{icon ? <span className="inno-ui-menu-item-icon" aria-hidden="true">{icon}</span> : null}
			<span className="inno-ui-menu-item-label">{label}</span>
			{shortcut ? <span className="inno-ui-menu-shortcut">{shortcut}</span> : null}
		</DropdownMenuItem>
	);
}

type DropdownMenuLabelProps = ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label>;

export const DropdownMenuLabel = forwardRef<ComponentRef<typeof DropdownMenuPrimitive.Label>, DropdownMenuLabelProps>(
	function DropdownMenuLabel({ className = "", ...props }, ref) {
		return <DropdownMenuPrimitive.Label ref={ref} className={`inno-ui-menu-label${className ? ` ${className}` : ""}`} {...props} />;
	},
);

type DropdownMenuSeparatorProps = ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>;

export const DropdownMenuSeparator = forwardRef<ComponentRef<typeof DropdownMenuPrimitive.Separator>, DropdownMenuSeparatorProps>(
	function DropdownMenuSeparator({ className = "", ...props }, ref) {
		return <DropdownMenuPrimitive.Separator ref={ref} className={`inno-ui-menu-separator${className ? ` ${className}` : ""}`} {...props} />;
	},
);

type DropdownMenuSubContentProps = ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent>;

export const DropdownMenuSubContent = forwardRef<ComponentRef<typeof DropdownMenuPrimitive.SubContent>, DropdownMenuSubContentProps>(
	function DropdownMenuSubContent({ className = "", collisionPadding = 8, sideOffset = 4, ...props }, ref) {
		return (
			<DropdownMenuPrimitive.Portal>
				<DropdownMenuPrimitive.SubContent
					ref={ref}
					className={`inno-popover-surface inno-ui-menu-content${className ? ` ${className}` : ""}`}
					collisionPadding={collisionPadding}
					sideOffset={sideOffset}
					{...props}
				/>
			</DropdownMenuPrimitive.Portal>
		);
	},
);
