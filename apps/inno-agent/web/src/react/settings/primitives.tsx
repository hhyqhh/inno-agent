import type { ReactNode } from "react";

/**
 * Shared layout primitives for the settings overlay. Each settings category
 * page composes SettingsSection (titled group) > SettingsCard (rounded panel)
 * > SettingsRow (label/description left, control right).
 */

export function SettingsSection({ title, description, action, children }: {
	title: ReactNode;
	description?: string;
	action?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section className="mb-8">
			<div className={`flex flex-wrap items-start justify-between gap-3 ${action ? "pr-9 max-md:pr-0" : ""}`}>
				<div className="min-w-0">
					<h2 className="text-lg font-semibold tracking-tight text-[var(--inno-text)]">{title}</h2>
					{description ? <p className="mt-1 text-xs text-[var(--inno-text-subtle)]">{description}</p> : null}
				</div>
				{action ? <div className="shrink-0">{action}</div> : null}
			</div>
			<div className="mt-5 grid gap-3.5">{children}</div>
		</section>
	);
}

export function SettingsCard({ children, className = "" }: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<div className={`rounded-xl border border-[var(--inno-border)] bg-[var(--inno-card-bg)] px-4 py-4 ${className}`}>{children}</div>
	);
}

export function SettingsRow({ label, description, control, disabled }: {
	label: ReactNode;
	description?: string;
	control: ReactNode;
	disabled?: boolean;
}) {
	return (
		<div className={`flex flex-wrap items-start justify-between gap-3 ${disabled ? "opacity-60" : ""}`}>
			<div className="min-w-0 flex-[1_1_160px]">
				<h4 className="text-sm font-medium text-[var(--inno-text)]">{label}</h4>
				{description ? <p className="mt-0.5 text-xs text-[var(--inno-text-subtle)]">{description}</p> : null}
			</div>
			<div className="max-w-full shrink-0">{control}</div>
		</div>
	);
}
