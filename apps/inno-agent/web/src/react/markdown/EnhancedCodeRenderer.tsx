import {
	Check,
	ChevronDown,
	ChevronUp,
	Copy,
	Download,
	Maximize2,
	Minimize2,
	Pencil,
	Play,
	RotateCcw,
	Save,
	WrapText,
} from "lucide-react";
import { Fragment, useCallback, useContext, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { CodeBlock, StreamdownContext, type CustomRendererProps } from "streamdown";
import { terminalStore } from "../../stores/terminal-store.js";
import { downloadBlob, ToolbarIconButton, useFullscreenDialog } from "./shared.js";

const LANGUAGE_EXTENSIONS: Record<string, string> = {
	bash: "sh", shell: "sh", sh: "sh", zsh: "sh",
	c: "c", cpp: "cpp", "c++": "cpp", csharp: "cs", "c#": "cs", cs: "cs",
	css: "css", go: "go", html: "html", java: "java", javascript: "js", js: "js", jsx: "jsx",
	json: "json", jsonc: "jsonc", kotlin: "kt", markdown: "md", md: "md", php: "php",
	python: "py", py: "py", ruby: "rb", rust: "rs", sql: "sql", swift: "swift",
	typescript: "ts", ts: "ts", tsx: "tsx", xml: "xml", yaml: "yaml", yml: "yaml",
};

function codeFilename(language: string): string {
	return `inno-code.${LANGUAGE_EXTENSIONS[language.toLowerCase()] ?? "txt"}`;
}

function runPython(source: string): void {
	// Ship the source as file content instead of an inlined `python -c`
	// one-liner: the server rejects commands over 4096 chars, which any
	// realistic snippet exceeds after base64 inflation. The server writes the
	// file into the terminal's cwd before starting the run.
	terminalStore.runCommand("python model_reply.py", "model_reply.py", source);
}

function countLines(source: string): number {
	let lines = 1;
	for (let i = 0; i < source.length; i += 1) {
		if (source[i] === "\n") lines += 1;
	}
	return lines;
}

export function EnhancedCodeRenderer({ code, language, isIncomplete }: CustomRendererProps) {
	const { t } = useTranslation();
	const streamdownContext = useContext(StreamdownContext);
	// null = pristine: follow the streaming `code` prop directly. Storing the
	// streamed source in state and re-syncing it in an effect leaves one
	// committed render per chunk where state !== code, which flashes the
	// "restore original" button in the header on every stream flush.
	const [editedSource, setEditedSource] = useState<string | null>(null);
	const [draft, setDraft] = useState(code);
	const [editing, setEditing] = useState(false);
	const [wrapped, setWrapped] = useState(false);
	const [expanded, setExpanded] = useState(() => countLines(code) <= 16);
	const [fullscreen, setFullscreen] = useState(false);
	const [copied, setCopied] = useState(false);
	const canRun = /^(?:python|py)$/i.test(language) && !isIncomplete;
	const source = editedSource ?? code;
	// The length check short-circuits before the line scan for short snippets;
	// both avoid allocating a per-line array on every streaming re-render.
	const expandable = source.length > 1800 || countLines(source) > 16;

	useFullscreenDialog(fullscreen, useCallback(() => setFullscreen(false), []));

	const handleCopy = async () => {
		await navigator.clipboard.writeText(editing ? draft : source);
		setCopied(true);
		setTimeout(() => setCopied(false), 1600);
	};

	const actions = (
		<Fragment>
			{canRun ? <ToolbarIconButton label={t("markdown.runPython", "在练习终端运行 Python")} onClick={() => runPython(source)}><Play size={14} /></ToolbarIconButton> : null}
			{editing ? (
				<ToolbarIconButton label={t("markdown.applyChanges", "应用更改")} onClick={() => { setEditedSource(draft); setEditing(false); }}><Save size={14} /></ToolbarIconButton>
			) : (
				<ToolbarIconButton label={t("markdown.editCopy", "编辑副本")} disabled={isIncomplete} onClick={() => { setDraft(source); setEditing(true); }}><Pencil size={14} /></ToolbarIconButton>
			)}
			{editedSource !== null && editedSource !== code ? <ToolbarIconButton label={t("markdown.restoreOriginal", "恢复模型原文")} onClick={() => { setEditedSource(null); setDraft(code); setEditing(false); }}><RotateCcw size={14} /></ToolbarIconButton> : null}
			<ToolbarIconButton label={t("markdown.wrapText", "自动换行")} active={wrapped} onClick={() => setWrapped((value) => !value)}><WrapText size={14} /></ToolbarIconButton>
			{expandable ? <ToolbarIconButton label={expanded ? t("markdown.collapseCode", "折叠代码") : t("markdown.expandCode", "展开代码")} active={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</ToolbarIconButton> : null}
			<ToolbarIconButton label={copied ? t("markdown.copied", "已复制") : t("markdown.copyCode", "复制代码")} onClick={() => void handleCopy()}>{copied ? <Check size={14} /> : <Copy size={14} />}</ToolbarIconButton>
			<ToolbarIconButton label={t("markdown.downloadCode", "下载代码")} onClick={() => downloadBlob(codeFilename(language), new Blob([editing ? draft : source], { type: "text/plain;charset=utf-8" }))}><Download size={14} /></ToolbarIconButton>
			<ToolbarIconButton label={t("markdown.fullscreen", "全屏查看")} onClick={() => setFullscreen(true)}><Maximize2 size={14} /></ToolbarIconButton>
		</Fragment>
	);

	const resolvedContext = useMemo(() => ({
		...streamdownContext,
		codeBlockMaxHeight: expanded ? Infinity : 350,
	}), [expanded, streamdownContext]);

	const renderedCode = (forceExpanded = false) => (
		<StreamdownContext.Provider value={forceExpanded ? { ...resolvedContext, codeBlockMaxHeight: Infinity } : resolvedContext}>
			<div data-inno-code-block="" data-wrap={wrapped ? "true" : "false"} className={wrapped ? "inno-code-wrap" : ""}>
				<CodeBlock code={source} language={language || "text"} isIncomplete={isIncomplete} lineNumbers>{actions}</CodeBlock>
			</div>
		</StreamdownContext.Provider>
	);

	return (
		<Fragment>
			{editing ? (
				<div data-inno-code-block="" className="my-4 overflow-hidden rounded-xl border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] p-2">
					<div className="flex h-8 items-center gap-2 px-1 text-xs text-[var(--inno-text-muted)]">
						<span className="min-w-0 flex-1 truncate font-mono lowercase">{language || "text"} · {t("markdown.editCopy", "编辑副本")}</span>
						{actions}
					</div>
					<textarea value={draft} onChange={(event) => setDraft(event.target.value)} spellCheck={false} className="min-h-64 w-full resize-y rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] p-3 font-mono text-xs leading-relaxed text-[var(--inno-text)] outline-none" />
				</div>
			) : renderedCode()}

			{fullscreen && typeof document !== "undefined" ? createPortal(
				<div role="dialog" aria-modal="true" aria-label={t("markdown.codeFullscreen", "代码全屏查看")} className="fixed inset-0 z-[1000] flex flex-col bg-[var(--inno-background)]">
					<div className="flex items-center border-b border-[var(--inno-border)] bg-[var(--inno-surface)] px-4 py-2">
						<span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--inno-text-muted)]">{language || "text"}</span>
						<ToolbarIconButton label={t("markdown.exitFullscreen", "退出全屏")} onClick={() => setFullscreen(false)}><Minimize2 size={16} /></ToolbarIconButton>
					</div>
					<div className="min-h-0 flex-1 overflow-auto p-3">{renderedCode(true)}</div>
				</div>,
				document.body,
			) : null}
		</Fragment>
	);
}
