import { useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Shared modal dialog; Escape and backdrop clicks report through onClose.
 * With `scoped` the dialog renders in place instead of the body top layer, so
 * CSS positions it inside the surrounding panel (e.g. the workspace preview
 * pane) and the mask covers only that panel.
 */
export function Dialog({ children, label, className, onClose, scoped = false }: {
	children: ReactNode;
	label: string;
	className?: string;
	/** Render in place and confine the modal to the surrounding panel. */
	scoped?: boolean;
	onClose: () => void;
}) {
	const ref = useRef<HTMLDialogElement>(null);
	const close = useRef(onClose);
	close.current = onClose;
	useLayoutEffect(() => {
		const dialog = ref.current;
		if (!dialog) return;
		if (!scoped) {
			dialog.showModal();
			return () => { if (dialog.open) dialog.close(); };
		}
		// Mirror showModal() modality inside the panel: everything outside this
		// dialog except its own ancestors becomes inert, focus moves in on open
		// and returns to the trigger on close. show() keeps the dialog in the
		// ancestor's coordinate space, which is what lets CSS center it there.
		const previousFocus = document.activeElement;
		const inertNodes: Array<[HTMLElement, boolean]> = [];
		const isolate = (parent: Element) => {
			for (const node of parent.children) {
				if (!(node instanceof HTMLElement) || node === dialog) continue;
				if (node.contains(dialog)) { isolate(node); continue; }
				inertNodes.push([node, node.inert]);
				node.inert = true;
			}
		};
		isolate(document.body);
		dialog.show();
		const focusTarget = dialog.querySelector<HTMLElement>("[autofocus], button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
		(focusTarget ?? dialog).focus();
		const escape = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !event.defaultPrevented && !Array.from(document.querySelectorAll("dialog[open]")).some((node) => node !== dialog && !node.contains(dialog))) {
				event.preventDefault(); close.current();
			}
		};
		window.addEventListener("keydown", escape);
		return () => {
			window.removeEventListener("keydown", escape);
			if (dialog.open) dialog.close();
			inertNodes.forEach(([node, inert]) => { node.inert = inert; });
			if (previousFocus instanceof HTMLElement) previousFocus.focus();
		};
	}, [scoped]);
	const dialogElement = <dialog ref={ref} aria-label={label} aria-modal={true} tabIndex={-1} className={className}
		onCancel={(event) => { event.preventDefault(); onClose(); }}
		onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
		{children}
	</dialog>;
	return scoped ? dialogElement : createPortal(dialogElement, document.body);
}
