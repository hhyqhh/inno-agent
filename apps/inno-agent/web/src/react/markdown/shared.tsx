import { type ReactNode, useEffect, useRef } from "react";

/** Shared icon-button for the markdown toolbars (code blocks, tables,
 * artifacts) so styling and a11y fixes land in one place. */
export function ToolbarIconButton({
	label,
	active = false,
	disabled = false,
	onClick,
	children,
}: {
	label: string;
	active?: boolean;
	disabled?: boolean;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			disabled={disabled}
			onClick={onClick}
			className={`inline-flex size-6 items-center justify-center rounded-md border-0 transition-colors ${active ? "bg-[var(--inno-accent-soft)] text-[var(--inno-accent)]" : "text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface)] hover:text-[var(--inno-text)]"} disabled:cursor-not-allowed disabled:opacity-40`}
		>
			{children}
		</button>
	);
}

/** Single blob-download primitive for every markdown toolbar. */
export function downloadBlob(filename: string, blob: Blob): void {
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
	setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Escape-to-close + body scroll lock shared by the fullscreen overlays. */
export function useFullscreenDialog(open: boolean, onClose: () => void): void {
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	useEffect(() => {
		if (!open) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") onCloseRef.current();
		};
		document.addEventListener("keydown", onKeyDown);
		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => {
			document.removeEventListener("keydown", onKeyDown);
			document.body.style.overflow = previousOverflow;
		};
	}, [open]);
}
