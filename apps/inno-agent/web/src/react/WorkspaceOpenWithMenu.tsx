import { useEffect, useState } from "react";
import { AppWindow, ChevronDown, Download, ExternalLink, FolderOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { FileApplication, FileApplications } from "../../../src/shared/desktop-files.js";
import { triggerDownload, workspaceFileUrl } from "../api/workspace.js";
import { readFileOpenPreference, rememberFileOpenPreference } from "../utils/file-open-preference.js";
import { Button, DropdownMenu, DropdownMenuActionItem, DropdownMenuContent, DropdownMenuSeparator, DropdownMenuTrigger, Spinner } from "./ui/index.js";

const APPLICATIONS_TTL = 5 * 60_000;
const APPLICATIONS_CACHE_LIMIT = 64;
type Desktop = NonNullable<Window["innoDesktop"]>;
interface ApplicationListEntry {
	result?: FileApplications;
	loadedAt: number;
	pending?: Promise<FileApplications | null | undefined>;
}
// Opening a menu used to clear its results and invoke native application/icon
// discovery every time. Share one bounded, renderer-session cache across menu
// instances; file-specific associations must not be cached by extension alone.
const applicationLists = new WeakMap<Desktop, Map<string, ApplicationListEntry>>();
function readApplicationList(desktop: Desktop, key: string, path: string, workspaceId: string | null) {
	let entries = applicationLists.get(desktop);
	if (!entries) { entries = new Map(); applicationLists.set(desktop, entries); }
	let entry = entries.get(key);
	if (entry?.result && Date.now() - entry.loadedAt < APPLICATIONS_TTL) return { cached: entry.result };
	if (!entry) {
		if (entries.size >= APPLICATIONS_CACHE_LIMIT) entries.delete(entries.keys().next().value!);
		entry = { loadedAt: 0 };
		entries.set(key, entry);
	}
	const current = entry;
	if (!current.pending) {
		current.pending = (async () => desktop.getWorkspaceFileApplications?.(path, workspaceId))().then(data => {
			// A temporary failure/default fallback must not become a fresh cache
			// entry: reopening should retry, while a stale usable list stays visible.
			if (data && !data.unavailable) { current.result = data; current.loadedAt = Date.now(); }
			return data;
		}).finally(() => {
			current.pending = undefined;
			if (!current.result && entries.get(key) === current) entries.delete(key);
		});
	}
	return { cached: current.result, pending: current.pending };
}

export function WorkspaceOpenWithMenu({ path, workspaceId, disabled = false, allowDownload = true, onOpenPreview, compact = false }: { path: string; workspaceId: string | null; disabled?: boolean; allowDownload?: boolean; onOpenPreview?: () => void; compact?: boolean }) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const [loading, setLoading] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [listing, setListing] = useState<{ key: string; value: FileApplications } | null>(null);
	const cacheKey = JSON.stringify([workspaceId, path]);
	const result = listing?.key === cacheKey ? listing.value : null;
	const desktop = window.innoDesktop;
	useEffect(() => {
		if (!open || !desktop?.openWorkspaceFile) return;
		let cancelled = false;
		const { cached, pending } = readApplicationList(desktop, cacheKey, path, workspaceId);
		setLoading(!cached && !!pending);
		setError("");
		setListing(cached ? { key: cacheKey, value: cached } : null);
		if (!pending) return;
		(async () => {
			try {
				const data = await pending;
				if (cancelled) return;
				setListing({ key: cacheKey, value: (data && !data.unavailable ? data : cached ?? data) ?? { applications: [{ id: "system-default", name: "", isDefault: true }], fileManager: "files" } });
				if (!data || data.unavailable) setError(t("preview.appListFailed", "无法读取完整应用列表，仍可使用系统默认应用。"));
			} catch {
				if (!cancelled) {
					setListing({ key: cacheKey, value: cached ?? { applications: [{ id: "system-default", name: "", isDefault: true }], fileManager: "files" } });
					setError(t("preview.appListFailed", "无法读取完整应用列表，仍可使用系统默认应用。"));
				}
			} finally { if (!cancelled) setLoading(false); }
		})();
		return () => { cancelled = true; };
	}, [open, cacheKey, path, workspaceId, desktop, t]);
	if (!desktop?.openWorkspaceFile && !onOpenPreview) return null;

	const perform = async (action: () => Promise<boolean | undefined>, onSuccess?: () => void) => {
		if (busy) return;
		setBusy(true);
		setError("");
		try {
			if (!(await action())) throw new Error("Native action failed");
			onSuccess?.();
			setOpen(false);
		} catch { setError(t("preview.openWithAppFailed", "无法打开文件，请检查文件是否存在及应用设置。")); }
		finally { setBusy(false); }
	};
	const openApplication = (application: Pick<FileApplication, "id" | "name">) => perform(
		() => desktop!.openWorkspaceFile!(path, workspaceId, application.id),
		() => rememberFileOpenPreference(path, { kind: "application", id: application.id, name: application.name }),
	);
	const openPreview = () => {
		onOpenPreview?.();
		rememberFileOpenPreference(path, { kind: "preview" });
		setError("");
		setOpen(false);
	};
	const openPreferred = () => {
		if (busy) return;
		// Read at click time so another card's choice immediately applies here,
		// without enumerating native applications just to use the saved choice.
		const preference = readFileOpenPreference(path);
		if (preference?.kind === "application" && desktop?.openWorkspaceFile) void openApplication(preference);
		else if (onOpenPreview) openPreview();
		else if (desktop?.openWorkspaceFile) void openApplication({ id: "system-default", name: "" });
	};
	const preference = readFileOpenPreference(path);
	const preferredApplication = preference?.kind === "application" ? preference.id : null;
	const previewIsDefault = !!onOpenPreview && (!preference || preference.kind === "preview");
	const revealLabel = result?.fileManager === "finder" ? t("preview.revealInFinder", "在访达中显示")
		: result?.fileManager === "explorer" ? t("preview.revealInExplorer", "在文件资源管理器中显示") : t("preview.revealInFiles", "在文件管理器中显示");
	const triggerLabel = compact ? t("preview.openIn", "打开方式") : t("preview.openWithApp", "使用其他应用打开");
	return <div className="flex flex-col items-end gap-1">
		<div className="flex items-center gap-1">
			<DropdownMenu open={open} onOpenChange={(value) => { if (!busy) setOpen(value); }}>
				<DropdownMenuTrigger asChild>
					<Button variant="ghost" size="xs" aria-label={triggerLabel} title={triggerLabel} disabled={disabled || busy}>
						{busy ? <Spinner size={14} /> : compact ? null : <ExternalLink size={14} />}{compact ? t("preview.openIn", "打开方式") : <span className="inno-filebar-action-label">{t("preview.openWithApp", "使用其他应用打开")}</span>}{compact ? <ChevronDown size={14} /> : null}
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="max-h-[min(420px,var(--radix-dropdown-menu-content-available-height))] max-w-[min(320px,calc(100vw-16px))] overflow-y-auto">
					{onOpenPreview ? <DropdownMenuActionItem disabled={busy} icon={<AppWindow size={16} />} label={`${t("preview.openInPreview", "在文件预览中打开")}${previewIsDefault ? t("preview.defaultSuffix", "（默认）") : ""}`} onSelect={openPreview} /> : null}
					{loading ? <DropdownMenuActionItem disabled icon={<Spinner size={16} />} label={t("preview.loadingApps", "正在读取应用…")} /> : null}
					{result?.applications.map((application) => <DropdownMenuActionItem key={application.id} disabled={busy}
						icon={application.icon ? <img src={application.icon} alt="" className="h-4 w-4 object-contain" /> : <AppWindow size={16} />}
						label={application.name ? `${application.name}${(preferredApplication ? application.id === preferredApplication : !previewIsDefault && application.isDefault) ? t("preview.defaultSuffix", "（默认）") : ""}` : t("preview.systemDefaultApp", "系统默认应用")}
						onSelect={(event) => { event.preventDefault(); void openApplication(application); }} />)}
					{error ? <div role="alert" className="max-w-64 px-3 py-2 text-xs text-[var(--inno-danger)]">{error}</div> : null}
					<DropdownMenuSeparator />
					{desktop?.revealWorkspaceFile ? <DropdownMenuActionItem disabled={busy} icon={<FolderOpen size={16} />} label={revealLabel} onSelect={(event) => { event.preventDefault(); void perform(() => desktop.revealWorkspaceFile!(path, workspaceId)); }} /> : null}
					{allowDownload ? <DropdownMenuActionItem disabled={busy} icon={<Download size={16} />} label={t("preview.downloadCopy", "下载副本")} onSelect={() => triggerDownload(workspaceFileUrl(path, workspaceId ?? undefined, true))} /> : null}
				</DropdownMenuContent>
			</DropdownMenu>
			{compact ? <Button variant="secondary" size="xs" disabled={disabled || busy} aria-label={t("common.open", "打开")} onClick={openPreferred}>
				{t("common.open", "打开")}
			</Button> : null}
		</div>
		{error && !open ? <div role="alert" className="max-w-64 text-xs text-[var(--inno-danger)]">{error}</div> : null}
	</div>;
}
