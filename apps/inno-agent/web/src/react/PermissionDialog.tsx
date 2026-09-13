import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { motion } from "motion/react";
import { ShieldAlert, Terminal, FileText, Wrench, Puzzle } from "lucide-react";
import type { PendingPermission, PermissionDecisionKind } from "../types/chat.js";
import { chatStore } from "../stores/chat-store.js";

function surfaceIcon(pending: PendingPermission) {
	if (pending.command) return <Terminal size={14} aria-hidden="true" />;
	if (pending.path) return <FileText size={14} aria-hidden="true" />;
	if (pending.source === "skill_input" || pending.source === "skill_read") return <Puzzle size={14} aria-hidden="true" />;
	return <Wrench size={14} aria-hidden="true" />;
}

/** Approval card for a parked pi-permission-system `ask`. The agent loop is
 *  blocked until the user picks one of the three decisions; every dismissal
 *  path on the server (timeout, abort, turn end) resolves to a deny. */
export function PermissionDialog({ pending }: { pending: PendingPermission }) {
	const { t } = useTranslation();
	const [submitting, setSubmitting] = useState<PermissionDecisionKind | null>(null);
	// Keep the card from shrinking between decisions so the viewport does not
	// shift mid-interaction (same watermark mechanism as QuestionDialog).
	const heightWatermarkRef = useRef(0);
	const cardObserverRef = useRef<ResizeObserver | null>(null);
	const cardRef = useCallback((el: HTMLDivElement | null) => {
		cardObserverRef.current?.disconnect();
		cardObserverRef.current = null;
		if (!el) return;
		heightWatermarkRef.current = 0;
		el.style.minHeight = "";
		const observer = new ResizeObserver(() => {
			const height = el.offsetHeight;
			if (height > heightWatermarkRef.current) heightWatermarkRef.current = height;
			const minHeight = `${heightWatermarkRef.current}px`;
			if (el.style.minHeight !== minHeight) el.style.minHeight = minHeight;
		});
		observer.observe(el);
		cardObserverRef.current = observer;
	}, []);

	const decide = useCallback(
		(decision: PermissionDecisionKind) => {
			if (submitting) return;
			setSubmitting(decision);
			void chatStore.submitPermissionResponse(pending.requestId, decision);
		},
		[pending.requestId, submitting],
	);

	const displayValue = pending.command ?? pending.path ?? pending.value ?? pending.toolName ?? "";
	const surfaceLabel = pending.command
		? "bash"
		: (pending.surface ?? pending.toolName ?? pending.source);

	return (
		<motion.div
			className="flex justify-start"
			initial={{ opacity: 0, y: 16 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{ duration: 0.3, ease: "easeOut" }}
		>
			<div ref={cardRef} className="w-full max-w-[36.5rem] rounded-lg border border-[var(--inno-warning-border,var(--inno-accent-soft))] bg-[var(--inno-surface)] px-4 py-3 shadow-sm">
				<div className="mb-2 flex items-center gap-2 text-sm font-medium text-[var(--inno-text)]">
					<ShieldAlert size={16} className="text-[var(--inno-warning,var(--inno-accent))]" aria-hidden="true" />
					<span>{t("permission.title")}</span>
					{pending.forwardedFrom ? (
						<span className="rounded bg-[var(--inno-surface-muted)] px-1.5 py-0.5 text-[11px] text-[var(--inno-text-muted)]">
							{t("permission.fromSubagent", { name: pending.forwardedFrom })}
						</span>
					) : null}
				</div>

				<div className="flex items-center gap-1.5 text-xs text-[var(--inno-text-muted)]">
					{surfaceIcon(pending)}
					<span className="font-mono">{surfaceLabel}</span>
				</div>

				{displayValue ? (
					<pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] px-2.5 py-1.5 font-mono text-xs text-[var(--inno-text)]">{displayValue}</pre>
				) : null}

				<div className="mt-3 flex items-center justify-end gap-2">
					<button
						className="rounded-lg px-3 py-1.5 text-sm font-medium text-[var(--inno-text-muted)] transition-colors hover:bg-[var(--inno-surface-muted)]"
						disabled={submitting !== null}
						onClick={() => decide("deny")}
					>
						{t("permission.deny")}
					</button>
					<button
						className="rounded-lg border border-[var(--inno-border)] px-3 py-1.5 text-sm font-medium text-[var(--inno-text)] transition-colors hover:bg-[var(--inno-surface-muted)]"
						disabled={submitting !== null}
						onClick={() => decide("allow_session")}
					>
						{t("permission.allowSession")}
					</button>
					<button
						className="inno-primary-button rounded-lg px-4 py-1.5 text-sm font-medium transition-colors"
						disabled={submitting !== null}
						onClick={() => decide("allow_once")}
					>
						{t("permission.allowOnce")}
					</button>
				</div>
			</div>
		</motion.div>
	);
}
