import * as PopoverPrimitive from "@radix-ui/react-popover";
import { forwardRef, type ComponentPropsWithoutRef, type ComponentRef } from "react";
import { Tooltip } from "./Tooltip.js";

export const Popover = PopoverPrimitive.Root;
export const PopoverAnchor = PopoverPrimitive.Anchor;
export const PopoverClose = PopoverPrimitive.Close;

type PopoverTriggerProps = ComponentPropsWithoutRef<typeof PopoverPrimitive.Trigger>;

export const PopoverTrigger = forwardRef<ComponentRef<typeof PopoverPrimitive.Trigger>, PopoverTriggerProps>(
	function PopoverTrigger({ title, disabled, ...props }, ref) {
		const trigger = <PopoverPrimitive.Trigger ref={ref} disabled={disabled} title={disabled ? title : undefined} {...props} />;
		return title && !disabled ? <Tooltip label={title}>{trigger}</Tooltip> : trigger;
	},
);

type PopoverContentProps = ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>;

export const PopoverContent = forwardRef<ComponentRef<typeof PopoverPrimitive.Content>, PopoverContentProps>(
	function PopoverContent({ className = "", collisionPadding = 8, sideOffset = 8, ...props }, ref) {
		return (
			<PopoverPrimitive.Portal>
				<PopoverPrimitive.Content
					ref={ref}
					className={`inno-popover-surface inno-ui-popover-content${className ? ` ${className}` : ""}`}
					collisionPadding={collisionPadding}
					sideOffset={sideOffset}
					{...props}
				/>
			</PopoverPrimitive.Portal>
		);
	},
);
