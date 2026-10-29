import * as SeparatorPrimitive from "@radix-ui/react-separator";
import { forwardRef, type ComponentPropsWithoutRef, type ComponentRef } from "react";

type SeparatorProps = ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root>;

export const Separator = forwardRef<ComponentRef<typeof SeparatorPrimitive.Root>, SeparatorProps>(
	function Separator({ className = "", decorative = true, orientation = "horizontal", ...props }, ref) {
		return (
			<SeparatorPrimitive.Root
				ref={ref}
				decorative={decorative}
				orientation={orientation}
				className={`inno-ui-separator${className ? ` ${className}` : ""}`}
				{...props}
			/>
		);
	},
);
