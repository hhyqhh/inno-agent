import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";

export type InputSize = "sm" | "md";
export type InputVariant = "default" | "bare";

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
	size?: InputSize;
	variant?: InputVariant;
	hasLeadingAdornment?: boolean;
	hasTrailingAdornment?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ size = "md", variant = "default", hasLeadingAdornment = false, hasTrailingAdornment = false, className = "", ...props }, ref) {
	const adornmentClasses = `${hasLeadingAdornment ? " inno-ui-input--has-leading-adornment" : ""}${hasTrailingAdornment ? " inno-ui-input--has-trailing-adornment" : ""}`;
	return <input ref={ref} className={`inno-ui-input inno-ui-input--${size}${variant === "bare" ? " inno-ui-input--bare" : ""}${adornmentClasses}${className ? ` ${className}` : ""}`} {...props} />;
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ className = "", ...props }, ref) {
	return <textarea ref={ref} className={`inno-ui-textarea${className ? ` ${className}` : ""}`} {...props} />;
});

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox({ className = "", ...props }, ref) {
	return <input ref={ref} type="checkbox" className={`inno-ui-checkbox${className ? ` ${className}` : ""}`} {...props} />;
});

export interface RadioProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {}

export const Radio = forwardRef<HTMLInputElement, RadioProps>(function Radio({ className = "", ...props }, ref) {
	return <input ref={ref} type="radio" className={`inno-ui-radio${className ? ` ${className}` : ""}`} {...props} />;
});
