import { forwardRef, lazy, Suspense, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Check, Download, Save, X } from "lucide-react";
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
    const [ready, setReady] = useState(false);
    const [saving, setSaving] = useState(false);
    const [dirty, setDirty] = useState(false);
    const [savedPath, setSavedPath] = useState("");
    const [error, setError] = useState("");
    const [leave, setLeave] = useState<"tab" | "preview" | null>(null);
    const key = previewTabKey({ path: file.path, workspaceId });
    const markDirty = useCallback(() => { revision.current++; setDirty(true); }, []);

    const save = useCallback(async () => {
        if (busy.current || !editor.current || !ready) return false;
        busy.current = true;
        setSaving(true);
        setError("");
        const exportingRevision = revision.current;
        try {
            const bytes = await editor.current.exportBytes();
            // These converters do not preserve every Office feature. Every
            // export creates a new file, with exclusive creation on the server;
            // the user's source and earlier exports are never overwritten.
            const dot = file.path.lastIndexOf(".");
            const copy = `${file.path.slice(0, dot)}.edited-${Date.now()}-${Math.random().toString(36).slice(2, 10)}${file.path.slice(dot)}`;
            await saveWorkspaceFileBinary(copy, bytes, workspaceId ?? undefined);
            setSavedPath(copy);
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
        // Refs cover edits and close clicks in the same React batch, as well
        // as pending saves which must not be unmounted halfway through.
        if (busy.current || revision.current !== savedRevision.current) { setLeave(target); return true; }
        if (target === "preview") onClose();
        return false;
    }, [onClose]);
    useImperativeHandle(ref, () => ({ requestCloseTab: () => requestLeave("tab") }), [requestLeave]);

    const finishLeave = async (saveFirst: boolean) => {
        if (busy.current || (saveFirst && !(await save()))) return;
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
                <span role="status" className="inno-office-save-state">{saving ? <><Spinner size={14} />{t("officeEditor.saving")}</> : dirty ? t("officeEditor.unsaved") : savedPath ? <><Check size={14} />{t("officeEditor.copySaved")}</> : null}</span>
                <Button variant="ghost" size="xs" aria-label={t("officeEditor.saveCopy")} disabled={!ready || saving} onClick={() => void save()}><Save size={14} /><span className="inno-filebar-action-label">{t("officeEditor.saveCopy")}</span></Button>
                <Button variant="ghost" size="xs" aria-label={t("officeEditor.downloadCopy")} disabled={!savedPath || saving} onClick={() => triggerDownload(workspaceFileUrl(savedPath, workspaceId ?? undefined, true))}><Download size={14} /><span className="inno-filebar-action-label">{t("officeEditor.downloadCopy")}</span></Button>
                <Button variant="ghost" size="xs" aria-label={t("officeEditor.back")} disabled={saving} onClick={() => requestLeave("preview")}><X size={14} /><span className="inno-filebar-action-label">{t("officeEditor.back")}</span></Button>
            </WorkspaceFileBar>
            <div role="note" className="border-b border-[var(--inno-border)] px-3 py-2 text-xs text-[var(--inno-text-muted)]">{t("officeEditor.copyNotice")}{savedPath ? <span className="block break-all">{savedPath}</span> : null}</div>
            {error && !leave ? <div role="alert" className="px-3 py-2 text-xs text-[var(--inno-danger)]">{error}</div> : null}
            <Suspense fallback={<div role="status">{t("preview.loadingFile")}</div>}>
                {file.format === "pptx" ? <PptxEditor ref={editor} file={file} onReadyChange={setReady} onInteract={markDirty} /> : <XlsxEditor ref={editor} file={file} onReadyChange={setReady} onInteract={markDirty} />}
            </Suspense>
        </div>
        {leave ? <Dialog label={t("officeEditor.closeTitle")} className="inno-office-confirm-dialog" onClose={() => { if (!saving) setLeave(null); }}>
            <div className="inno-office-confirm-card flex flex-col gap-5 p-6">
                <h2 className="text-base font-medium">{t("officeEditor.closeTitle")}</h2>
                <p className="text-sm text-[var(--inno-text-muted)]">{t("officeEditor.closeMessage")}</p>
                {/* A native modal makes the pane inert: save failures must be visible here. */}
                {error ? <p role="alert" className="text-sm text-[var(--inno-danger)]">{error}</p> : null}
                <div className="flex flex-wrap justify-end gap-2">
                    <Button size="sm" disabled={saving} onClick={() => setLeave(null)}>{t("officeEditor.continueEditing")}</Button>
                    <Button size="sm" disabled={saving} onClick={() => void finishLeave(false)}>{t("officeEditor.discard")}</Button>
                    <Button variant="primary" size="sm" disabled={!ready || saving} onClick={() => void finishLeave(true)}>{t("officeEditor.saveAndClose")}</Button>
                </div>
            </div>
        </Dialog> : null}
    </>;
});
