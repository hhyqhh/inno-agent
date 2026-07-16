interface SwitchProps {
	checked: boolean;
	onChange: (value: boolean) => void;
	disabled?: boolean;
	"aria-label"?: string;
	className?: string;
}

/**
 * Controlled toggle switch. Routes through --inno-* theme vars so the innospark theme
 * render correctly (the old inline version used a hardcoded slate color for OFF).
 * Press feedback uses scale(0.97) + custom ease-out per Emil's principles.
 */
export function Switch({ checked, onChange, disabled, "aria-label": ariaLabel, className = "" }: SwitchProps) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={ariaLabel}
			disabled={disabled}
			onClick={() => onChange(!checked)}
			className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 active:scale-[0.97] ${
				checked ? "bg-[var(--inno-accent)]" : "bg-[var(--inno-border-strong)]"
			} ${className}`}
			style={{ transitionTimingFunction: "var(--inno-ease-out)", transitionDuration: "var(--inno-dur-ui)" }}
		>
			<span
				className={`inline-block h-3.5 w-3.5 transform rounded-full bg-[var(--inno-surface)] transition-transform ${checked ? "translate-x-[18px]" : "translate-x-1"}`}
				style={{ transitionTimingFunction: "var(--inno-ease-out)", transitionDuration: "var(--inno-dur-ui)" }}
			/>
		</button>
	);
}
