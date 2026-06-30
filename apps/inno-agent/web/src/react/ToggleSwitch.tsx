import React from "react";

export interface ToggleSwitchProps {
	checked: boolean;
	onChange: (checked: boolean) => void;
	disabled?: boolean;
}

/**
 * A standard toggle switch button matching the design-system pattern:
 * <button role="switch"> with animated knob.
 * Use this instead of native <input type="checkbox"> for feature toggles.
 */
export default function ToggleSwitch({ checked, onChange, disabled }: ToggleSwitchProps) {
	return (
		<button
			role="switch"
			aria-checked={checked}
			disabled={disabled}
			onClick={() => onChange(!checked)}
			className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${checked ? "bg-[var(--inno-accent)]" : "bg-slate-300"}`}
		>
			<span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-[var(--inno-surface)] transition-transform ${checked ? "translate-x-[18px]" : "translate-x-1"}`} />
		</button>
	);
}
