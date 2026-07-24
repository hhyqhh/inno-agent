/**
 * Shared input className — routes border/bg/text/focus through --inno-* theme
 * vars so inputs render correctly under all 4 themes. Focus ring uses
 * --inno-ring (a box-shadow) via `shadow-` not `ring-`, and `focus-visible:`
 * so it doesn't fire on mouse click.
 */
export const inputCls =
	"h-8 w-full rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2.5 text-xs text-[var(--inno-text)] placeholder:text-[var(--inno-text-subtle)] transition-colors focus-visible:border-[var(--inno-focus-border)] focus-visible:outline-none focus-visible:shadow-[var(--inno-ring)]";

/** Textarea variant — same base, grows vertically. */
export const textareaCls =
	"w-full rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2.5 py-1.5 text-xs text-[var(--inno-text)] placeholder:text-[var(--inno-text-subtle)] transition-colors focus-visible:border-[var(--inno-focus-border)] focus-visible:outline-none focus-visible:shadow-[var(--inno-ring)]";
