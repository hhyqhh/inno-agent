import { createPortal } from "react-dom";
import { useEffect, useRef } from "react";
import { AlertTriangle, Check, CircleAlert, Folder, LoaderCircle, MoveRight, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type {
	WorkspaceFileAccess,
	WorkspaceSwitchFileAction,
	WorkspaceSwitchPreview,
	WorkspaceSwitchResult,
} from "../../api/workspaces.js";

export interface WorkspaceSwitchConfirmProps {
	preview?: WorkspaceSwitchPreview | null;
	loading?: boolean;
	fileActions: Record<string, WorkspaceSwitchFileAction>;
	result?: WorkspaceSwitchResult | null;
	executing?: boolean;
	error?: string;
	onFileActionChange: (path: string, action: WorkspaceSwitchFileAction) => void;
	onConfirm: () => void;
	onCancel: () => void;
}

function accessLabel(access: WorkspaceFileAccess, t: TFunction): string {
	return t(`chat.workspaceSwitch.access.${access}`, { defaultValue: access === "read_write" ? "读取+写入" : access === "read" ? "读取" : "写入" });
}

function resultLabel(status: string, t: TFunction): string {
	return t(`chat.workspaceSwitch.result.${status}`, { defaultValue: status });
}

export function WorkspaceSwitchConfirm({
	preview,
	loading = false,
	fileActions,
	result,
	executing = false,
	error,
	onFileActionChange,
	onConfirm,
	onCancel,
}: WorkspaceSwitchConfirmProps) {
	const { t } = useTranslation();
	const closeRef = useRef<HTMLButtonElement | null>(null);
	const titleId = "workspace-switch-confirm-title";
	const warningId = "workspace-switch-confirm-warning";
	const finished = Boolean(result);

	useEffect(() => {
		closeRef.current?.focus({ preventScroll: true });
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !executing) onCancel();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [executing, onCancel]);

	if (typeof document === "undefined") return null;

	const counts = result?.statistics ?? null;

	return createPortal(
		<div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 p-4" onMouseDown={(event) => {
			if (event.target === event.currentTarget && !executing) onCancel();
		}}>
			<div
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				aria-describedby={preview ? warningId : undefined}
				className="flex max-h-[min(760px,calc(100dvh-32px))] w-[min(680px,96vw)] flex-col overflow-hidden rounded-[22px] border border-[var(--inno-border)] bg-[var(--inno-surface)] text-[var(--inno-text)] shadow-2xl"
				onMouseDown={(event) => event.stopPropagation()}
			>
				<div className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--inno-border)] px-5 py-4">
					<div className="flex min-w-0 items-start gap-3">
						<div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--inno-warning-soft,var(--inno-accent-soft))] text-[var(--inno-warning,var(--inno-accent))]">
							<AlertTriangle size={19} aria-hidden="true" />
						</div>
						<div className="min-w-0">
							<h2 id={titleId} className="text-[15px] font-semibold">{t("chat.workspaceSwitch.title", "切换会话工作区")}</h2>
							{preview ? (
								<div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-[var(--inno-text-muted)]">
									<span className="max-w-[190px] truncate" title={preview.sourceWorkspace.name}>{preview.sourceWorkspace.name}</span>
									<MoveRight size={13} aria-hidden="true" />
									<span className="max-w-[190px] truncate font-medium text-[var(--inno-text)]" title={preview.targetWorkspace.name}>{preview.targetWorkspace.name}</span>
								</div>
							) : null}
						</div>
					</div>
					<button ref={closeRef} type="button" aria-label={t("common.close", "关闭")} title={t("common.close", "关闭")} disabled={executing} className="rounded-lg p-1.5 text-[var(--inno-text-subtle)] hover:bg-[var(--inno-surface-muted)] disabled:opacity-40" onClick={onCancel}>
						<X size={17} />
					</button>
				</div>

				{loading || !preview ? (
					<div className="flex min-h-40 items-center justify-center gap-2 px-5 py-10 text-sm text-[var(--inno-text-muted)]">
						<LoaderCircle size={18} className="animate-spin" aria-hidden="true" />
						{t("chat.workspaceSwitch.loading", "正在检查可迁移文件…")}
					</div>
				) : (
					<>
						<div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
							{error ? <div role="alert" className="mb-3 rounded-xl border border-[var(--inno-danger-border,var(--inno-border))] bg-[var(--inno-danger-soft,var(--inno-surface-muted))] px-3.5 py-2.5 text-xs text-[var(--inno-danger,var(--inno-accent))]">{error}</div> : null}
							<div className="rounded-xl border border-[var(--inno-warning-border,var(--inno-border))] bg-[var(--inno-warning-soft,var(--inno-surface-muted))] px-3.5 py-3 text-[12px] leading-relaxed text-[var(--inno-text-muted)]">
								<div className="flex gap-2 font-medium text-[var(--inno-text)]"><CircleAlert size={15} className="mt-0.5 shrink-0 text-[var(--inno-warning,var(--inno-accent))]" aria-hidden="true" />{t("chat.workspaceSwitch.warningTitle", "切换工作区可能影响上下文")}</div>
								<p id={warningId} className="mt-1.5">{t("chat.workspaceSwitch.warning", "会话历史会保留，但相同的相对路径可能指向新工作区中的不同文件，可能导致 AI 的上下文或记忆判断错误。此次不会迁移会话历史或记忆。")}</p>
							</div>

							<div className="mt-4 flex items-center justify-between gap-3">
								<div>
									<h3 className="text-sm font-medium">{t("chat.workspaceSwitch.filesTitle", "本会话访问过的文件")}</h3>
									<p className="mt-0.5 text-[11px] text-[var(--inno-text-subtle)]">{t("chat.workspaceSwitch.filesHint", "为每个文件分别选择复制、移动或不处理")}</p>
								</div>
							</div>

							<div className="mt-2 overflow-hidden rounded-xl border border-[var(--inno-border)]">
								{preview.files.length > 0 ? preview.files.map((file) => (
									<div key={file.path} className={`border-b border-[var(--inno-border)] px-3 py-2.5 last:border-b-0 ${file.selectable ? "" : "opacity-55"}`}>
										<div className="flex items-center gap-2.5">
											<Folder size={14} className="shrink-0 text-[var(--inno-text-subtle)]" aria-hidden="true" />
											<span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={file.path}>{file.path}</span>
											<span className="shrink-0 rounded-full bg-[var(--inno-surface-muted)] px-2 py-0.5 text-[10px] text-[var(--inno-text-muted)]">{accessLabel(file.access, t)}</span>
											{file.exists && file.selectable ? null : <span className="shrink-0 text-[10px] text-[var(--inno-danger,var(--inno-accent))]">{t("chat.workspaceSwitch.missing", "已不存在或不可处理")}</span>}
										</div>
										{file.selectable ? (
											<div role="radiogroup" aria-label={file.path} className="mt-2 grid grid-cols-3 gap-1.5">
												{(["copy", "move", "none"] as const).map((value) => {
													const checked = (fileActions[file.path] ?? "none") === value;
													const label = value === "none"
														? t("chat.workspaceSwitch.action.none", "不处理")
														: value === "copy"
														? t("chat.workspaceSwitch.action.copy", "复制")
														: t("chat.workspaceSwitch.action.move", "移动");
													return (
														<label key={value} className={`flex cursor-pointer items-center gap-1.5 rounded-lg border px-2 py-1.5 text-[11px] ${checked ? "border-[var(--inno-accent)] bg-[var(--inno-accent-soft)]" : "border-[var(--inno-border)] hover:bg-[var(--inno-surface-muted)]"}`}>
															<input type="radio" name={`workspace-file-action-${file.path}`} value={value} checked={checked} disabled={executing || finished} onChange={() => onFileActionChange(file.path, value)} />
															<span className="truncate">{label}</span>
														</label>
													);
												})}
											</div>
										) : null}
									</div>
								)) : <div className="px-3 py-5 text-center text-xs text-[var(--inno-text-subtle)]">{t("chat.workspaceSwitch.noFiles", "没有可追踪的文件")}</div>}
							</div>

							{preview.trackingIncomplete ? <p className="mt-2 text-[11px] leading-relaxed text-[var(--inno-warning,var(--inno-accent))]">{t("chat.workspaceSwitch.trackingIncomplete", "部分历史文件访问无法可靠还原，文件统计可能不完整。")}</p> : null}

							{result ? (
								<div className="mt-4 rounded-xl border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] px-3.5 py-3 text-xs">
									<div className="flex items-center gap-2 font-medium text-[var(--inno-text)]"><Check size={15} className="text-[var(--inno-success,var(--inno-accent))]" />{t("chat.workspaceSwitch.resultTitle", "工作区已切换")}</div>
									{counts ? <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[var(--inno-text-muted)]"><span>{t("chat.workspaceSwitch.resultSuccess", "成功 {{count}}", { count: counts.success })}</span><span>{t("chat.workspaceSwitch.resultConflict", "冲突跳过 {{count}}", { count: counts.conflicts })}</span><span>{t("chat.workspaceSwitch.resultFailure", "失败 {{count}}", { count: counts.failures })}</span><span>{t("chat.workspaceSwitch.resultMissing", "缺失 {{count}}", { count: counts.missing })}</span></div> : null}
									{result.files.length > 0 ? <details className="mt-2"><summary className="cursor-pointer text-[var(--inno-text-muted)]">{t("chat.workspaceSwitch.resultDetails", "查看具体路径")}</summary><ul className="mt-2 max-h-44 space-y-1 overflow-y-auto">{result.files.map((file) => <li key={`${file.path}-${file.status}`} className="flex gap-2"><span className="shrink-0">{resultLabel(file.status, t)}</span><span className="min-w-0 truncate font-mono text-[10px]" title={file.path}>{file.path}</span>{file.error ? <span className="min-w-0 truncate text-[var(--inno-danger,var(--inno-accent))]" title={file.error}>— {file.error}</span> : null}</li>)}</ul></details> : null}
									{result.trackingIncomplete ? <p className="mt-2 text-[11px] text-[var(--inno-warning,var(--inno-accent))]">{t("chat.workspaceSwitch.trackingIncomplete", "部分历史文件访问无法可靠还原，文件统计可能不完整。")}</p> : null}
								</div>
							) : null}
						</div>
						<div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--inno-border)] px-5 py-3.5">
							<button type="button" className="rounded-lg px-3.5 py-2 text-xs text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)] disabled:opacity-40" disabled={executing} onClick={onCancel}>{finished ? t("common.close", "关闭") : t("common.cancel", "取消")}</button>
							<button type="button" className="rounded-lg bg-[var(--inno-accent)] px-4 py-2 text-xs font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45" disabled={executing || finished} onClick={onConfirm}>{executing ? <span className="inline-flex items-center gap-1.5"><LoaderCircle size={13} className="animate-spin" />{t("chat.workspaceSwitch.executing", "正在切换…")}</span> : t("chat.workspaceSwitch.confirm", "确认切换")}</button>
						</div>
					</>
				)}
			</div>
		</div>,
		document.body,
	);
}
