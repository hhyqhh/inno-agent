import { CheckCircle2, LoaderCircle, Mic, MicOff, Square, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { meetingStore } from "../../stores/meeting-store.js";
import { useStoreSnapshot } from "../hooks.js";

function formatDuration(seconds: number): string {
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

export function MeetingRecorder() {
	const { t } = useTranslation();
	const state = useStoreSnapshot(meetingStore, () => ({
		status: meetingStore.state,
	}));

	return (
		<button
			type="button"
			className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[var(--inno-border)] text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)] disabled:opacity-50"
			disabled={state.status === "connecting" || state.status === "recording" || state.status === "summarizing"}
			onClick={() => void meetingStore.start()}
			title={t("notes.meeting.start")}
			aria-label={t("notes.meeting.start")}
		>
			{state.status === "connecting" ? <LoaderCircle size={13} className="animate-spin" /> : <Mic size={13} />}
		</button>
	);
}

export function MeetingProgress({ rawPath }: { rawPath: string }) {
	const { t } = useTranslation();
	const state = useStoreSnapshot(meetingStore, () => ({
		status: meetingStore.state,
		rawPath: meetingStore.rawPath,
		elapsedSeconds: meetingStore.elapsedSeconds,
		partialText: meetingStore.partialText,
		lastFinalText: meetingStore.lastFinalText,
		error: meetingStore.error,
	}));

	if (state.status === "idle" || state.rawPath !== rawPath) return null;

	return (
		<div className="border-b border-[var(--inno-border)] bg-[var(--inno-surface-muted)] px-4 py-3">
			<div className="rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] p-3">
				<div className="flex items-start justify-between gap-3">
					<div className="flex min-w-0 items-center gap-2">
						{state.status === "recording" ? <span className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-red-500" /> : null}
						{state.status === "connecting" || state.status === "summarizing" ? <LoaderCircle size={17} className="shrink-0 animate-spin text-[var(--inno-accent)]" /> : null}
						{state.status === "completed" ? <CheckCircle2 size={17} className="shrink-0 text-emerald-600" /> : null}
						{state.status === "no_speech" ? <MicOff size={17} className="shrink-0 text-[var(--inno-text-muted)]" /> : null}
						<div className="min-w-0">
							<div className="font-medium text-[var(--inno-text)]">{t(`notes.meeting.${state.status}`)}</div>
							{state.status === "recording" ? <div className="text-xs tabular-nums text-[var(--inno-text-muted)]">{formatDuration(state.elapsedSeconds)}</div> : null}
						</div>
					</div>
					{state.status === "completed" || state.status === "no_speech" || state.status === "error" ? (
						<button className="rounded p-1 text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)]" onClick={() => meetingStore.dismiss()}><X size={15} /></button>
					) : null}
				</div>
				{state.status === "summarizing" ? <p className="mt-3 text-sm text-[var(--inno-text-muted)]">{t("notes.meeting.summarizingHint")}</p> : null}
				{state.status === "recording" && (state.partialText || state.lastFinalText) ? (
					<p className="mt-3 line-clamp-3 rounded-md bg-[var(--inno-surface-muted)] p-2 text-sm text-[var(--inno-text-muted)]">{state.partialText || state.lastFinalText}</p>
				) : null}
				{state.status === "error" ? <p className="mt-3 text-sm text-red-600">{state.error}</p> : null}
				{state.status === "recording" ? (
					<button className="mt-3 inline-flex items-center justify-center gap-2 rounded-md bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700" onClick={() => meetingStore.stop()}>
						<Square size={13} fill="currentColor" />{t("notes.meeting.stop")}
					</button>
				) : null}
			</div>
		</div>
	);
}
