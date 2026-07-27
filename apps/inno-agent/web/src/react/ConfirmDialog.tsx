import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, X } from "lucide-react";
import { motion } from "motion/react";

interface ConfirmDialogProps {
	open: boolean;
	title: string;
	description: string;
	confirmLabel: string;
	cancelLabel: string;
	busy?: boolean;
	onConfirm(): void;
	onCancel(): void;
}

export function ConfirmDialog({
	open,
	title,
	description,
	confirmLabel,
	cancelLabel,
	busy = false,
	onConfirm,
	onCancel,
}: ConfirmDialogProps) {
	const cancelButtonRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		if (!open) return;
		cancelButtonRef.current?.focus();
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || busy) return;
			event.preventDefault();
			onCancel();
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [busy, onCancel, open]);

	if (!open || typeof document === "undefined") return null;

	return createPortal(
		<motion.div
			className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 p-4"
			initial={{ opacity: 0 }}
			animate={{ opacity: 1 }}
			transition={{ duration: 0.15 }}
			onMouseDown={(event) => {
				if (event.target === event.currentTarget && !busy) onCancel();
			}}
		>
			<motion.div
				role="alertdialog"
				aria-modal="true"
				aria-labelledby="confirm-dialog-title"
				aria-describedby="confirm-dialog-description"
				className="w-full max-w-sm rounded-xl border border-[var(--inno-border)] bg-[var(--inno-surface)] p-5 shadow-2xl"
				initial={{ opacity: 0, scale: 0.96, y: 8 }}
				animate={{ opacity: 1, scale: 1, y: 0 }}
				transition={{ duration: 0.18, ease: "easeOut" }}
			>
				<div className="flex items-start gap-3">
					<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-600">
						<AlertTriangle size={18} />
					</div>
					<div className="min-w-0 flex-1">
						<h2 id="confirm-dialog-title" className="text-base font-semibold text-[var(--inno-text)]">
							{title}
						</h2>
						<p id="confirm-dialog-description" className="mt-1.5 text-sm leading-6 text-[var(--inno-text-muted)]">
							{description}
						</p>
					</div>
					<button
						type="button"
						className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--inno-text-subtle)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)] disabled:opacity-50"
						disabled={busy}
						onClick={onCancel}
						aria-label={cancelLabel}
					>
						<X size={16} />
					</button>
				</div>

				<div className="mt-5 flex justify-end gap-2">
					<button
						ref={cancelButtonRef}
						type="button"
						className="rounded-md border border-[var(--inno-border)] px-3.5 py-1.5 text-sm text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)] disabled:opacity-50"
						disabled={busy}
						onClick={onCancel}
					>
						{cancelLabel}
					</button>
					<button
						type="button"
						className="rounded-md bg-red-600 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
						disabled={busy}
						onClick={onConfirm}
					>
						{confirmLabel}
					</button>
				</div>
			</motion.div>
		</motion.div>,
		document.body,
	);
}
