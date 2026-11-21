import { forwardRef, lazy, Suspense, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Check, Copy, Download, Save, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../../api/client.js";
import { saveWorkspaceFileBinary, triggerDownload, workspaceFileUrl } from "../../api/workspace.js";
import { workspaceStore, previewTabKey } from "../../stores/workspace-store.js";
import type { WorkspaceFileDetail } from "../../types/workspace.js";
import { WorkspaceFileBar } from "../WorkspaceFileBar.js";
import { Button, Dialog, Spinner } from "../ui/index.js";
import { hashOfficeBytes, type OfficeEditorHandle } from "./office-editor-handle.js";

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
    const sourceContentHash = useRef<string | null>(null);
    const [ready, setReady] = useState(false);
    const [saving, setSaving] = useState(false);
    const [dirty, setDirty] = useState(false);
    const [copyPath, setCopyPath] = useState("");
    const [downloadPath, setDownloadPath] = useState("");
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
            // The engine fetches fresh bytes even when the preview still holds
            // metadata from before a previous save. Version the imported bytes.
            const [bytes, expectedContentHash] = await Promise.all([
                editor.current.exportBytes(),
                asCopy ? undefined : sourceContentHash.current ?? hashOfficeBytes(editor.current.getSourceBytes()),
            ]);
            const extension = /\.[^.\/]+$/.exec(file.path)?.[0] ?? "";
            const stem = file.path.slice(0, file.path.length - extension.length);
            // Copies get readable names; exclusive creation resolves collisions
            // without ever overwriting an existing document.
            let result;
            for (let number = 1; ; number++) {
                const destination = asCopy ? `${stem} - ${t("officeEditor.copyName")}${number > 1 ? ` (${number})` : ""}${extension}` : file.path;
                try {
                    result = await saveWorkspaceFileBinary(destination, bytes, workspaceId ?? undefined, asCopy ? { createOnly: true } : { confirmOverwrite: true, backupOriginal: false, expectedContentHash });
                    break;
                } catch (err) {
                    if (!(asCopy && number < 1000 && err instanceof ApiError && err.data?.code === "FILE_EXISTS")) throw err;
                }
            }
            if (asCopy) setCopyPath(result.path);
            else { sourceContentHash.current = result.contentHash ?? await hashOfficeBytes(bytes); setCopyPath(""); }
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
    }, [file.path, workspaceId, ready, t]);

    const requestLeave = useCallback((target: "tab" | "preview") => {
        if (busy.current) return true;
        // Refs cover edits and close clicks in the same React batch, as well
        // as pending saves which must not be unmounted halfway through.
        if (busy.current || revision.current !== savedRevision.current) { setLeave(target); return true; }
        if (target === "preview") onClose();
        return false;
    }, [onClose]);
    useImperativeHandle(ref, () => ({ requestCloseTab: () => requestLeave("tab") }), [requestLeave]);

    const finishLeave = async (saveFirst: boolean) => {
        if (busy.current) return;
        if (saveFirst && !(await save())) return;
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
                event.preventDefault(); void save();
            }
        };
        window.addEventListener("beforeunload", beforeUnload);
        window.addEventListener("keydown", shortcut);
        return () => { window.removeEventListener("beforeunload", beforeUnload); window.removeEventListener("keydown", shortcut); };
    }, [active, save]);

    return <>
        <div className={`absolute inset-0 flex flex-col ${active ? "" : "invisible"}`} inert={!active || undefined} aria-hidden={!active || undefined}>
            <WorkspaceFileBar name={file.name} path={file.path}>
                <span role="status" className="inno-word-save-state">{saving ? <><Spinner size={14} />{t("wordEditor.saving")}</> : dirty ? t("wordEditor.unsaved") : downloadPath ? <><Check size={14} />{t(copyPath ? "officeEditor.copySaved" : "wordEditor.saved")}</> : null}</span>
                <Button variant="ghost" size="xs" aria-label={t("wordEditor.save")} disabled={!ready || saving} onClick={() => void save()}><Save size={14} /><span className="inno-filebar-action-label">{t("wordEditor.save")}</span></Button>
                <Button variant="ghost" size="xs" aria-label={t("officeEditor.saveCopy")} disabled={!ready || saving} onClick={() => void save(true)}><Copy size={14} /><span className="inno-filebar-action-label">{t("officeEditor.saveCopy")}</span></Button>
                <Button variant="ghost" size="xs" aria-label={t("wordEditor.downloadCopy")} disabled={!downloadPath || dirty || saving} onClick={() => triggerDownload(workspaceFileUrl(downloadPath, workspaceId ?? undefined, true))}><Download size={14} /><span className="inno-filebar-action-label">{t("wordEditor.downloadCopy")}</span></Button>
                <Button variant="ghost" size="xs" aria-label={t("wordEditor.back")} disabled={saving} onClick={() => requestLeave("preview")}><X size={14} /><span className="inno-filebar-action-label">{t("wordEditor.back")}</span></Button>
            </WorkspaceFileBar>
            {copyPath ? <div role="note" className="border-b border-[var(--inno-border)] px-3 py-2 text-xs text-[var(--inno-text-muted)]">{t("officeEditor.copyPath")} {copyPath}</div> : null}
            {error && !leave ? <div role="alert" className="px-3 py-2 text-xs text-[var(--inno-danger)]">{error}</div> : null}
            <Suspense fallback={<div role="status">{t("preview.loadingFile")}</div>}>
                {file.format === "pptx" ? <PptxEditor ref={editor} onSaveRequest={() => void save()} file={file} onReadyChange={setReady} onInteract={markDirty} /> : <XlsxEditor ref={editor} file={file} onReadyChange={setReady} onInteract={markDirty} />}
            </Suspense>
        </div>
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
