import { forwardRef, lazy, Suspense, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Check, Copy, Download, Save, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { saveWorkspaceFileBinary, triggerDownload, workspaceFileUrl } from "../../api/workspace.js";
import { workspaceStore, previewTabKey } from "../../stores/workspace-store.js";
import type { WorkspaceFileDetail } from "../../types/workspace.js";
import { WorkspaceFileBar } from "../WorkspaceFileBar.js";
import { Button, Dialog, Spinner } from "../ui/index.js";
import type { OfficeEditorHandle } from "./office-editor-handle.js";

const PptxEditor = lazy(() => import("./PptxEditor.js"));
const XlsxEditor = lazy(() => import("./XlsxEditor.js"));

export interface OfficeSessionHandle { requestCloseTab(): boolean }

export const OfficeEditorSession = forwardRef<OfficeSessionHandle, {
    file: WorkspaceFileDetail; workspaceId: string | null; active: boolean; onClose(): void;
}>(function OfficeEditorSession({ file, workspaceId, active, onClose }, ref) {
    const { t } = useTranslation();
    const editor = useRef<OfficeEditorHandle>(null);
    const revision = useRef(0);
    const savedRevision = useRef(0);
    const busy = useRef(false);
    const sourceUpdatedAt = useRef(file.updatedAt);
    const [ready, setReady] = useState(false);
    const [saving, setSaving] = useState(false);
    const [dirty, setDirty] = useState(false);
    const [backupPath, setBackupPath] = useState("");
    const [copyPath, setCopyPath] = useState("");
    const [downloadPath, setDownloadPath] = useState("");
    const [overwrite, setOverwrite] = useState<"save" | "tab" | "preview" | null>(null);
    const [error, setError] = useState("");
    const [leave, setLeave] = useState<"tab" | "preview" | null>(null);
    const key = previewTabKey({ path: file.path, workspaceId });
    const markDirty = useCallback(() => { revision.current++; setDirty(true); }, []);

    const save = useCallback(async (asCopy = false) => {
        if (busy.current || !editor.current || !ready) return false;
        busy.current = true;
        setSaving(true);
        setError("");
        const exportingRevision = revision.current;
        try {
            const bytes = await editor.current.exportBytes();
            const extension = /\.[^.\/]+$/.exec(file.path)?.[0] ?? "";
            const destination = asCopy ? `${file.path.slice(0, file.path.length - extension.length)}.edited-${Date.now()}-${crypto.randomUUID()}${extension}` : file.path;
            // Both actions export the current draft. Exclusive creation protects
            // the source even if a copy destination happens to collide.
            const result = await saveWorkspaceFileBinary(destination, bytes, workspaceId ?? undefined, asCopy ? { createOnly: true } : { confirmOverwrite: true, expectedUpdatedAt: sourceUpdatedAt.current });
            if (asCopy) setCopyPath(result.path);
            else { sourceUpdatedAt.current = result.updatedAt; setCopyPath(""); setBackupPath(result.backupPath ?? ""); }
            setDownloadPath(result.path);
            savedRevision.current = exportingRevision;
            const clean = revision.current === exportingRevision;
            setDirty(!clean);
            if (workspaceStore.activeWorkspaceId === workspaceId) void workspaceStore.loadTree();
            return clean;
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            return false;
        } finally { busy.current = false; setSaving(false); }
    }, [file.path, workspaceId, ready]);

    const requestLeave = useCallback((target: "tab" | "preview") => {
        if (overwrite || busy.current) { if (overwrite) setOverwrite(target); return true; }
        // Refs cover edits and close clicks in the same React batch, as well
        // as pending saves which must not be unmounted halfway through.
        if (busy.current || revision.current !== savedRevision.current) { setLeave(target); return true; }
        if (target === "preview") onClose();
        return false;
    }, [onClose, overwrite]);
    useImperativeHandle(ref, () => ({ requestCloseTab: () => requestLeave("tab") }), [requestLeave]);

    const finishLeave = async (saveFirst: boolean) => {
        if (busy.current) return;
        if (saveFirst) { setOverwrite(leave); setLeave(null); return; }
        const target = leave;
        // A completed confirmation authorizes exactly this tab to close.
        savedRevision.current = revision.current;
        setLeave(null);
        if (target === "tab") {
            workspaceStore.closePreview(key);
            if (!workspaceStore.previewTabs.length) workspaceStore.openStartPage();
        }
        onClose();
    };
    useEffect(() => {
        const beforeUnload = (event: BeforeUnloadEvent) => {
            if (busy.current || revision.current !== savedRevision.current) { event.preventDefault(); event.returnValue = ""; }
        };
        const shortcut = (event: KeyboardEvent) => {
            if (active && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
                event.preventDefault(); if (!busy.current) setOverwrite("save");
            }
        };
        window.addEventListener("beforeunload", beforeUnload);
        window.addEventListener("keydown", shortcut);
        return () => { window.removeEventListener("beforeunload", beforeUnload); window.removeEventListener("keydown", shortcut); };
    }, [active]);

    const limits = t(file.format === "pptx" ? "officeEditor.pptxLimits" : "officeEditor.xlsxLimits");
    return <>
        <div className={`absolute inset-0 flex flex-col ${active ? "" : "invisible"}`} inert={!active || undefined} aria-hidden={!active || undefined}>
            <WorkspaceFileBar name={file.name} path={file.path}>
                <span role="status" className="inno-word-save-state">{saving ? <><Spinner size={14} />{t("wordEditor.saving")}</> : dirty ? t("wordEditor.unsaved") : downloadPath ? <><Check size={14} />{t(copyPath ? "officeEditor.copySaved" : "wordEditor.saved")}</> : null}</span>
                <Button variant="ghost" size="xs" aria-label={t("wordEditor.save")} title={limits} disabled={!ready || saving} onClick={() => setOverwrite("save")}><Save size={14} /><span className="inno-filebar-action-label">{t("wordEditor.save")}</span></Button>
                <Button variant="ghost" size="xs" aria-label={t("officeEditor.saveCopy")} title={limits} disabled={!ready || saving} onClick={() => void save(true)}><Copy size={14} /><span className="inno-filebar-action-label">{t("officeEditor.saveCopy")}</span></Button>
                <Button variant="ghost" size="xs" aria-label={t("wordEditor.downloadCopy")} disabled={!downloadPath || dirty || saving} onClick={() => triggerDownload(workspaceFileUrl(downloadPath, workspaceId ?? undefined, true))}><Download size={14} /><span className="inno-filebar-action-label">{t("wordEditor.downloadCopy")}</span></Button>
                <Button variant="ghost" size="xs" aria-label={t("wordEditor.back")} disabled={saving} onClick={() => requestLeave("preview")}><X size={14} /><span className="inno-filebar-action-label">{t("wordEditor.back")}</span></Button>
            </WorkspaceFileBar>
            {copyPath || backupPath ? <div role="note" className="border-b border-[var(--inno-border)] px-3 py-2 text-xs text-[var(--inno-text-muted)]">{copyPath ? <span className="block break-all">{t("officeEditor.copyPath")} {copyPath}</span> : null}{backupPath ? <span className="block break-all">{t("officeEditor.backupSaved")} {backupPath}</span> : null}</div> : null}
            {error && !leave && !overwrite ? <div role="alert" className="px-3 py-2 text-xs text-[var(--inno-danger)]">{error}</div> : null}
            <Suspense fallback={<div role="status">{t("preview.loadingFile")}</div>}>
                {file.format === "pptx" ? <PptxEditor ref={editor} file={file} onReadyChange={setReady} onInteract={markDirty} /> : <XlsxEditor ref={editor} file={file} onReadyChange={setReady} onInteract={markDirty} />}
            </Suspense>
        </div>
        {overwrite ? <Dialog label={t("officeEditor.overwriteTitle")} className="inno-word-confirm-dialog" onClose={() => { if (!saving) setOverwrite(null); }}>
            <div className="inno-word-confirm-card flex flex-col gap-5 p-6">
                <h2 className="text-base font-medium">{t("officeEditor.overwriteTitle")}</h2>
                <p className="text-sm text-[var(--inno-text-muted)]">{t("officeEditor.overwriteNotice")}</p>
                {error ? <p role="alert" className="text-sm text-[var(--inno-danger)]">{error}</p> : null}
                <div className="flex flex-wrap justify-end gap-2">
                    <Button size="sm" disabled={saving} onClick={() => setOverwrite(null)}>{t("common.cancel", "Cancel")}</Button>
                    <Button variant="primary" size="sm" disabled={!ready || saving} onClick={() => void (async () => {
                        const target = overwrite;
                        if (!(await save())) return;
                        setOverwrite(null);
                        if (target === "save") return;
                        if (target === "tab") {
                            workspaceStore.closePreview(key);
                            if (!workspaceStore.previewTabs.length) workspaceStore.openStartPage();
                        }
                        onClose();
                    })()}>{t("officeEditor.confirmOverwrite")}</Button>
                </div>
            </div>
        </Dialog> : null}
        {leave ? <Dialog label={t("wordEditor.closeTitle")} className="inno-word-confirm-dialog" onClose={() => { if (!saving) setLeave(null); }}>
            <div className="inno-word-confirm-card flex flex-col gap-5 p-6">
                <h2 className="text-base font-medium">{t("wordEditor.closeTitle")}</h2>
                <p className="text-sm text-[var(--inno-text-muted)]">{t("wordEditor.closeMessage")}</p>
                {/* A native modal makes the pane inert: save failures must be visible here. */}
                {error ? <p role="alert" className="text-sm text-[var(--inno-danger)]">{error}</p> : null}
                <div className="flex flex-wrap justify-end gap-2">
                    <Button size="sm" disabled={saving} onClick={() => setLeave(null)}>{t("wordEditor.continueEditing")}</Button>
                    <Button size="sm" disabled={saving} onClick={() => void finishLeave(false)}>{t("wordEditor.discard")}</Button>
                    <Button variant="primary" size="sm" disabled={!ready || saving} onClick={() => void finishLeave(true)}>{t("wordEditor.saveAndClose")}</Button>
                </div>
            </div>
        </Dialog> : null}
    </>;
});
