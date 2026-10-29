/**
 * Shared input className — routes border/bg/text/focus through --inno-* theme
 * vars so inputs render correctly under all 4 themes. Focus ring uses
 * --inno-ring (a box-shadow) via `shadow-` not `ring-`, and `focus-visible:`
 * so it doesn't fire on mouse click.
 */
export const inputCls = "inno-ui-input";

/** Textarea variant — same base, grows vertically. */
export const textareaCls = "inno-ui-textarea";
