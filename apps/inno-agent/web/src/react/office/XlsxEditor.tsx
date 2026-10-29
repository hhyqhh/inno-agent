/** Univer edits are patched into the original OOXML package; the import is only a view. */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { excelJsToUniver, type UniverWorkbookData } from "./univer-xlsx.js";
import { preserveXlsx } from "./office-ooxml.js";
import type { OfficeEditorHandle, OfficeEditorProps } from "./office-editor-handle.js";

interface UniverHandles {
	save: () => UniverWorkbookData | null;
	dispose: () => void;
	inputColor: () => string;
}

const XlsxEditor = forwardRef<OfficeEditorHandle, OfficeEditorProps>(function XlsxEditor({ file, onReadyChange, onInteract }, ref) {
	const { i18n, t } = useTranslation();
	// Locale changes must not recreate the engine and discard its draft.
	const language = useRef(i18n.language).current;
	const callbacks = useRef({ onReadyChange, onInteract });
	callbacks.current = { onReadyChange, onInteract };
	const tRef = useRef(t);
	tRef.current = t;
	const source = useRef<{ bytes: Uint8Array; baseline: UniverWorkbookData } | null>(null);
	const hostRef = useRef<HTMLDivElement | null>(null);
	const handlesRef = useRef<UniverHandles | null>(null);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");

	useEffect(() => {
		let cancelled = false;
		let noticeTimer: ReturnType<typeof setTimeout> | undefined;
		const clearNotice = () => {
			clearTimeout(noticeTimer);
			setNotice("");
		};
		const notifyUnsupported = () => {
			clearNotice();
			setNotice(tRef.current("officeEditor.unsupportedCommand"));
			// A refused action is temporary feedback, not a workbook load error.
			noticeTimer = setTimeout(() => setNotice(""), 4_000);
		};
		clearNotice();
		callbacks.current.onReadyChange?.(false);
		setError("");
		(async () => {
			try {
				const res = await fetch(file.url ?? "");
				if (!res.ok) throw new Error(`Failed to load workbook (${res.status})`);
				const buf = await res.arrayBuffer();
				const exceljsModule = await import("exceljs");
				const ExcelJS = exceljsModule.default ?? exceljsModule;
				const wb = new ExcelJS.Workbook();
				await wb.xlsx.load(buf);
				const snapshot = excelJsToUniver(wb, file.name);

				const { createUniver, LocaleType, UniverInstanceType, CommandType } = await import("@univerjs/presets");
				const { UniverSheetsCorePreset } = await import("@univerjs/preset-sheets-core");
				const localeKey = language.startsWith("zh") ? LocaleType.ZH_CN : LocaleType.EN_US;
				const localePack = localeKey === LocaleType.ZH_CN
					? (await import("@univerjs/preset-sheets-core/locales/zh-CN")).default
					: (await import("@univerjs/preset-sheets-core/locales/en-US")).default;
				await import("@univerjs/preset-sheets-core/lib/index.css");
				if (cancelled || !hostRef.current) return;

				const { univer, univerAPI } = createUniver({
					locale: localeKey,
					locales: { [localeKey]: localePack },
					presets: [
						UniverSheetsCorePreset({
							container: hostRef.current,
						}),
					],
				});
				univer.createUnit(UniverInstanceType.UNIVER_SHEET, snapshot as never);
				// Theme changes update the mounted engine and retain its draft.
				const syncTheme = () => univerAPI.toggleDarkMode(document.documentElement.dataset.theme === "dark");
				syncTheme();
				const themeObserver = new MutationObserver(syncTheme);
				themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
				source.current = { bytes: new Uint8Array(buf), baseline: structuredClone(univerAPI.getActiveWorkbook()!.save()) as UniverWorkbookData };
				// Row/column moves can change drawing and formula references that
				// the import omits. Cancel these mutations before they alter a draft.
				const limitDisposable = univerAPI.addEvent(univerAPI.Event.BeforeCommandExecute, (event) => {
					const changesStructure = event.type === CommandType.MUTATION && event.id.startsWith("sheet.mutation.") && event.id !== "sheet.mutation.set-range-values";
					const pasteValues = event.id === "sheet.command.paste-value" || event.id === "univer.command.paste" && (event.params as { value?: string } | undefined)?.value === "special-paste-value";
					// Runtime input/selection emits set-input-style; Univer's handler
					// only updates DocMenuStyleService's cache, not worksheet formatting.
					const inputStyleCache = event.id === "doc.command.set-input-style";
					const changesFormatting = !inputStyleCache && !pasteValues && (event.id === "univer.command.paste" || /^(sheet|doc)\.command\./.test(event.id) && /(style|font|format|color|align|border|wrap|merge|paste)/.test(event.id));
					if (changesStructure || changesFormatting) {
						event.cancel = true;
						notifyUnsupported();
					}
				});
				// Unit creation is complete; immediately track subsequent sheet edits.
				// A timer here discarded real edits made just after opening a workbook.
				const dirtyDisposable = univerAPI.addEvent(univerAPI.Event.CommandExecuted, (eventParams) => {
					const isUserMutation = eventParams.type === CommandType.MUTATION
						&& !eventParams.id.startsWith("formula.mutation.")
						&& !eventParams.id.startsWith("doc.mutation.");
					if (isUserMutation) { clearNotice(); callbacks.current.onInteract?.(); }
				});
				handlesRef.current = {
					inputColor: () => univerAPI.getCurrentTheme().gray[900],
					save: () => {
						const workbook = univerAPI.getActiveWorkbook();
						return (workbook?.save() ?? null) as UniverWorkbookData | null;
					},
					dispose: () => {
						themeObserver.disconnect();
						dirtyDisposable.dispose();
						limitDisposable.dispose();
						try { univerAPI.dispose(); } catch { /* best effort */ }
						try { univer.dispose(); } catch { /* best effort */ }
					},
				};
				if (!cancelled) callbacks.current.onReadyChange?.(true);
			} catch (err) {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			}
		})();
		return () => {
			cancelled = true;
			clearTimeout(noticeTimer);
			handlesRef.current?.dispose();
			handlesRef.current = null;
			source.current = null;
		};
	}, [file.url, file.name, language]);

	useImperativeHandle(ref, () => ({
		exportBytes: async () => {
			const snapshot = handlesRef.current?.save();
			if (!snapshot || !source.current) throw new Error("No workbook snapshot");
			return preserveXlsx(source.current.bytes, source.current.baseline, snapshot, handlesRef.current!.inputColor());
		},
	}), [file.path, file.url, file.name]);

	return (
		<div className="flex h-full min-h-0 flex-col">
			{notice ? <div role="status" className="border-b border-[var(--inno-border)] px-3 py-2 text-xs text-[var(--inno-warning)]">{notice}</div> : null}
			{error ? <div role="alert" className="border-b border-[var(--inno-border)] px-3 py-2 text-xs text-[var(--inno-danger)]">{error}</div> : null}
			<div ref={hostRef} className="min-h-0 flex-1 overflow-hidden" />
		</div>
	);
});

export default XlsxEditor;
