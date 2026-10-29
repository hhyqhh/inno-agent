/**
 * XlsxEditor — WYSIWYG xlsx editing in the preview pane, powered by Univer
 * (Apache-2.0). Loaded lazily with its presets; xlsx bytes cross the
 * ExcelJS ↔ Univer boundary in univer-xlsx.ts (values, formulas, merges,
 * column widths and the common cell styles — charts and images are not
 * serialized back to xlsx).
 *
 * The shared file bar owns the Save / back-to-preview actions; this editor
 * exposes them through OfficeEditorHandle and reports readiness.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { saveWorkspaceFileBinary } from "../../api/workspace.js";
import { excelJsToUniver, univerSnapshotToXlsxBytes, type UniverWorkbookData } from "./univer-xlsx.js";
import type { OfficeEditorHandle, OfficeEditorProps } from "./office-editor-handle.js";

interface UniverHandles {
	save: () => UniverWorkbookData | null;
	dispose: () => void;
}

const XlsxEditor = forwardRef<OfficeEditorHandle, OfficeEditorProps>(function XlsxEditor({ file, onReadyChange, onInteract }, ref) {
	const { i18n } = useTranslation();
	// Locale changes must not recreate the engine and discard its draft.
	const language = useRef(i18n.language).current;
	const callbacks = useRef({ onReadyChange, onInteract });
	callbacks.current = { onReadyChange, onInteract };
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
				// Unit creation is complete; immediately track subsequent sheet edits.
				// A timer here discarded real edits made just after opening a workbook.
				const dirtyDisposable = univerAPI.addEvent(univerAPI.Event.CommandExecuted, (eventParams) => {
					const isUserMutation = eventParams.type === CommandType.MUTATION
						&& !eventParams.id.startsWith("formula.mutation.")
						&& !eventParams.id.startsWith("doc.mutation.");
					if (isUserMutation) callbacks.current.onInteract?.();
				});
				handlesRef.current = {
					save: () => {
						const workbook = univerAPI.getActiveWorkbook();
						return (workbook?.save() ?? null) as UniverWorkbookData | null;
					},
					dispose: () => {
						themeObserver.disconnect();
						dirtyDisposable.dispose();
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
		};
	}, [file.url, file.name, language]);

	useImperativeHandle(ref, () => ({
		save: async () => {
			try {
				const snapshot = handlesRef.current?.save();
				if (!snapshot) throw new Error("No workbook snapshot");
				const bytes = await univerSnapshotToXlsxBytes(snapshot, file.name);
				const query = file.url?.split("?")[1] ?? "";
				const wsId = new URLSearchParams(query).get("workspaceId") ?? undefined;
				await saveWorkspaceFileBinary(file.path, bytes, wsId);
				return true;
			} catch (err) {
				setError(err instanceof Error ? err.message : "Save failed");
				return false;
			}
		},
	}), [file.path, file.url, file.name]);

	return (
		<div className="flex h-full min-h-0 flex-col">
			{error ? <div className="border-b border-[var(--inno-border)] px-3 py-2 text-xs text-[var(--inno-danger)]">{error}</div> : null}
			<div ref={hostRef} className="min-h-0 flex-1 overflow-hidden" />
		</div>
	);
});

export default XlsxEditor;
