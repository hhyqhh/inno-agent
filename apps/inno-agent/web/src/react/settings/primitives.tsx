import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";

/**
 * Shared layout primitives for the settings overlay. Each settings category
 * page composes:
 *   SettingsSection (page header)
 *     > SettingsGroup (optional sub-group title)
 *       > SettingsCard / SettingsCollapsibleCard
 *         > SettingsRow (label/description/hint left, control right)
 */

export function SettingsSection({ title, description, action, children }: {
	title: ReactNode;
	description?: string;
	action?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section className="pb-6">
			<div className={`flex flex-wrap items-start justify-between gap-3 ${action ? "pr-10 max-md:pr-0" : ""}`}>
				<div className="min-w-0">
					<h2 className="text-lg font-semibold tracking-tight text-[var(--inno-text)]">{title}</h2>
					{description ? <p className="mt-1 text-xs leading-relaxed text-[var(--inno-text-subtle)]">{description}</p> : null}
				</div>
				{action ? <div className="shrink-0">{action}</div> : null}
			</div>
			<div className="mt-5 grid gap-5">{children}</div>
		</section>
	);
}

export function SettingsGroup({ title, description, action, children }: {
	title?: ReactNode;
	description?: string;
	action?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="grid gap-2.5">
			{title || action ? (
				<div className="flex flex-wrap items-end justify-between gap-2 px-0.5">
					<div className="min-w-0">
						{title ? (
							<h3 className="text-xs font-semibold tracking-wide text-[var(--inno-text-muted)]">
								{title}
							</h3>
						) : null}
						{description ? (
							<p className="mt-0.5 text-xs text-[var(--inno-text-subtle)]">{description}</p>
						) : null}
					</div>
					{action ? <div className="shrink-0">{action}</div> : null}
				</div>
			) : null}
			<div className="grid gap-3">{children}</div>
		</div>
	);
}

export function SettingsCard({ children, divided = false, className = "" }: {
	children: ReactNode;
	divided?: boolean;
	className?: string;
}) {
	return (
		<div className={`rounded-xl border border-[var(--inno-border)] bg-[var(--inno-card-bg)] ${divided ? "divide-y divide-[var(--inno-border)] *:px-4 *:py-3.5" : "p-4"} ${className}`}>
			{children}
		</div>
	);
}

export function SettingsRow({ label, description, hint, hintTone = "muted", control, disabled }: {
	label: ReactNode;
	description?: string;
	hint?: ReactNode;
	hintTone?: "muted" | "warning" | "danger";
	control: ReactNode;
	disabled?: boolean;
}) {
	const hintColor = hintTone === "warning"
		? "text-[var(--inno-warning)]"
		: hintTone === "danger"
			? "text-[var(--inno-danger)]"
			: "text-[var(--inno-text-muted)]";

	return (
		<div className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 ${disabled ? "opacity-60" : ""}`}>
			<div className="min-w-0 flex-[1_1_200px]">
				<h4 className="text-sm font-medium text-[var(--inno-text)]">{label}</h4>
				{description ? <p className="mt-0.5 text-xs leading-relaxed text-[var(--inno-text-subtle)]">{description}</p> : null}
				{hint ? <p className={`mt-1 text-xs leading-relaxed ${hintColor}`}>{hint}</p> : null}
			</div>
			<div className="ml-auto max-w-full shrink-0">{control}</div>
		</div>
	);
}

export type SettingsBadgeTone = "success" | "accent" | "warning" | "danger" | "neutral";

const BADGE_STYLES: Record<SettingsBadgeTone, string> = {
	success: "bg-[var(--inno-success-bg)] text-[var(--inno-success)]",
	accent: "bg-[var(--inno-accent-soft)] text-[var(--inno-accent)]",
	warning: "bg-[var(--inno-warning-bg,var(--inno-surface-muted))] text-[var(--inno-warning)]",
	danger: "bg-[var(--inno-danger-bg)] text-[var(--inno-danger)]",
	neutral: "bg-[var(--inno-surface-muted)] text-[var(--inno-text-subtle)]",
};

export function SettingsStatusBadge({ tone = "neutral", dot = false, children }: {
	tone?: SettingsBadgeTone;
	dot?: boolean;
	children: ReactNode;
}) {
	return (
		<span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${BADGE_STYLES[tone]}`}>
			{dot ? <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" /> : null}
			{children}
		</span>
	);
}

export function SettingsCollapsibleCard({
	icon,
	title,
	description,
	summary,
	badge,
	open,
	onToggle,
	children,
}: {
	icon: ReactNode;
	title: ReactNode;
	description?: string;
	summary?: ReactNode;
	badge?: ReactNode;
	open: boolean;
	onToggle: () => void;
	children: ReactNode;
}) {
	return (
		<SettingsCard className="min-w-0 overflow-hidden p-0">
			<button
				type="button"
				aria-expanded={open}
				className="inno-settings-card-toggle flex w-full min-w-0 items-start gap-3 px-4 py-3.5 text-left transition-colors hover:bg-[var(--inno-surface-muted)]/45"
				onClick={onToggle}
			>
				<span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--inno-surface-muted)] text-[var(--inno-text)]">
					{icon}
				</span>
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-2">
						<h4 className="break-words text-sm font-medium text-[var(--inno-text)]">{title}</h4>
						{badge}
					</div>
					{description ? (
						<p className="mt-1 max-w-full break-words text-xs leading-relaxed text-[var(--inno-text-muted)]">
							{description}
						</p>
					) : null}
					{!open && summary ? (
						<p className="mt-1.5 break-all font-mono text-xs leading-relaxed text-[var(--inno-text-subtle)]">
							{summary}
						</p>
					) : null}
				</div>
				<ChevronDown
					size={15}
					className={`mt-1.5 shrink-0 text-[var(--inno-text-subtle)] transition-transform duration-150 ${open ? "rotate-180" : ""}`}
				/>
			</button>

			{open ? (
				<div className="border-t border-[var(--inno-border)] bg-[var(--inno-surface-muted)]/25 px-4 py-3.5">
					{children}
				</div>
			) : null}
		</SettingsCard>
	);
}
