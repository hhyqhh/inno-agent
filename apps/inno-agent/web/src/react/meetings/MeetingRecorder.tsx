import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, CheckCircle2, ChevronDown, LoaderCircle, Mic, MicOff, Pause, Play, RotateCcw, Square, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { meetingStore } from "../../stores/meeting-store.js";
import { useStoreSnapshot } from "../hooks.js";
import { meetingAudioUrl } from "../../api/meetings.js";

function formatDuration(seconds: number): string {
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

export function MeetingRecorder() {
	const { t } = useTranslation();
	const [setupOpen, setSetupOpen] = useState(false);
	const [deviceMenuOpen, setDeviceMenuOpen] = useState(false);
	const [popoverPosition, setPopoverPosition] = useState({ left: 12, top: 12 });
	const triggerRef = useRef<HTMLButtonElement>(null);
	const popoverRef = useRef<HTMLDivElement>(null);
	const state = useStoreSnapshot(meetingStore, () => ({
		status: meetingStore.state,
		devices: meetingStore.inputDevices,
		selectedDeviceId: meetingStore.selectedDeviceId,
		permissionState: meetingStore.permissionState,
	}));

	useEffect(() => { void meetingStore.recoverActive(); }, []);

	useLayoutEffect(() => {
		if (!setupOpen) return;
		const updatePosition = () => {
			const trigger = triggerRef.current?.getBoundingClientRect();
			if (!trigger) return;
			const width = 256;
			const height = popoverRef.current?.offsetHeight ?? 240;
			const left = Math.min(Math.max(12, trigger.right - width), window.innerWidth - width - 12);
			const below = trigger.bottom + 8;
			const top = below + height <= window.innerHeight - 12
				? below
				: Math.max(12, trigger.top - height - 8);
			setPopoverPosition({ left, top });
		};
		updatePosition();
		window.addEventListener("resize", updatePosition);
		window.addEventListener("scroll", updatePosition, true);
		return () => {
			window.removeEventListener("resize", updatePosition);
			window.removeEventListener("scroll", updatePosition, true);
		};
	}, [setupOpen, deviceMenuOpen, state.devices.length]);

	useEffect(() => {
		if (!setupOpen) return;
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Node;
			if (!popoverRef.current?.contains(target) && !triggerRef.current?.contains(target)) {
				setSetupOpen(false);
				setDeviceMenuOpen(false);
			}
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			if (deviceMenuOpen) setDeviceMenuOpen(false);
			else setSetupOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [setupOpen, deviceMenuOpen]);

	const selectedDevice = state.devices.find((device) => device.deviceId === state.selectedDeviceId);
	const selectedDeviceLabel = selectedDevice?.label
		|| (selectedDevice ? `麦克风 ${state.devices.indexOf(selectedDevice) + 1}` : "默认麦克风");
	const closeSetup = () => {
		setSetupOpen(false);
		setDeviceMenuOpen(false);
	};
	const setupPopover = setupOpen && state.status === "idle" && typeof document !== "undefined" ? createPortal(
		<div
			ref={popoverRef}
			className="fixed z-[2200] w-64 rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] p-2.5 text-left shadow-xl ring-1 ring-black/5"
			style={popoverPosition}
			role="dialog"
			aria-label="会议录音设置"
		>
			<div className="mb-2.5 flex items-center justify-between">
				<div className="flex items-center gap-1.5 text-xs font-medium text-[var(--inno-text)]"><Mic size={14} className="text-[var(--inno-accent)]" />会议录音</div>
				<button type="button" className="rounded-md p-1 text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]" onClick={closeSetup} aria-label="关闭"><X size={14} /></button>
			</div>
			<div className="text-[11px] text-[var(--inno-text-muted)]">输入设备</div>
			<div className="relative mt-1">
				<button
					type="button"
					className={`flex h-8 w-full items-center gap-1.5 rounded-md border bg-[var(--inno-background)] px-2 text-left text-[8px] leading-3 text-[var(--inno-text)] transition-colors hover:bg-[var(--inno-surface-muted)] ${deviceMenuOpen ? "border-[var(--inno-accent)] ring-2 ring-[var(--inno-accent-soft)]" : "border-[var(--inno-border)]"}`}
					onClick={() => setDeviceMenuOpen((open) => !open)}
					aria-haspopup="listbox"
					aria-expanded={deviceMenuOpen}
					title={selectedDeviceLabel}
				>
					<Mic size={14} className="shrink-0 text-[var(--inno-text-muted)]" />
					<span className="min-w-0 flex-1 truncate">{selectedDeviceLabel}</span>
					<ChevronDown size={14} className={`shrink-0 text-[var(--inno-text-muted)] transition-transform ${deviceMenuOpen ? "rotate-180" : ""}`} />
				</button>
				{deviceMenuOpen ? (
					<div className="absolute left-0 right-0 top-full z-10 mt-1 max-h-48 overflow-y-auto rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] p-1 shadow-xl" role="listbox">
						{state.devices.length === 0 ? (
							<button type="button" className="flex w-full items-center gap-2 rounded-md bg-[var(--inno-accent-soft)] px-2 py-1.5 text-left text-[8px] leading-3 text-[var(--inno-text)]" onClick={() => setDeviceMenuOpen(false)} role="option" aria-selected="true"><Check size={13} className="text-[var(--inno-accent)]" />默认麦克风</button>
						) : state.devices.map((device, index) => {
							const selected = device.deviceId === state.selectedDeviceId;
							const label = device.label || `麦克风 ${index + 1}`;
							return <button key={device.deviceId} type="button" className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[8px] leading-3 transition-colors ${selected ? "bg-[var(--inno-accent-soft)] text-[var(--inno-text)]" : "text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]"}`} onClick={() => { meetingStore.setSelectedDevice(device.deviceId); setDeviceMenuOpen(false); }} role="option" aria-selected={selected} title={label}><span className="flex w-3.5 shrink-0 justify-center">{selected ? <Check size={13} className="text-[var(--inno-accent)]" /> : null}</span><span className="truncate">{label}</span></button>;
						})}
					</div>
				) : null}
			</div>
			<p className="mt-2 text-[10px] text-[var(--inno-text-subtle)]">麦克风权限：{state.permissionState === "granted" ? "已允许" : state.permissionState === "denied" ? "已拒绝" : "将在开始时请求"}</p>
			<button className="mt-2.5 w-full rounded-md inno-primary-button px-3 py-1.5 text-xs text-white" onClick={() => { closeSetup(); void meetingStore.start(); }}>开始录音</button>
		</div>,
		document.body,
	) : null;

	return (
		<div className="relative h-8 w-8">
			<button
				ref={triggerRef}
				type="button"
				className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[var(--inno-border)] text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)] disabled:opacity-50"
				disabled={["connecting", "recording", "paused", "finishing", "importing", "summarizing"].includes(state.status)}
				onClick={() => { if (state.status !== "idle") meetingStore.dismiss(); setSetupOpen((open) => !open); setDeviceMenuOpen(false); void meetingStore.refreshDevices(); }}
				title={t("notes.meeting.start")}
				aria-label={t("notes.meeting.start")}
			>
				{state.status === "connecting" ? <LoaderCircle size={13} className="animate-spin" /> : <Mic size={13} />}
			</button>
			{setupPopover}
		</div>
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
		meetingId: meetingStore.meetingId,
		inputLevel: meetingStore.inputLevel,
		audioAvailable: meetingStore.audioAvailable,
		importJob: meetingStore.importJob,
	}));

	if (state.status === "idle" || state.rawPath !== rawPath) return null;

	return (
		<div className="border-b border-[var(--inno-border)] bg-[var(--inno-surface-muted)] px-4 py-3">
			<div className="rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] p-3">
				<div className="flex items-start justify-between gap-3">
					<div className="flex min-w-0 items-center gap-2">
						{state.status === "recording" ? <span className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-red-500" /> : null}
						{state.status === "connecting" || state.status === "finishing" || state.status === "importing" || state.status === "summarizing" ? <LoaderCircle size={17} className="shrink-0 animate-spin text-[var(--inno-accent)]" /> : null}
						{state.status === "completed" ? <CheckCircle2 size={17} className="shrink-0 text-emerald-600" /> : null}
						{state.status === "no_speech" ? <MicOff size={17} className="shrink-0 text-[var(--inno-text-muted)]" /> : null}
						<div className="min-w-0">
							<div className="font-medium text-[var(--inno-text)]">{t(`notes.meeting.${state.status}`)}</div>
							{state.status === "recording" || state.status === "paused" ? <div className="text-xs tabular-nums text-[var(--inno-text-muted)]">{formatDuration(state.elapsedSeconds)}</div> : null}
						</div>
					</div>
					{state.status === "completed" || state.status === "no_speech" || state.status === "error" ? (
						<button className="rounded p-1 text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)]" onClick={() => meetingStore.dismiss()}><X size={15} /></button>
					) : null}
				</div>
				{state.status === "summarizing" ? <p className="mt-3 text-sm text-[var(--inno-text-muted)]">{t("notes.meeting.summarizingHint")}</p> : null}
				{state.status === "importing" && state.importJob ? (
					<div className="mt-3">
						<div className="mb-1 flex justify-between text-xs text-[var(--inno-text-muted)]"><span>{t(`notes.meeting.importStatus.${state.importJob.status}`)}</span><span>{state.importJob.progress}%</span></div>
						<div className="h-1.5 overflow-hidden rounded-full bg-[var(--inno-surface-muted)]"><div className="h-full bg-[var(--inno-accent)] transition-[width]" style={{ width: `${state.importJob.progress}%` }} /></div>
					</div>
				) : null}
				{state.status === "recording" && (state.partialText || state.lastFinalText) ? (
					<p className="mt-3 line-clamp-3 rounded-md bg-[var(--inno-surface-muted)] p-2 text-sm text-[var(--inno-text-muted)]">{state.partialText || state.lastFinalText}</p>
				) : null}
				{state.status === "recording" || state.status === "paused" ? <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--inno-surface-muted)]"><div className="h-full rounded-full bg-emerald-500 transition-[width]" style={{ width: `${Math.round(state.inputLevel * 100)}%` }} /></div> : null}
				{state.status === "error" ? <p className="mt-3 text-sm text-red-600">{state.error}</p> : null}
				{state.status === "recording" || state.status === "paused" ? (
					<div className="mt-3 flex gap-2">
						<button className="inline-flex items-center justify-center gap-1.5 rounded-md border border-[var(--inno-border)] px-3 py-1.5 text-sm" onClick={() => state.status === "paused" ? meetingStore.resume() : meetingStore.pause()}>
							{state.status === "paused" ? <Play size={13} /> : <Pause size={13} />}{state.status === "paused" ? t("notes.meeting.resume") : t("notes.meeting.pause")}
						</button>
						<button className="inline-flex items-center justify-center gap-2 rounded-md bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700" onClick={() => meetingStore.stop()}>
							<Square size={13} fill="currentColor" />{t("notes.meeting.stop")}
						</button>
					</div>
				) : null}
				{state.status === "error" && state.meetingId ? <button className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-[var(--inno-border)] px-3 py-1.5 text-sm" onClick={() => void meetingStore.retrySummary()}><RotateCcw size={13} />{t("notes.meeting.retrySummary")}</button> : null}
				{state.status === "completed" && state.audioAvailable ? <button className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-[var(--inno-border)] px-3 py-1.5 text-sm" onClick={() => void meetingStore.retranscribe()}><RotateCcw size={13} />{t("notes.meeting.retranscribe")}</button> : null}
				{state.meetingId && state.audioAvailable && ["completed", "no_speech", "error"].includes(state.status) ? <audio className="mt-3 w-full" controls src={meetingAudioUrl(state.meetingId)} /> : null}
			</div>
		</div>
	);
}
