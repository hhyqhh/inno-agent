import {
	useUITransition,
	DropdownMenu,
	DropdownMenuChoiceItem,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
	Checkbox,
	IconButton,
} from "../ui/index.js";
import { AlertTriangle, ChevronDown, Shield, ShieldAlert, ShieldCheck } from "lucide-react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { settingsStore } from "../../stores/settings-store.js";
import type { PermissionPolicyMode } from "../../types/settings.js";
import { useStoreSnapshot } from "../hooks.js";

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
 * Three trigger variants: the legacy compact `icon` button, the InnoSpark
 * `pill` for the welcome composer row, and the frameless `inline` control used
 * inside an active conversation. Switching to yolo from a labeled trigger
 * first passes through a risk confirmation modal (mirrors the design mockup's
 * 允许完全访问 dialog); the active yolo label renders red ("full access").
 */
export function PermissionModeControl({ variant = "icon" }: { variant?: "icon" | "pill" | "inline" }) {
	const uiTransition = useUITransition();
	const { t } = useTranslation();
	const state = useStoreSnapshot(settingsStore, () => ({
		mode: settingsStore.settings?.plugins?.permissionSystem?.mode ?? "default",
		isSaving: settingsStore.isSavingPermissionMode,
	}));
	const [open, setOpen] = useState(false);
	const [riskOpen, setRiskOpen] = useState(false);
	const [riskAccepted, setRiskAccepted] = useState(false);

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
		<DropdownMenu open={open} onOpenChange={setOpen}>
			<DropdownMenuTrigger asChild>
				{variant === "icon" ? (
					<IconButton
						variant="ghost"
						size="md"
						shape="pill"
						className={`inno-composer-action ${state.mode !== "default" ? "text-[var(--inno-accent)]" : ""}`}
						aria-label={t("settings.permissions.title")}
						disabled={state.isSaving}
					>
						<TriggerIcon size={15} />
					</IconButton>
				) : (
					<button
						type="button"
						className={variant === "pill"
							? `inno-composer-subpill inno-composer-subrow-control shrink-0 disabled:opacity-50 ${state.mode === "yolo" ? "is-perm-full" : ""}`
							: `inno-composer-permission-inline shrink-0 disabled:opacity-50 ${state.mode === "yolo" ? "is-perm-full" : ""}`}
						aria-label={t("settings.permissions.title")}
						disabled={state.isSaving}
					>
						<TriggerIcon size={14} />
						<span className="whitespace-nowrap">{t(`settings.permissions.modes.${state.mode}`)}</span>
						{variant === "pill" ? (
							<motion.span
								className="inline-flex shrink-0"
								animate={{ rotate: open ? 180 : 0 }}
								transition={uiTransition}
							>
								<ChevronDown size={13} aria-hidden="true" />
							</motion.span>
						) : null}
					</button>
				)}
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="start"
				side="top"
				sideOffset={8}
				collisionPadding={8}
				aria-label={t("settings.permissions.title")}
				className="inno-permission-menu"
			>
				<DropdownMenuRadioGroup
					value={state.mode}
					onValueChange={(value) => selectMode(value as PermissionPolicyMode, value === state.mode)}
				>
					{MODES.map((mode) => {
						const Icon = MODE_ICONS[mode];
						return (
							<DropdownMenuChoiceItem
								key={mode}
								value={mode}
								disabled={state.isSaving}
								icon={<Icon size={15} />}
								label={t(`settings.permissions.modes.${mode}`)}
								description={t(`settings.permissions.modeDesc.${mode}`)}
							/>
						);
					})}
				</DropdownMenuRadioGroup>
				<DropdownMenuSeparator />
				<p className="inno-permission-menu-note">{t("settings.permissions.denyFloorNote")}</p>
			</DropdownMenuContent>
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
							<Checkbox
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
		</DropdownMenu>
	);
}
