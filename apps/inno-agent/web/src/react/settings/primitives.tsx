import type { ReactNode } from "react";

/**
 * Shared layout primitives for the settings overlay. Each settings category
 * page composes SettingsSection (titled group) > SettingsCard (rounded panel)
 * > SettingsRow (label/description left, control right).
 */

export function SettingsSection({ title, description, children }: {
	title: ReactNode;
	description?: string;
	children: ReactNode;
}) {
	return (
		<section className="mb-8">
			<h2 className="text-base font-semibold text-[var(--inno-text)]">{title}</h2>
			{description ? <p className="mt-1 text-sm text-[var(--inno-text-muted)]">{description}</p> : null}
			<div className="mt-4 grid gap-3">{children}</div>
		</section>
	);
}

export function SettingsCard({ children, className = "" }: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<div className={`rounded-lg bg-[var(--inno-surface)] p-4 ${className}`}>{children}</div>
	);
}

export function SettingsRow({ label, description, control, disabled }: {
	label: ReactNode;
	description?: string;
	control: ReactNode;
	disabled?: boolean;
}) {
	return (
		<div className={`flex items-start justify-between gap-3 ${disabled ? "opacity-60" : ""}`}>
			<div className="min-w-0">
				<h4 className="text-sm font-medium text-[var(--inno-text)]">{label}</h4>
				{description ? <p className="mt-1 text-sm text-[var(--inno-text-muted)]">{description}</p> : null}
			</div>
			{control}
		</div>
	);
}
