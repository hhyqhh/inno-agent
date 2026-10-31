/** Export the complete current Univer workbook through ExcelJS. */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { excelJsToUniver, univerSnapshotToXlsxBytes, type UniverWorkbookData } from "./univer-xlsx.js";
import type { OfficeEditorHandle, OfficeEditorProps } from "./office-editor-handle.js";

interface UniverHandles {
	save: () => Promise<UniverWorkbookData | null>;
	dispose: () => void;
}

const XlsxEditor = forwardRef<OfficeEditorHandle, OfficeEditorProps>(function XlsxEditor({ file, onReadyChange, onInteract }, ref) {
	const { i18n } = useTranslation();
	// Locale changes must not recreate the engine and discard its draft.
	const language = useRef(i18n.language).current;
	const callbacks = useRef({ onReadyChange, onInteract });
	callbacks.current = { onReadyChange, onInteract };
	const source = useRef<{ bytes: Uint8Array; baseline: UniverWorkbookData } | null>(null);
	const hostRef = useRef<HTMLDivElement | null>(null);
	const handlesRef = useRef<UniverHandles | null>(null);
	const [error, setError] = useState("");

	useEffect(() => {
		let cancelled = false;
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
                source.current = { bytes: new Uint8Array(buf), baseline: structuredClone(snapshot) };
                let committing = false;
                // The old pre-command filter cancelled formatting, paste and
                // structural edits even though ExcelJS can export the model.
				// Unit creation is complete; immediately track subsequent sheet edits.
				// A timer here discarded real edits made just after opening a workbook.
				const dirtyDisposable = univerAPI.addEvent(univerAPI.Event.CommandExecuted, (eventParams) => {
					const isUserMutation = eventParams.type === CommandType.MUTATION
						&& eventParams.id.startsWith("sheet.mutation.")
						&& !committing;
					if (isUserMutation) callbacks.current.onInteract?.();
				});
				// Document mutations also populate the formula bar and reset its
				// editor on commit. Only visible cell-input changes dirty the draft;
				// finalizing that same input during Save is not another user edit.
				const editDisposable = univerAPI.addEvent(univerAPI.Event.SheetEditChanging, () => {
					if (!committing) callbacks.current.onInteract?.();
				});
				handlesRef.current = {
					save: async () => {
						const workbook = univerAPI.getActiveWorkbook();
						// Commit the active cell before taking the snapshot so Cmd+S
                        // includes the last character without needing Enter.
                        committing = true;
                        try { await workbook?.endEditingAsync?.(true); } finally { committing = false; }
                        return (workbook?.save() ?? null) as UniverWorkbookData | null;
					},
					dispose: () => {
						themeObserver.disconnect();
						dirtyDisposable.dispose();
						editDisposable.dispose();
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
			handlesRef.current?.dispose();
			handlesRef.current = null;
			source.current = null;
		};
	}, [file.url, file.name, language]);

	useImperativeHandle(ref, () => ({
		getSourceBytes: () => {
			if (!source.current) throw new Error("No original workbook");
			return source.current.bytes;
		},
		exportBytes: async () => {
			const snapshot = await handlesRef.current?.save();
			if (!snapshot || !source.current) throw new Error("No workbook snapshot");
			return univerSnapshotToXlsxBytes(snapshot, file.name, source.current);
		},
	}), [file.path, file.url, file.name]);

	return (
		<div className="flex h-full min-h-0 flex-col">
			{error ? <div role="alert" className="border-b border-[var(--inno-border)] px-3 py-2 text-xs text-[var(--inno-danger)]">{error}</div> : null}
			<div ref={hostRef} className="min-h-0 flex-1 overflow-hidden" />
		</div>
	);
});

export default XlsxEditor;
