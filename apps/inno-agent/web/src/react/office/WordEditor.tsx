/** Inline DOCX editing with EigenPal's browser engine. The original OOXML
 * package stays in the engine; the host owns workspace persistence and guards. */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Download, Save, X } from "lucide-react";
import { saveWorkspaceFileBinary } from "../../api/workspace.js";
import { DocxEditor, type DocxEditorRef } from "@docx-editor.dev/react";
import type { DocumentChange, EditorFontError } from "@docx-editor.dev/core/contracts/editor";
import type { FontResolver } from "@docx-editor.dev/core/editor";
import zhCN from "@docx-editor.dev/i18n/zh-CN";
import "@docx-editor.dev/core/styles/editor.css";
import { loadWordEditorFonts } from "./word-editor-fonts.js";
import type { WorkspaceFileDetail } from "../../types/workspace.js";
import { useStoreSnapshot } from "../hooks.js";
import { themeStore } from "../../stores/theme-store.js";
import { Button, Dialog, Spinner } from "../ui/index.js";
import { WorkspaceFileBar } from "../WorkspaceFileBar.js";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// Installed CJK collections (e.g. SimSun: 18 MB) exceed the engine's
// default 16 MB shaping limit. Match our bounded local-font reader so layout
// measures the same admitted face that the browser paints.
const FONT_SHAPING = { maxFontBytes: 64 * 1024 * 1024 } as const;

export interface WordEditorHandle {
	isDirty(): boolean;
	save(): Promise<boolean>;
}

interface WordEditorProps {
	file: WorkspaceFileDetail;
	workspaceId: string | null;
	/**
	 * False while the owning tab sits in the background: the session stays
	 * mounted to keep its draft, but must not react to global shortcuts.
	 */
	active?: boolean;
	onClose: () => void;
}

/** Inline DOCX editor for the workspace preview pane; the pane owns the chrome. */
export const WordEditor = forwardRef<WordEditorHandle, WordEditorProps>(function WordEditor({ file, workspaceId, active = true, onClose }: WordEditorProps, ref) {
	const { t, i18n } = useTranslation();
	const theme = useStoreSnapshot(themeStore, () => themeStore.current);
	const editorRef = useRef<DocxEditorRef | null>(null);
	const [documentBytes, setDocumentBytes] = useState<Uint8Array>();
	const [fonts, setFonts] = useState<FontResolver>();
	const [fontWarning, setFontWarning] = useState(false);
	const [fontFailureCode, setFontFailureCode] = useState<string>();
	const [fontFailureDetail, setFontFailureDetail] = useState<string>();
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [attempt, setAttempt] = useState(0);
	const [ready, setReady] = useState(false);
	const [saving, setSaving] = useState(false);
	const [dirty, setDirty] = useState(false);
	const [savedAt, setSavedAt] = useState<Date | null>(null);
	const [confirmClose, setConfirmClose] = useState(false);
	const dirtyRef = useRef(false);
	const saveBusy = useRef<Promise<boolean> | null>(null);
	const editVersion = useRef(0);

	const markDirty = useCallback((change: DocumentChange) => {
		// The engine reports loads separately. No timer and no whole-document
		// serialization belongs on the keystroke path.
		if (change.source) return;
		editVersion.current += 1;
		if (!dirtyRef.current) {
			dirtyRef.current = true;
			setDirty(true);
		}
	}, []);

	useEffect(() => {
		const controller = new AbortController();
		setError(""); setLoading(true); setReady(false); setDocumentBytes(undefined);
		setDirty(false); dirtyRef.current = false; editVersion.current = 0; setSavedAt(null);
		setFontWarning(false);
		setFontFailureCode(undefined);
		setFontFailureDetail(undefined);
		void (async () => {
			try {
				if (!file.url) throw new Error("Document URL is missing");
				const [res, loadedFonts] = await Promise.all([
					fetch(file.url, { signal: controller.signal }),
					loadWordEditorFonts(),
				]);
				if (!res.ok) throw new Error(`Failed to load document (${res.status})`);
				const buf = await res.arrayBuffer();
				if (controller.signal.aborted) return;
				setFonts(() => loadedFonts.configuration);
				setFontWarning(loadedFonts.degraded);
				// Stable input bytes keep selection and undo history across host
				// status updates, theme changes and background-tab switches.
				setDocumentBytes(new Uint8Array(buf));
			} catch (err) {
				if (!controller.signal.aborted) {
					setError(err instanceof Error ? err.message : String(err));
					setLoading(false);
				}
			}
		})();
		return () => controller.abort();
	}, [file.url, attempt]);

	const onReady = useCallback(() => { setReady(true); setLoading(false); }, []);
	const onFontError = useCallback((fontError: EditorFontError) => {
		// Missing faces can be reported before the asynchronous resolver finishes.
		// The engine's live font notice owns those; don't latch a stale host warning.
		if (fontError.code !== "missing" && fontError.code !== "missingFont") {
			setFontFailureCode(fontError.code);
			setFontFailureDetail(fontError.message);
			setFontWarning(true);
		}
	}, []);

	const save = useCallback((): Promise<boolean> => {
		if (saveBusy.current) return saveBusy.current;
		if (!editorRef.current || !ready) return Promise.resolve(false);
		const editor = editorRef.current;
		const version = editVersion.current;
		setSaving(true);
		const operation = (async () => {
			try {
				const bytes = await editor.save();
				if (!bytes) throw new Error("No document to save");
				const result = await saveWorkspaceFileBinary(file.path, bytes, workspaceId ?? undefined);
				if (!result.saved) throw new Error("Save failed");
				// A late save acknowledgement covers only the serialized revision.
				// Edits made while saving must still block save-and-close.
				const clean = editVersion.current === version;
				dirtyRef.current = !clean;
				setDirty(!clean);
				setSavedAt(new Date());
				setError("");
				return clean;
			} catch (err) {
				setError(err instanceof Error ? err.message : "Save failed");
				return false;
			} finally {
				setSaving(false);
				saveBusy.current = null;
			}
		})();
		saveBusy.current = operation;
		return operation;
	}, [file.path, workspaceId, ready]);

	// The tab-close guard in WorkspaceBrowser checks dirtiness and triggers the
	// save flow without cycling through this component's own confirm dialog.
	useImperativeHandle(ref, () => ({ isDirty: () => dirtyRef.current, save }), [save]);

	useEffect(() => {
		if (!active) return;
		const onKey = (event: KeyboardEvent) => {
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
				event.preventDefault(); event.stopPropagation(); void save();
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [active, save]);

	useEffect(() => {
		if (!dirty && !saving) return;
		const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
		window.addEventListener("beforeunload", guard);
		return () => window.removeEventListener("beforeunload", guard);
	}, [dirty, saving]);

	const requestClose = () => { if (!saving) { if (dirty) setConfirmClose(true); else onClose(); } };
	const download = async () => {
		try {
			const bytes = await editorRef.current?.save();
			if (!bytes) throw new Error("No document to export");
			const url = URL.createObjectURL(new Blob([bytes], { type: DOCX_MIME }));
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = file.name;
			anchor.click();
			setTimeout(() => URL.revokeObjectURL(url), 1000);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Export failed");
		}
	};
	const savedTime = savedAt ? savedAt.toLocaleTimeString(i18n.language, { hour: "2-digit", minute: "2-digit" }) : "";

	return <section className="inno-word-editor" data-color-mode={theme}>
			<WorkspaceFileBar name={file.name} path={file.path}>
				<span role="status" className="inno-word-save-state">{saving ? <><Spinner size={14} />{t("wordEditor.saving")}</> : dirty ? t("wordEditor.unsaved") : ready ? <><Check size={14} />{savedTime ? t("wordEditor.lastSaved", { time: savedTime }) : t("wordEditor.saved")}</> : null}</span>
				<Button variant="ghost" size="xs" aria-label={t("wordEditor.save")} title={t("wordEditor.saveShortcut")} disabled={!ready || saving} onClick={() => void save()}>
					<Save size={14} /><span className="inno-filebar-action-label">{t("wordEditor.save")}</span>
				</Button>
				<Button variant="ghost" size="xs" aria-label={t("wordEditor.downloadCopy")} title={t("wordEditor.downloadCopy")} disabled={!ready || saving} onClick={() => void download()}>
					<Download size={14} /><span className="inno-filebar-action-label">{t("wordEditor.downloadCopy")}</span>
				</Button>
				<Button variant="ghost" size="xs" aria-label={t("wordEditor.back")} title={t("wordEditor.back")} disabled={saving} onClick={requestClose}>
					<X size={14} /><span className="inno-filebar-action-label">{t("wordEditor.back")}</span>
				</Button>
			</WorkspaceFileBar>
			{error ? <div role="alert" className="inno-word-notice"><span>{error}</span>{!documentBytes ? <Button size="xs" onClick={() => setAttempt((value) => value + 1)}>{t("wordEditor.retry")}</Button> : null}</div> : null}
			{fontWarning ? <div role="status" className="inno-word-notice" data-font-error-code={fontFailureCode} data-font-error-detail={fontFailureDetail}>{t("wordEditor.fontWarning")}</div> : null}
			<div className="inno-word-stage" aria-busy={loading}>
			{/* Loading must overlay the engine: a flex sibling consumed half the
			    pane while onReady was pending and pushed its toolbar downward. */}
			{documentBytes ? <DocxEditor
				ref={editorRef}
				className="inno-word-docx"
				document={documentBytes}
				fonts={fonts}
				fontShaping={FONT_SHAPING}
				mode="edit"
				colorMode={theme}
				i18n={i18n.language.startsWith("zh") ? zhCN : undefined}
				locale={i18n.language}
				menu={false}
				onReady={onReady}
				onChange={markDirty}
				onFontError={onFontError}
			/> : null}
			{loading && !error ? <div role="status" className="inno-word-loading"><Spinner size={18} />{t("wordEditor.loading")}</div> : null}
			</div>
			{confirmClose ? <Dialog scoped label={t("wordEditor.closeTitle")} className="inno-word-confirm-dialog" onClose={() => setConfirmClose(false)}><div className="inno-word-confirm-card flex flex-col gap-5 p-6"><div><h2 className="text-base font-medium">{t("wordEditor.closeTitle")}</h2><p className="mt-2 text-sm text-[var(--inno-text-muted)]">{t("wordEditor.closeMessage")}</p></div><div className="flex flex-wrap justify-end gap-2"><Button size="sm" disabled={saving} onClick={() => setConfirmClose(false)}>{t("wordEditor.continueEditing")}</Button><Button size="sm" disabled={saving} onClick={onClose}>{t("wordEditor.discard")}</Button><Button variant="primary" size="sm" disabled={saving} onClick={() => { void save().then((clean) => { if (clean) onClose(); else setConfirmClose(false); }); }}>{saving ? <Spinner size={14} /> : <Save size={14} />}{t("wordEditor.saveAndClose")}</Button></div></div></Dialog> : null}
		</section>;
});

export default WordEditor;
