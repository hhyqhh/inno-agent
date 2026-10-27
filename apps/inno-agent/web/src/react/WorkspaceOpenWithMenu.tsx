import { useEffect, useState } from "react";
import { AppWindow, Download, ExternalLink, FolderOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { FileApplications } from "../../../src/shared/desktop-files.js";
import { triggerDownload, workspaceFileUrl } from "../api/workspace.js";
import { Button, DropdownMenu, DropdownMenuActionItem, DropdownMenuContent, DropdownMenuSeparator, DropdownMenuTrigger, Spinner } from "./ui/index.js";

export function WorkspaceOpenWithMenu({ path, workspaceId, disabled = false }: { path: string; workspaceId: string | null; disabled?: boolean }) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const [loading, setLoading] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [result, setResult] = useState<FileApplications | null>(null);
	const desktop = window.innoDesktop;
	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setLoading(true);
		setError("");
		setResult(null);
		(async () => {
			try {
				const data = await desktop?.getWorkspaceFileApplications?.(path, workspaceId);
				if (cancelled) return;
				setResult(data ?? { applications: [{ id: "system-default", name: "", isDefault: true }], fileManager: "files" });
				if (!data || data.unavailable) setError(t("preview.appListFailed", "无法读取完整应用列表，仍可使用系统默认应用。"));
			} catch {
				if (!cancelled) {
					setResult({ applications: [{ id: "system-default", name: "", isDefault: true }], fileManager: "files" });
					setError(t("preview.appListFailed", "无法读取完整应用列表，仍可使用系统默认应用。"));
				}
			} finally { if (!cancelled) setLoading(false); }
		})();
		return () => { cancelled = true; };
	}, [open, path, workspaceId, desktop, t]);
	if (!desktop?.openWorkspaceFile) return null;

	const perform = async (action: () => Promise<boolean | undefined>) => {
		if (busy) return;
		setBusy(true);
		setError("");
		try {
			if (!(await action())) throw new Error("Native action failed");
			setOpen(false);
		} catch { setError(t("preview.openWithAppFailed", "无法打开文件，请检查文件是否存在及应用设置。")); }
		finally { setBusy(false); }
	};
	const revealLabel = result?.fileManager === "finder" ? t("preview.revealInFinder", "在访达中显示")
		: result?.fileManager === "explorer" ? t("preview.revealInExplorer", "在文件资源管理器中显示") : t("preview.revealInFiles", "在文件管理器中显示");
	return <DropdownMenu open={open} onOpenChange={(value) => { if (!busy) setOpen(value); }}>
		<DropdownMenuTrigger asChild>
			<Button variant="ghost" size="xs" aria-label={t("preview.openWithApp", "使用其他应用打开")} title={t("preview.openWithApp", "使用其他应用打开")} disabled={disabled || busy}>
				{busy ? <Spinner size={14} /> : <ExternalLink size={14} />}<span className="inno-filebar-action-label">{t("preview.openWithApp", "使用其他应用打开")}</span>
			</Button>
		</DropdownMenuTrigger>
		<DropdownMenuContent align="end" className="max-h-[min(420px,var(--radix-dropdown-menu-content-available-height))] max-w-[min(320px,calc(100vw-16px))] overflow-y-auto">
			{loading ? <DropdownMenuActionItem disabled icon={<Spinner size={16} />} label={t("preview.loadingApps", "正在读取应用…")} /> : null}
			{result?.applications.map((application) => <DropdownMenuActionItem key={application.id} disabled={busy}
				icon={application.icon ? <img src={application.icon} alt="" className="h-4 w-4 object-contain" /> : <AppWindow size={16} />}
				label={application.name ? `${application.name}${application.isDefault ? t("preview.defaultSuffix", "（默认）") : ""}` : t("preview.systemDefaultApp", "系统默认应用")}
				onSelect={(event) => { event.preventDefault(); void perform(() => desktop.openWorkspaceFile!(path, workspaceId, application.id)); }} />)}
			{error ? <div role="alert" className="max-w-64 px-3 py-2 text-xs text-[var(--inno-danger)]">{error}</div> : null}
			<DropdownMenuSeparator />
			{desktop.revealWorkspaceFile ? <DropdownMenuActionItem disabled={busy} icon={<FolderOpen size={16} />} label={revealLabel} onSelect={(event) => { event.preventDefault(); void perform(() => desktop.revealWorkspaceFile!(path, workspaceId)); }} /> : null}
			<DropdownMenuActionItem disabled={busy} icon={<Download size={16} />} label={t("preview.downloadCopy", "下载副本")} onSelect={() => triggerDownload(workspaceFileUrl(path, workspaceId ?? undefined, true))} />
		</DropdownMenuContent>
	</DropdownMenu>;
}
