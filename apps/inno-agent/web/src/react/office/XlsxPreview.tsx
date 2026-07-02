import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download } from "lucide-react";
import * as XLSX from "xlsx";
import type { WorkspaceFileDetail } from "../../types/workspace.js";
import { triggerDownload } from "../../api/workspace.js";

/** Cap rendered rows per sheet to avoid blowing up the DOM on huge sheets. */
const MAX_ROWS = 2000;

/**
 * Render a .xlsx workbook as HTML tables (client-side via SheetJS, no
 * LibreOffice). Multiple sheets get a tab strip. Mirrors pi-web-ui's
 * ExcelArtifact styling.
 */
export default function XlsxPreview({ file }: { file: WorkspaceFileDetail }) {
	const { t } = useTranslation();
	const [workbook, setWorkbook] = useState<XLSX.WorkBook | null>(null);
	const [active, setActive] = useState(0);
	const [truncated, setTruncated] = useState(false);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const tableRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!file.url) {
			setError(t("preview.xlsxFailed", "Failed to render spreadsheet"));
			setLoading(false);
			return;
		}
		let cancelled = false;
		setLoading(true);
		setError("");
		setWorkbook(null);
		setActive(0);
		(async () => {
			try {
				const res = await fetch(file.url as string);
				if (!res.ok) throw new Error(res.statusText);
				const buf = await res.arrayBuffer();
				if (cancelled) return;
				const wb = XLSX.read(buf, { type: "array" });
				if (!cancelled) setWorkbook(wb);
			} catch (e) {
				if (!cancelled) setError(e instanceof Error ? e.message : t("preview.xlsxFailed", "Failed to render spreadsheet"));
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();
		return () => { cancelled = true; };
	}, [file.url, t]);

	const sheetNames = workbook?.SheetNames ?? [];
	const activeName = sheetNames[active];

	const tableHtml = useMemo(() => {
		if (!workbook || !activeName) return "";
		const sheet = workbook.Sheets[activeName];
		if (!sheet) return "";
		// Trim the sheet range to MAX_ROWS so sheet_to_html can't explode.
		let wasTruncated = false;
		const ref = sheet["!ref"];
		let target = sheet;
		if (ref) {
			const range = XLSX.utils.decode_range(ref);
			if (range.e.r - range.s.r + 1 > MAX_ROWS) {
				range.e.r = range.s.r + MAX_ROWS - 1;
				target = { ...sheet, "!ref": XLSX.utils.encode_range(range) };
				wasTruncated = true;
			}
		}
		setTruncated(wasTruncated);
		return XLSX.utils.sheet_to_html(target, { id: `sheet-${activeName}` });
	}, [workbook, activeName]);

	useEffect(() => {
		const host = tableRef.current;
		if (!host) return;
		host.innerHTML = tableHtml;
		const table = host.querySelector("table");
		if (!table) return;
		table.className = "border-collapse text-[var(--inno-text)]";
		table.querySelectorAll("td, th").forEach((cell) => {
			(cell as HTMLElement).className = "border border-[var(--inno-border)] px-3 py-1.5 text-xs text-left whitespace-nowrap";
		});
		const headerCells = table.querySelectorAll("thead th, tr:first-child td");
		headerCells.forEach((th) => {
			(th as HTMLElement).className = "border border-[var(--inno-border)] px-3 py-1.5 text-xs font-semibold bg-[var(--inno-surface-muted)] text-[var(--inno-text)] sticky top-0";
		});
	}, [tableHtml]);

	const downloadOriginal = () => {
		if (file.url) triggerDownload(`${file.url}${file.url.includes("?") ? "&" : "?"}download=1`);
	};

	if (loading) {
		return <div className="flex h-full items-center justify-center text-sm text-[var(--inno-text-muted)]">{t("preview.xlsxLoading", "Rendering spreadsheet...")}</div>;
	}
	if (error) {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-[var(--inno-text-muted)]">
				<div className="font-medium text-[var(--inno-text)]">{file.name}</div>
				<div className="text-xs text-red-500">{error}</div>
				<button className="flex items-center gap-1 rounded-md border border-[var(--inno-border)] px-3 py-1.5 text-xs text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface)]" onClick={downloadOriginal}>
					<Download size={12} />
					{t("files.download", "Download")}
				</button>
			</div>
		);
	}

	return (
		<div className="flex h-full flex-col bg-[var(--inno-surface)]">
			{sheetNames.length > 1 ? (
				<div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--inno-border)] bg-[var(--inno-surface-muted)] px-2 py-1">
					{sheetNames.map((name, i) => (
						<button
							key={name}
							onClick={() => setActive(i)}
							className={`shrink-0 rounded px-2.5 py-1 text-xs ${i === active ? "bg-[var(--inno-surface)] font-medium text-[var(--inno-text)]" : "text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface)]"}`}
						>
							{name}
						</button>
					))}
				</div>
			) : null}
			{truncated ? (
				<div className="shrink-0 bg-amber-500/10 px-3 py-1 text-[11px] text-amber-600">
					{t("preview.xlsxLargeSheetWarning", "Large sheet — showing first {{n}} rows", { n: MAX_ROWS })}
				</div>
			) : null}
			<div className="workspace-scroll flex-1 overflow-auto p-3">
				<div ref={tableRef} />
			</div>
		</div>
	);
}
