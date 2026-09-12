import { AlertTriangle, Check, ChevronUp, Shield, ShieldAlert, ShieldCheck } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { settingsStore } from "../../stores/settings-store.js";
import type { PermissionPolicyMode } from "../../types/settings.js";
import { useStoreSnapshot } from "../hooks.js";
import { PopoverSurface } from "../ui/PopoverSurface.js";

const MODES: PermissionPolicyMode[] = ["default", "auto", "yolo"];

const MODE_ICONS: Record<PermissionPolicyMode, typeof Shield> = {
	default: Shield,
	auto: ShieldCheck,
	yolo: ShieldAlert,
};

/**
 * Permission policy mode switcher for the composer. The same three modes as
 * Settings → General → Tool permissions (default / auto / yolo), exposed next
 * to the input box so the learner can loosen or tighten approval right where
 * the approval cards appear. Global setting, takes effect immediately (the
 * plugin re-reads its config on resources reload).
 *
 * Two trigger variants: the legacy compact `icon` button, and the InnoSpark
 * `pill` for the composer sub-pill row. Switching to yolo from the pill first
 * passes through a risk confirmation modal (mirrors the design mockup's
 * 允许完全访问 dialog); the active yolo pill renders red ("full access").
 */
export function PermissionModeControl({ variant = "icon" }: { variant?: "icon" | "pill" }) {
	const { t } = useTranslation();
	const state = useStoreSnapshot(settingsStore, () => ({
		mode: settingsStore.settings?.plugins?.permissionSystem?.mode ?? "default",
		isSaving: settingsStore.isSavingPermissionMode,
	}));
	const triggerRef = useRef<HTMLButtonElement | null>(null);
	const panelRef = useRef<HTMLDivElement | null>(null);
	const containerRef = useRef<HTMLDivElement | null>(null);
	const [open, setOpen] = useState(false);
	const [position, setPosition] = useState({ left: 8, top: 8 });
	const [riskOpen, setRiskOpen] = useState(false);
	const [riskAccepted, setRiskAccepted] = useState(false);

	useLayoutEffect(() => {
		if (!open) return;
		const reposition = () => {
			const trigger = triggerRef.current;
			const panel = panelRef.current;
			if (!trigger || !panel) return;
			const margin = 8;
			const triggerRect = trigger.getBoundingClientRect();
			const width = panel.offsetWidth;
			const height = panel.offsetHeight;
			const left = Math.max(margin, Math.min(triggerRect.left, window.innerWidth - width - margin));
			const top = Math.max(margin, triggerRect.top - height - margin);
			setPosition((previous) => previous.left === left && previous.top === top ? previous : { left, top });
		};
		reposition();
		window.addEventListener("resize", reposition);
		document.addEventListener("scroll", reposition, true);
		return () => {
			window.removeEventListener("resize", reposition);
			document.removeEventListener("scroll", reposition, true);
		};
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Node;
			if (containerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
			setOpen(false);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	const selectMode = (mode: PermissionPolicyMode, active: boolean) => {
		setOpen(false);
		if (active) return;
		// Yolo (完全权限) removes the approval step entirely — require an
		// explicit risk confirmation before persisting the switch.
		if (mode === "yolo") {
			setRiskAccepted(false);
			setRiskOpen(true);
			return;
		}
		void settingsStore.savePermissionMode(mode).catch(() => undefined);
	};

	const confirmRisk = () => {
		setRiskOpen(false);
		void settingsStore.savePermissionMode("yolo").catch(() => undefined);
	};

	const TriggerIcon = MODE_ICONS[state.mode];

	return (
		<div ref={containerRef} className="contents">
			<button
				type="button"
				ref={triggerRef}
				className={variant === "pill"
					? `inno-composer-subpill shrink-0 disabled:opacity-50 ${state.mode === "yolo" ? "is-perm-full" : ""}`
					: `inno-composer-action inno-icon-button flex h-9 w-9 shrink-0 rounded-full disabled:opacity-50 ${state.mode !== "default" ? "text-[var(--inno-accent)]" : ""}`}
				title={`${t("settings.permissions.title")} · ${t(`settings.permissions.modes.${state.mode}`)}`}
				aria-label={t("settings.permissions.title")}
				aria-haspopup="dialog"
				aria-expanded={open}
				disabled={state.isSaving}
				onClick={() => setOpen((value) => !value)}
			>
				<TriggerIcon size={variant === "pill" ? 14 : 16} />
				{variant === "pill" ? (
					<>
						<span className="whitespace-nowrap">{t(`settings.permissions.modes.${state.mode}`)}</span>
						<ChevronUp size={13} aria-hidden="true" />
					</>
				) : null}
			</button>
			{open && typeof document !== "undefined" ? createPortal(
				<PopoverSurface
					ref={panelRef}
					role="dialog"
					aria-label={t("settings.permissions.title")}
					className="w-64 rounded-xl border border-[var(--inno-border)] bg-[var(--inno-surface)] p-1.5 shadow-lg"
					style={{ position: "fixed", left: position.left, top: position.top, zIndex: 100 }}
				>
					{MODES.map((mode) => {
						const active = state.mode === mode;
						const Icon = MODE_ICONS[mode];
						return (
							<button
								key={mode}
								type="button"
								disabled={state.isSaving}
								onClick={() => selectMode(mode, active)}
								className={`flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
									active ? "bg-[var(--inno-accent-soft,rgba(0,0,0,0.04))]" : "hover:bg-[var(--inno-surface-hover,rgba(0,0,0,0.03))]"
								}`}
							>
								<Icon size={15} className={`mt-0.5 shrink-0 ${active ? "text-[var(--inno-accent)]" : "text-[var(--inno-text-tertiary)]"}`} />
								<span className="min-w-0 flex-1">
									<span className="flex items-center justify-between gap-2">
										<span className="text-xs font-medium text-[var(--inno-text)]">{t(`settings.permissions.modes.${mode}`)}</span>
										{active ? <Check size={13} className="shrink-0 text-[var(--inno-accent)]" /> : null}
									</span>
									<span className="mt-0.5 block text-[11px] leading-snug text-[var(--inno-text-tertiary)]">
										{t(`settings.permissions.modeDesc.${mode}`)}
									</span>
								</span>
							</button>
						);
					})}
					<p className="border-t border-[var(--inno-border)] mt-1 px-2 pb-1 pt-1.5 text-[10px] leading-snug text-[var(--inno-text-tertiary)]">
						{t("settings.permissions.denyFloorNote")}
					</p>
				</PopoverSurface>,
				document.body,
			) : null}
			{riskOpen && typeof document !== "undefined" ? createPortal(
				<div
					className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-4"
					onClick={() => setRiskOpen(false)}
				>
					<div
						role="alertdialog"
						aria-modal="true"
						aria-label={t("settings.permissions.risk.title")}
						className="w-[min(460px,88vw)] rounded-[20px] bg-[var(--inno-surface)] p-6 shadow-2xl"
						onClick={(event) => event.stopPropagation()}
					>
						<div className="mb-3 flex items-center gap-2.5 text-base font-semibold text-[var(--inno-text)]">
							<AlertTriangle size={20} className="shrink-0 text-[var(--inno-danger)]" />
							{t("settings.permissions.risk.title")}
						</div>
						<p className="mb-4 text-[13.5px] leading-[1.75] text-[var(--inno-text-muted)]">
							{t("settings.permissions.risk.body")}
						</p>
						<label className="mb-5 flex cursor-pointer select-none items-center gap-2 text-[13px] text-[var(--inno-text)]">
							<input
								type="checkbox"
								className="h-[15px] w-[15px] accent-[var(--inno-send-bg)]"
								checked={riskAccepted}
								onChange={(event) => setRiskAccepted(event.target.checked)}
							/>
							{t("settings.permissions.risk.checkbox")}
						</label>
						<div className="flex justify-end gap-2.5">
							<button
								type="button"
								className="rounded-[18px] bg-[var(--inno-surface-muted)] px-5 py-2 text-[13px] text-[var(--inno-text)] transition-colors hover:bg-[var(--inno-border)]"
								onClick={() => setRiskOpen(false)}
							>
								{t("common.cancel")}
							</button>
							<button
								type="button"
								disabled={!riskAccepted || state.isSaving}
								className="rounded-[18px] bg-[var(--inno-danger)] px-5 py-2 text-[13px] text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
								onClick={confirmRisk}
							>
								{t("settings.permissions.risk.confirm")}
							</button>
						</div>
					</div>
				</div>,
				document.body,
			) : null}
		</div>
	);
}
