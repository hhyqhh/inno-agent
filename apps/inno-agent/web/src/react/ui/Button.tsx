import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Tooltip } from "./Tooltip.js";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "compact" | "xs" | "sm" | "md";
export type ButtonShape = "default" | "pill";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	variant?: ButtonVariant;
	size?: ButtonSize;
	shape?: ButtonShape;
}

const variantClasses: Record<ButtonVariant, string> = {
	primary: "inno-primary-button",
	secondary: "inno-secondary-button",
	ghost: "inno-ghost-button",
	danger: "inno-danger-button",
};

/** Standard action button. Product behavior and icon/text content stay with the caller. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
	{ variant = "secondary", size = "sm", shape = "default", type = "button", className = "", title, ...props },
	ref,
) {
	const disabled = Boolean(props.disabled || props["aria-disabled"] === true || props["aria-disabled"] === "true");
	const button = (
		<button
			ref={ref}
			type={type}
			className={`inno-ui-button inno-ui-button--${size}${shape === "pill" ? " inno-ui-button--pill" : ""} ${variantClasses[variant]}${className ? ` ${className}` : ""}`}
			title={disabled ? title : undefined}
			{...props}
		/>
	);
	return title && !disabled ? <Tooltip label={title}>{button}</Tooltip> : button;
});

export interface IconButtonProps extends Omit<ButtonProps, "children"> {
	"aria-label": string;
	children: ReactNode;
}

/** Icon action button with a required accessible name and optional pill shape. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
	{ variant = "ghost", size = "sm", shape = "default", className = "", ...props },
	ref,
) {
	return (
		<Button
			ref={ref}
			variant={variant}
			size={size}
			shape={shape}
			className={`inno-ui-icon-button${className ? ` ${className}` : ""}`}
			{...props}
		/>
	);
});
