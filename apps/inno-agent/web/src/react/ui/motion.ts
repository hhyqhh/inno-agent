import { useReducedMotion, type Transition } from "motion/react";

// Match app.css's UI/modal durations and --inno-ease-in-out. CSS media rules
// cannot stop JS height/rotation animations, so resolve the preference here.
export function useUITransition(kind: "ui" | "modal" = "ui"): Transition {
	const reduced = useReducedMotion();
	return { duration: reduced ? 0 : kind === "modal" ? 0.22 : 0.16, ease: [0.77, 0, 0.175, 1] };
}
