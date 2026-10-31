import { useReducedMotion, type Transition } from "motion/react";

// Match app.css's UI/modal durations and --inno-ease-in-out. CSS media rules
// cannot stop JS height/rotation animations, so resolve the preference here.
// Workbench layout projections share the sidebar grid's easing. Mixing this
// with the modal curve makes nested tabs and the new-tab button reverse course.
export function useUITransition(kind: "ui" | "modal" | "layout" = "ui"): Transition {
	const reduced = useReducedMotion();
	return { duration: reduced ? 0 : kind === "ui" ? 0.16 : 0.22, ease: kind === "layout" ? [0.4, 0, 0.2, 1] : [0.77, 0, 0.175, 1] };
}
