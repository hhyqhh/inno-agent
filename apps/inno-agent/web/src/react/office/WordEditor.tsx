import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { DocxEditor, LocaleProvider, type DocxEditorRef } from "@betteroffice/docx-react";
import { zhCN } from "@betteroffice/docx-i18n";
import { Check, Download, RotateCcw, Save, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@betteroffice/docx-react/styles.css";
import { ApiError } from "../../api/client.js";
import { downloadWordCopy, openWordDocument, saveWordDocument } from "../../api/word-editor.js";
import type { WorkspaceFileDetail } from "../../types/workspace.js";
import { themeStore } from "../../stores/theme-store.js";
import { useStoreSnapshot } from "../hooks.js";
import { Button, Dialog, Spinner } from "../ui/index.js";
import { WorkspaceFileBar } from "../WorkspaceFileBar.js";
import { validateWordExport } from "./validate-word-export.js";
import { repairWordExport } from "./repair-word-export.js";
import { prepareVml } from "./prepare-vml.js";
import { createMathSession, type MathPreparation } from "./prepare-math.js";
import { watchImageOverlayPassthrough } from "./image-overlay-passthrough.js";
import { WordRibbon } from "./WordRibbon.js";
import { resolveSelectionFont } from "./selection-font.js";
import { configureWordFonts } from "./word-fonts.js";

// Keep browser rendering and WASM measurement on the same locally bundled faces.
// The optional fonts-cjk package supplies the Chinese glyphs; no CDN is involved.
// configureWordFonts wraps that source so bold CJK runs get real Bold outlines.
configureWordFonts();
const fontFamilies = ["宋体", "黑体", "微软雅黑", "仿宋", "楷体", "Times New Roman", "Arial", "Calibri"];

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
	const [document, setDocument] = useState<Uint8Array>();
	const [error, setError] = useState("");
	const [unsupportedVml, setUnsupportedVml] = useState(0);
	const [unsupportedMath, setUnsupportedMath] = useState(0);
	const [attempt, setAttempt] = useState(0);
	const [ready, setReady] = useState(false);
	const [saving, setSaving] = useState(false);
	const [dirty, setDirty] = useState(false);
	const [savedAt, setSavedAt] = useState("");
	const [confirmClose, setConfirmClose] = useState(false);
	const [rulers, setRulers] = useState(false);
	const [outline, setOutline] = useState(false);
	// Script-aware font-box label (east-Asian font on a CJK caret); null keeps
	// the engine's flattened ASCII-slot value.
	const [fontDisplay, setFontDisplay] = useState<string | null>(null);
	const displayedFont = useRef<string | null>(null);
	const editor = useRef<DocxEditorRef | null>(null);
	const rootRef = useRef<HTMLElement | null>(null);
	const mathSession = useRef<MathPreparation | null>(null);
	const version = useRef("");
	const revision = useRef(0);
	const savedRevision = useRef(0);
	const pendingSave = useRef<Promise<boolean> | null>(null);

	useEffect(() => {
		const controller = new AbortController();
		setError(""); setReady(false); setDocument(undefined); setUnsupportedVml(0); setUnsupportedMath(0); mathSession.current = null;
		displayedFont.current = null; setFontDisplay(null);
		void openWordDocument(file.path, workspaceId, controller.signal).then(async (result) => {
			if (controller.signal.aborted) return;
			const prepared = prepareVml(result.bytes);
			try {
				// Math keeps the document editable (the engine round-trips OMML), so a
				// typesetting failure only degrades display back to the plain-text view.
				const math = await createMathSession(prepared.bytes);
				if (controller.signal.aborted) return;
				mathSession.current = math;
				version.current = result.version;
				setUnsupportedVml(prepared.unsupported); setUnsupportedMath(math.unsupported); setDocument(math.bytes);
			} catch {
				if (controller.signal.aborted) return;
				version.current = result.version;
				setUnsupportedVml(prepared.unsupported); setDocument(prepared.bytes);
			}
		}).catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof ApiError ? String(cause.data?.code || cause.message) : "WORD_EDITOR_UNAVAILABLE"); });
		return () => { controller.abort(); editor.current = null; mathSession.current = null; };
	}, [file.path, workspaceId, attempt]);

	const save = useCallback((): Promise<boolean> => {
		if (pendingSave.current) return pendingSave.current;
		if (!editor.current || !ready || unsupportedVml) return Promise.resolve(false);
		const instance = editor.current;
		setSaving(true);
		const operation = (async () => {
			try {
				// BetterOffice queues input, including IME composition. Capture the
				// saved revision after that input commits, so the last Chinese word is included.
				await instance.flushPendingInput();
				const savingRevision = revision.current;
				const bytes = await instance.save();
				if (!bytes) throw new Error("Document is not ready");
				// BetterOffice 0.4.3 exports a duplicate markup-compatibility Ignorable
				// attribute that strict parsers reject; repair before the validator so
				// a fixable export can still reach the server's single save entry.
				const repaired = repairWordExport(bytes);
				// Put the original OMML back in place of the rendered placeholder
				// pictures so the saved file keeps formulas alive for Word/WPS — the
				// engine displays them but cannot serialize math on its own terms.
				const exportBytes = mathSession.current ? mathSession.current.restore(repaired) : repaired;
				validateWordExport(exportBytes);
				const result = await saveWordDocument(file.path, workspaceId, version.current, new Uint8Array(exportBytes));
				version.current = result.version;
				savedRevision.current = savingRevision;
				// Typing can continue during serialization/network IO. Only the captured
				// revision is committed; newer edits must keep their unsaved indicator.
				const clean = revision.current === savingRevision;
				setDirty(!clean); setSavedAt(result.savedAt); setError("");
				return clean;
			} catch (cause) {
				setError(cause instanceof ApiError ? String(cause.data?.code || cause.message) : cause instanceof Error && cause.message === "WORD_EDITOR_INVALID_EXPORT" ? cause.message : "WORD_EDITOR_SAVE_FAILED");
				return false;
			} finally { setSaving(false); pendingSave.current = null; }
		})();
		pendingSave.current = operation;
		return operation;
	}, [file.path, workspaceId, ready, unsupportedVml]);

	// The tab-close guard in WorkspaceBrowser checks dirtiness and triggers the
	// save flow without cycling through this component's own confirm dialog.
	useImperativeHandle(ref, () => ({ isDirty: () => dirty, save }), [dirty, save]);

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

	// Selecting a full-page behind-text background image blankets its page with
	// the overlay's grab-drag layer; keep that layer pointer-inert so body text
	// keeps its text cursor and its clicks (rationale in the helper module).
	const editorMounted = document !== undefined;
	useEffect(() => {
		const root = rootRef.current;
		if (!editorMounted || !root) return;
		return watchImageOverlayPassthrough(root);
	}, [editorMounted]);

	// The engine's selection state flattens rFonts to one Latin family, so the
	// font box needs the Yrs session view to show the east-Asian font on a CJK
	// caret. Only pushes state when the resolved name actually changes — this
	// fires on every caret move.
	const handleSelectionChange = useCallback(() => {
		const name = resolveSelectionFont(editor.current);
		if (name !== displayedFont.current) {
			displayedFont.current = name;
			setFontDisplay(name);
		}
	}, []);

	const requestClose = () => { if (!saving) { if (dirty) setConfirmClose(true); else onClose(); } };
	const download = async () => {
		if (unsupportedVml) return;
		try { const bytes = await editor.current?.save(); if (bytes) { const repaired = repairWordExport(bytes); const exportBytes = mathSession.current ? mathSession.current.restore(repaired) : repaired; validateWordExport(exportBytes); downloadWordCopy(file.name, exportBytes); } else setError("WORD_EDITOR_SAVE_FAILED"); }
		catch (cause) { setError(cause instanceof Error && cause.message === "WORD_EDITOR_INVALID_EXPORT" ? cause.message : "WORD_EDITOR_SAVE_FAILED"); }
	};
	const message = error === "WORD_EDITOR_CONFLICT" ? "conflict" : error === "WORD_EDITOR_TOO_LARGE" ? "tooLarge"
		: error === "WORD_EDITOR_DOCX_REQUIRED" ? "docxRequired" : error === "WORD_EDITOR_FILE_MISSING" ? "fileMissing"
		: error === "WORD_EDITOR_INVALID_EXPORT" ? "invalidExport" : error === "WORD_EDITOR_SAVE_FAILED" ? "saveFailed" : error === "WORD_EDITOR_COMMAND_FAILED" ? "commandFailed" : "unavailable";
	const savedTime = savedAt ? new Date(savedAt).toLocaleTimeString(i18n.language, { hour: "2-digit", minute: "2-digit" }) : "";
	// The editor's context menu reads labels from the library's LocaleProvider
	// context, but the sync editor route never mounts one, so passing only the
	// i18n prop left that menu stuck in English. Provide it explicitly; the prop
	// stays for the table submenu labels, which still read it directly.
	const wordI18n = i18n.language.startsWith("zh") ? zhCN : undefined;

	return <section ref={rootRef} className="inno-word-editor" data-color-mode={theme}>
			<WorkspaceFileBar name={file.name} path={file.path}>
				<span role="status" className="inno-word-save-state">{saving ? <><Spinner size={14} />{t("wordEditor.saving")}</> : dirty ? t("wordEditor.unsaved") : ready ? <><Check size={14} />{savedTime ? t("wordEditor.lastSaved", { time: savedTime }) : t("wordEditor.saved")}</> : null}</span>
				<Button variant="ghost" size="xs" aria-label={t("wordEditor.save")} title={t("wordEditor.saveShortcut")} disabled={!ready || saving || !!unsupportedVml} onClick={() => void save()}>
					<Save size={14} /><span className="inno-filebar-action-label">{t("wordEditor.save")}</span>
				</Button>
				<Button variant="ghost" size="xs" aria-label={t("wordEditor.downloadCopy")} title={t("wordEditor.downloadCopy")} disabled={!ready || saving || !!unsupportedVml} onClick={() => void download()}>
					<Download size={14} /><span className="inno-filebar-action-label">{t("wordEditor.downloadCopy")}</span>
				</Button>
				<Button variant="ghost" size="xs" aria-label={t("wordEditor.back")} title={t("wordEditor.back")} disabled={saving} onClick={requestClose}>
					<X size={14} /><span className="inno-filebar-action-label">{t("wordEditor.back")}</span>
				</Button>
			</WorkspaceFileBar>
			{unsupportedVml ? <div role="alert" className="inno-word-notice">{t("wordEditor.unsupportedVml", { count: unsupportedVml })}</div> : null}
			{unsupportedMath > 0 ? <div role="status" className="inno-word-notice">{t("wordEditor.unsupportedMath", { count: unsupportedMath })}</div> : null}
			{error ? <div role="alert" className="inno-word-notice"><span>{t(`wordEditor.${message}`)}</span>{!document ? <Button size="xs" onClick={() => setAttempt((value) => value + 1)}><RotateCcw size={14} />{t("wordEditor.retry")}</Button> : null}{ready && error !== "WORD_EDITOR_INVALID_EXPORT" ? <Button size="xs" onClick={() => void download()}>{t("wordEditor.downloadCopy")}</Button> : null}</div> : null}
			{document ? <LocaleProvider i18n={wordI18n}><DocxEditor ref={editor} documentBuffer={document} mode={unsupportedVml ? "viewing" : "editing"} colorMode={theme} i18n={wordI18n}
				// Pin the in-thread engine: dirty/revision tracking rides on onChange,
				// which the 0.5+ async editor removed. Revisit when migrating.
				experimentalWorkerOpen={false}
				className="inno-betteroffice" fontFamilies={fontFamilies} showFileOpen={false} showHelpMenu={false} downloadOnSave={false}
				commentsSidebarOpen={false} showRuler={rulers} rulerUnit="cm" showOutline={outline} showOutlineButton={false}
				onFirstPagePainted={() => setReady(true)} onSaveRequest={async () => { await save(); }}
				onError={() => setError("WORD_EDITOR_UNAVAILABLE")}
				onSelectionChange={handleSelectionChange}
				onChange={() => { revision.current++; setDirty(revision.current !== savedRevision.current); }}
				toolbar={<WordRibbon rulers={rulers} onRulersChange={() => setRulers((value) => !value)} outline={outline} onOutlineChange={() => setOutline((value) => !value)} fontDisplay={fontDisplay} onError={() => setError("WORD_EDITOR_COMMAND_FAILED")} />}
			/></LocaleProvider> : !error ? <div role="status" className="flex flex-1 items-center justify-center gap-2 text-sm text-[var(--inno-text-muted)]"><Spinner size={18} />{t("wordEditor.loading")}</div> : <div className="flex flex-1 items-center justify-center text-sm text-[var(--inno-text-muted)]">{t("wordEditor.cannotOpen")}</div>}
		{confirmClose ? <Dialog scoped label={t("wordEditor.closeTitle")} className="inno-word-confirm-dialog" onClose={() => setConfirmClose(false)}><div className="inno-word-confirm-card flex flex-col gap-5 p-6"><div><h2 className="text-base font-medium">{t("wordEditor.closeTitle")}</h2><p className="mt-2 text-sm text-[var(--inno-text-muted)]">{t("wordEditor.closeMessage")}</p></div><div className="flex flex-wrap justify-end gap-2"><Button size="sm" disabled={saving} onClick={() => setConfirmClose(false)}>{t("wordEditor.continueEditing")}</Button><Button size="sm" disabled={saving} onClick={onClose}>{t("wordEditor.discard")}</Button><Button variant="primary" size="sm" disabled={saving} onClick={() => { void save().then((clean) => { if (clean) onClose(); else setConfirmClose(false); }); }}>{saving ? <Spinner size={14} /> : <Save size={14} />}{t("wordEditor.saveAndClose")}</Button></div></div></Dialog> : null}
	</section>;
});

export default WordEditor;

