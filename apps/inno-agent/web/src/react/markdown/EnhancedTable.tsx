import { Check, Copy, FileSpreadsheet, Maximize2, MoreHorizontal } from "lucide-react";
import { type ComponentProps, useContext, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { extractTableDataFromElement, StreamdownContext, tableDataToMarkdown, type ExtraProps } from "streamdown";
import {
	MarkdownFullscreenDialog,
	MarkdownToolbar,
	MarkdownToolbarGroup,
	ToolbarIconButton,
	ToolbarMenu,
	ToolbarMenuItem,
	markdownControlEnabled,
	downloadBlob,
	markdownMaxHeight,
	markdownToolbarEnabled,
} from "./shared.js";

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
	const streamdownContext = useContext(StreamdownContext);
	const toolbarEnabled = markdownToolbarEnabled(streamdownContext.controls, "table");
	const copyEnabled = markdownControlEnabled(streamdownContext.controls, "table", "copy");
	const downloadEnabled = markdownControlEnabled(streamdownContext.controls, "table", "download");
	const fullscreenEnabled = markdownControlEnabled(streamdownContext.controls, "table", "fullscreen");
	const tableRef = useRef<HTMLTableElement>(null);
	const fullscreenTableRef = useRef<HTMLTableElement>(null);
	const moreId = `inno-table-more-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
	const [copied, setCopied] = useState(false);
	const [fullscreen, setFullscreen] = useState(false);
	const [moreOpen, setMoreOpen] = useState(false);
	const [exporting, setExporting] = useState(false);

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

	const renderTable = (ref: typeof tableRef) => (
		<table ref={ref} data-streamdown="table" className={`inno-markdown-table${className ? ` ${className}` : ""}`} {...props}>
			{children}
		</table>
	);

	const maxHeight = markdownMaxHeight(streamdownContext.tableMaxHeight);
	return (
		<>
			<div data-streamdown="table-wrapper" data-inno-content-block="table" className="inno-markdown-content-block inno-markdown-content-block--table">
				<div className="inno-markdown-content-header">
					<span className="inno-markdown-content-title">{t("markdown.tableLabel", "表格")}</span>
					{toolbarEnabled ? (
						<MarkdownToolbar label={t("markdown.tableTools", "表格工具")}>
							<MarkdownToolbarGroup>
								{copyEnabled ? <ToolbarIconButton label={copied ? t("markdown.copied", "已复制") : t("markdown.copyRichText", "复制为富文本")} showLabel onClick={() => void handleCopy()}>
									{copied ? <Check size={14} /> : <Copy size={14} />}
								</ToolbarIconButton> : null}
								{downloadEnabled || fullscreenEnabled ? (
									<div className="inno-markdown-toolbar-menu-anchor">
										<ToolbarIconButton label={t("markdown.moreTools", "更多")} showLabel menu expanded={moreOpen} aria-controls={moreId} onClick={() => setMoreOpen((value) => !value)}>
											<MoreHorizontal size={14} />
										</ToolbarIconButton>
										<ToolbarMenu id={moreId} open={moreOpen} onClose={() => setMoreOpen(false)} label={t("markdown.moreTools", "更多")}>
											{downloadEnabled ? <ToolbarMenuItem label={exporting ? t("markdown.exportingExcel", "正在导出 Excel") : t("markdown.exportExcel", "导出 Excel")} disabled={exporting} onClick={() => void handleExport()}>
												<FileSpreadsheet size={14} />
											</ToolbarMenuItem> : null}
											{fullscreenEnabled ? <ToolbarMenuItem label={t("markdown.tableFullscreen", "全屏查看表格")} onClick={() => setFullscreen(true)}><Maximize2 size={14} /></ToolbarMenuItem> : null}
										</ToolbarMenu>
									</div>
								) : null}
							</MarkdownToolbarGroup>
						</MarkdownToolbar>
					) : null}
				</div>
				<div className="inno-markdown-table-scroll" style={maxHeight ? { maxHeight } : undefined}>{renderTable(tableRef)}</div>
			</div>

			<MarkdownFullscreenDialog
			open={fullscreen}
			title={t("markdown.tableLabel", "表格")}
			ariaLabel={t("markdown.tableFullscreenTitle", "表格全屏查看")}
				closeLabel={t("markdown.exitFullscreen", "退出全屏")}
				onClose={() => setFullscreen(false)}
				actions={toolbarEnabled && (copyEnabled || downloadEnabled) ? (
					<MarkdownToolbar label={t("markdown.tableTools", "表格工具")}>
							{copyEnabled ? <ToolbarIconButton label={copied ? t("markdown.copied", "已复制") : t("markdown.copyRichText", "复制为富文本")} showLabel onClick={() => void handleCopy(fullscreenTableRef.current)}>
							{copied ? <Check size={14} /> : <Copy size={14} />}
						</ToolbarIconButton> : null}
							{downloadEnabled ? <ToolbarIconButton label={exporting ? t("markdown.exportingExcel", "正在导出 Excel") : t("markdown.exportExcel", "导出 Excel")} showLabel disabled={exporting} onClick={() => void handleExport(fullscreenTableRef.current)}><FileSpreadsheet size={14} /></ToolbarIconButton> : null}
					</MarkdownToolbar>
				) : null}
			>
				<div data-inno-content-block="table" className="inno-markdown-table-scroll inno-markdown-table-scroll--fullscreen">{renderTable(fullscreenTableRef)}</div>
			</MarkdownFullscreenDialog>
		</>
	);
}
