import { Check, Copy, FileSpreadsheet, Maximize2, X } from "lucide-react";
import { type ComponentProps, useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { extractTableDataFromElement, tableDataToMarkdown, type ExtraProps } from "streamdown";
import { downloadBlob, ToolbarIconButton, useFullscreenDialog } from "./shared.js";

type EnhancedTableProps = ComponentProps<"table"> & ExtraProps;

async function copyRichTable(table: HTMLTableElement): Promise<void> {
	const data = extractTableDataFromElement(table);
	const markdown = tableDataToMarkdown(data);
	if (typeof ClipboardItem !== "undefined" && navigator.clipboard.write) {
		await navigator.clipboard.write([
			new ClipboardItem({
				"text/plain": new Blob([markdown], { type: "text/plain" }),
				"text/html": new Blob([table.outerHTML], { type: "text/html" }),
			}),
		]);
		return;
	}
	await navigator.clipboard.writeText(markdown);
}

async function exportExcel(table: HTMLTableElement): Promise<void> {
	const { headers, rows } = extractTableDataFromElement(table);
	const xlsx = await import("xlsx");
	const worksheet = xlsx.utils.aoa_to_sheet(headers.length ? [headers, ...rows] : rows);
	const workbook = xlsx.utils.book_new();
	xlsx.utils.book_append_sheet(workbook, worksheet, "Table");
	const bytes = xlsx.write(workbook, { bookType: "xlsx", type: "array" });
	downloadBlob("inno-table.xlsx", new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
}

export function EnhancedTable({ children, className, node: _node, ...props }: EnhancedTableProps) {
	const { t } = useTranslation();
	const tableRef = useRef<HTMLTableElement>(null);
	const fullscreenTableRef = useRef<HTMLTableElement>(null);
	const [copied, setCopied] = useState(false);
	const [fullscreen, setFullscreen] = useState(false);
	const [exporting, setExporting] = useState(false);

	useFullscreenDialog(fullscreen, useCallback(() => setFullscreen(false), []));

	const handleCopy = async (table = tableRef.current) => {
		if (!table) return;
		await copyRichTable(table);
		setCopied(true);
		setTimeout(() => setCopied(false), 1600);
	};

	const handleExport = async (table = tableRef.current) => {
		if (!table || exporting) return;
		setExporting(true);
		try {
			await exportExcel(table);
		} finally {
			setExporting(false);
		}
	};

	const table = (ref: typeof tableRef) => (
		<table ref={ref} data-streamdown="table" className={`w-full min-w-full divide-y divide-[var(--inno-border)] border-collapse ${className ?? ""}`} {...props}>
			{children}
		</table>
	);

	return (
		<>
			<div data-streamdown="table-wrapper" className="group/table relative my-4 min-w-0">
				<div className="absolute right-2 top-2 z-10 flex items-center gap-1 rounded-md border border-[var(--inno-border)] bg-[color-mix(in_srgb,var(--inno-surface)_92%,transparent)] p-0.5 opacity-0 shadow-sm backdrop-blur-sm transition-opacity group-hover/table:opacity-100 focus-within:opacity-100">
					<ToolbarIconButton label={copied ? t("markdown.copied", "已复制") : t("markdown.copyRichText", "复制为富文本")} onClick={() => void handleCopy()}>{copied ? <Check size={14} /> : <Copy size={14} />}</ToolbarIconButton>
					<ToolbarIconButton label={exporting ? t("markdown.exportingExcel", "正在导出 Excel") : t("markdown.exportExcel", "导出 Excel")} onClick={() => void handleExport()}><FileSpreadsheet size={14} /></ToolbarIconButton>
					<ToolbarIconButton label={t("markdown.tableFullscreen", "全屏查看表格")} onClick={() => setFullscreen(true)}><Maximize2 size={14} /></ToolbarIconButton>
				</div>
				<div className="max-h-[26rem] overflow-auto rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)]">
					{table(tableRef)}
				</div>
			</div>

			{fullscreen && typeof document !== "undefined" ? createPortal(
				<div role="dialog" aria-modal="true" aria-label={t("markdown.tableFullscreenTitle", "表格全屏查看")} className="fixed inset-0 z-[1000] flex flex-col bg-[var(--inno-background)]">
					<div className="flex items-center justify-end gap-1 border-b border-[var(--inno-border)] bg-[var(--inno-surface)] px-4 py-2">
						<ToolbarIconButton label={t("markdown.copyRichText", "复制为富文本")} onClick={() => void handleCopy(fullscreenTableRef.current)}><Copy size={15} /></ToolbarIconButton>
						<ToolbarIconButton label={t("markdown.exportExcel", "导出 Excel")} onClick={() => void handleExport(fullscreenTableRef.current)}><FileSpreadsheet size={15} /></ToolbarIconButton>
						<ToolbarIconButton label={t("markdown.exitFullscreen", "退出全屏")} onClick={() => setFullscreen(false)}><X size={17} /></ToolbarIconButton>
					</div>
					<div className="min-h-0 flex-1 overflow-auto p-4">{table(fullscreenTableRef)}</div>
				</div>,
				document.body,
			) : null}
		</>
	);
}
