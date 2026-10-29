import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { forwardRef, type ComponentPropsWithoutRef, type ComponentRef, type ReactNode } from "react";
import { Tooltip } from "./Tooltip.js";

export const Select = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;

type SelectTriggerProps = ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>;

export const SelectTrigger = forwardRef<ComponentRef<typeof SelectPrimitive.Trigger>, SelectTriggerProps>(
	function SelectTrigger({ className = "", children, title, disabled, ...props }, ref) {
		const trigger = (
			<SelectPrimitive.Trigger ref={ref} disabled={disabled} title={disabled ? title : undefined} className={`inno-ui-select-trigger${className ? ` ${className}` : ""}`} {...props}>
				{children}
				<SelectPrimitive.Icon className="inno-ui-select-trigger-icon" aria-hidden="true">
					<ChevronDown size={14} />
				</SelectPrimitive.Icon>
			</SelectPrimitive.Trigger>
		);
		return title && !disabled ? <Tooltip label={title}>{trigger}</Tooltip> : trigger;
	},
);

type SelectContentProps = ComponentPropsWithoutRef<typeof SelectPrimitive.Content>;

export const SelectContent = forwardRef<ComponentRef<typeof SelectPrimitive.Content>, SelectContentProps>(
	function SelectContent({ className = "", children, collisionPadding = 8, position = "popper", sideOffset = 4, ...props }, ref) {
		return (
			<SelectPrimitive.Portal>
				<SelectPrimitive.Content
					ref={ref}
					className={`inno-popover-surface inno-ui-select-content${className ? ` ${className}` : ""}`}
					collisionPadding={collisionPadding}
					position={position}
					sideOffset={sideOffset}
					{...props}
				>
					<SelectPrimitive.ScrollUpButton className="inno-ui-select-scroll-button">
						<ChevronUp size={14} />
					</SelectPrimitive.ScrollUpButton>
					<SelectPrimitive.Viewport className="inno-ui-select-viewport">{children}</SelectPrimitive.Viewport>
					<SelectPrimitive.ScrollDownButton className="inno-ui-select-scroll-button">
						<ChevronDown size={14} />
					</SelectPrimitive.ScrollDownButton>
				</SelectPrimitive.Content>
			</SelectPrimitive.Portal>
		);
	},
);

type SelectItemProps = ComponentPropsWithoutRef<typeof SelectPrimitive.Item>;

export const SelectItem = forwardRef<ComponentRef<typeof SelectPrimitive.Item>, SelectItemProps>(
	function SelectItem({ className = "", children, title, disabled, ...props }, ref) {
		const item = (
			<SelectPrimitive.Item ref={ref} className={`inno-ui-select-item${className ? ` ${className}` : ""}`} disabled={disabled} title={disabled ? title : undefined} {...props}>
				{children}
				<SelectPrimitive.ItemIndicator className="inno-ui-select-indicator" aria-hidden="true">
					<Check size={14} />
				</SelectPrimitive.ItemIndicator>
			</SelectPrimitive.Item>
		);
		return title && !disabled ? <Tooltip label={title}>{item}</Tooltip> : item;
	},
);

type SelectOptionProps = Omit<SelectItemProps, "children"> & {
	icon?: ReactNode;
	label: ReactNode;
};

/** Complete single-line option for the standard Select component. */
export function SelectOption({ icon, label, ...props }: SelectOptionProps) {
	return (
		<SelectItem {...props}>
			{icon ? <span className="inno-ui-select-option-icon" aria-hidden="true">{icon}</span> : null}
			<SelectPrimitive.ItemText>{label}</SelectPrimitive.ItemText>
		</SelectItem>
	);
}

type SelectLabelProps = ComponentPropsWithoutRef<typeof SelectPrimitive.Label>;

export const SelectLabel = forwardRef<ComponentRef<typeof SelectPrimitive.Label>, SelectLabelProps>(
	function SelectLabel({ className = "", ...props }, ref) {
		return <SelectPrimitive.Label ref={ref} className={`inno-ui-select-label${className ? ` ${className}` : ""}`} {...props} />;
	},
);

type SelectSeparatorProps = ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>;

export const SelectSeparator = forwardRef<ComponentRef<typeof SelectPrimitive.Separator>, SelectSeparatorProps>(
	function SelectSeparator({ className = "", ...props }, ref) {
		return <SelectPrimitive.Separator ref={ref} className={`inno-ui-menu-separator${className ? ` ${className}` : ""}`} {...props} />;
	},
);
