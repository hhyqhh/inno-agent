import { Check, Shield, ShieldAlert, ShieldCheck } from "lucide-react";
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
 * Permission policy mode switcher for the composer toolbar. The same three
 * modes as Settings → General → Tool permissions (default / auto / yolo),
 * exposed next to the input box so the learner can loosen or tighten approval
 * right where the approval cards appear. Global setting, takes effect
 * immediately (the plugin re-reads its config on resources reload).
 */
export function PermissionModeControl() {
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

	const TriggerIcon = MODE_ICONS[state.mode];

	return (
		<div ref={containerRef} className="contents">
			<button
				type="button"
				ref={triggerRef}
				className={`inno-composer-action inno-icon-button flex h-9 w-9 shrink-0 rounded-full disabled:opacity-50 ${state.mode !== "default" ? "text-[var(--inno-accent)]" : ""}`}
				title={`${t("settings.permissions.title")} · ${t(`settings.permissions.modes.${state.mode}`)}`}
				aria-label={t("settings.permissions.title")}
				aria-haspopup="dialog"
				aria-expanded={open}
				disabled={state.isSaving}
				onClick={() => setOpen((value) => !value)}
			>
				<TriggerIcon size={16} />
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
								onClick={() => {
									setOpen(false);
									if (!active) void settingsStore.savePermissionMode(mode).catch(() => undefined);
								}}
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
		</div>
	);
}
