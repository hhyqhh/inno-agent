import {
	Check,
	ChevronDown,
	ChevronUp,
	Copy,
	Download,
	Maximize2,
	MoreHorizontal,
	Pencil,
	Play,
	RotateCcw,
	Save,
	WrapText,
} from "lucide-react";
import { code as codeHighlighter, type HighlightResult } from "@streamdown/code";
import { Fragment, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { CodeBlockContainer, StreamdownContext, type CustomRendererProps } from "streamdown";
import { terminalStore } from "../../stores/terminal-store.js";
import { settingsStore } from "../../stores/settings-store.js";
import { useStoreSnapshot } from "../hooks.js";
import {
	MarkdownFullscreenDialog,
	MarkdownToolbar,
	MarkdownToolbarGroup,
	ToolbarIconButton,
	ToolbarMenu,
	ToolbarMenuItem,
	markdownControlEnabled,
	markdownMaxHeight,
	markdownToolbarEnabled,
	downloadBlob,
} from "./shared.js";

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

function trimTrailingNewlines(source: string): string {
	let end = source.length;
	while (end > 0 && source[end - 1] === "\n") end -= 1;
	return source.slice(0, end);
}

function rawHighlightResult(source: string): HighlightResult {
	return {
		bg: "transparent",
		fg: "inherit",
		tokens: source.split("\n").map((line) => [{ content: line, color: "inherit", bgColor: "transparent", htmlStyle: {}, offset: 0 }]),
	};
}

function tokenStyle(token: HighlightResult["tokens"][number][number]): CSSProperties {
	const style = {} as CSSProperties;
	const customProperties = style as CSSProperties & Record<string, string>;
	if (token.color) customProperties["--sdm-c"] = token.color;
	if (token.bgColor) customProperties["--sdm-tbg"] = token.bgColor;
	for (const [property, value] of Object.entries(token.htmlStyle ?? {}) as [string, string][]) {
		if (property === "color") customProperties["--sdm-c"] = value;
		else if (property === "background-color") customProperties["--sdm-tbg"] = value;
		else customProperties[property] = value;
	}
	return style;
}

function rootStyle(result: HighlightResult): CSSProperties {
	const style = {} as CSSProperties;
	const customProperties = style as CSSProperties & Record<string, string>;
	if (result.bg) customProperties["--sdm-bg"] = result.bg;
	if (result.fg) customProperties["--sdm-fg"] = result.fg;
	if (typeof result.rootStyle === "string") {
		for (const declaration of result.rootStyle.split(";")) {
			const separator = declaration.indexOf(":");
			if (separator <= 0) continue;
			const property = declaration.slice(0, separator).trim();
			const value = declaration.slice(separator + 1).trim();
			if (property && value) customProperties[property] = value;
		}
	}
	return style;
}

/**
 * Streamdown's CodeBlock lazy-loads its highlighted body. On a cold start that
 * means React first mounts one body through Suspense, then replaces it with a
 * second body after the highlighter chunk arrives. Keep the body mounted and
 * update only its token children so that the first highlight cannot cause a
 * one-frame code-block resize.
 */
function StableCodeBlockBody({ code, language }: { code: string; language: string }) {
	const streamdownContext = useContext(StreamdownContext);
	const bodyRef = useRef<HTMLDivElement>(null);
	const stickToBottomRef = useRef(true);
	const normalizedCode = useMemo(() => trimTrailingNewlines(code), [code]);
	const rawResult = useMemo(() => rawHighlightResult(normalizedCode), [normalizedCode]);
	const maxHeight = markdownMaxHeight(streamdownContext.codeBlockMaxHeight);
	const themeKey = streamdownContext.shikiTheme.map((theme) => typeof theme === "string" ? theme : theme.name ?? "").join("\u0000");
	const requestKey = `${language}\u0000${themeKey}\u0000${normalizedCode}`;
	const [highlighted, setHighlighted] = useState<{ key: string; result: HighlightResult } | null>(null);

	useLayoutEffect(() => {
		let active = true;
		const options = {
			code: normalizedCode,
			language: language as Parameters<typeof codeHighlighter.highlight>[0]["language"],
			themes: streamdownContext.shikiTheme as Parameters<typeof codeHighlighter.highlight>[0]["themes"],
		};
		const applyResult = (result: HighlightResult) => {
			if (active) setHighlighted({ key: requestKey, result });
		};
		const immediate = codeHighlighter.highlight(options, (result) => applyResult(result as HighlightResult));
		if (immediate) applyResult(immediate as HighlightResult);
		return () => {
			active = false;
		};
	}, [language, normalizedCode, requestKey, streamdownContext.shikiTheme]);

	const result = highlighted?.key === requestKey ? highlighted.result : rawResult;
	const codeClassName = streamdownContext.lineNumbers ? "[counter-increment:line_0] [counter-reset:line]" : undefined;
	const lineClassName = streamdownContext.lineNumbers
		? "block before:content-[counter(line)] before:inline-block before:[counter-increment:line] before:w-6 before:mr-4 before:text-[13px] before:text-right before:text-muted-foreground/50 before:font-mono before:select-none"
		: "block";

	useEffect(() => {
		const body = bodyRef.current;
		if (!body || !maxHeight) return;
		const updateStickiness = () => {
			stickToBottomRef.current = body.scrollHeight - body.scrollTop - body.clientHeight < 8;
		};
		body.addEventListener("scroll", updateStickiness, { passive: true });
		return () => body.removeEventListener("scroll", updateStickiness);
	}, [maxHeight]);

	useEffect(() => {
		const body = bodyRef.current;
		if (!body || !maxHeight || !streamdownContext.isAnimating || !stickToBottomRef.current) return;
		body.scrollTo({ top: body.scrollHeight, behavior: "instant" });
	}, [maxHeight, normalizedCode, result, streamdownContext.isAnimating]);

	return (
		<div
			ref={bodyRef}
			className={`overflow-x-auto rounded-md border border-border bg-background p-4 text-sm${maxHeight ? " overflow-y-auto" : ""}`}
			data-streamdown="code-block-body"
			data-language={language}
			data-inno-code-body=""
			style={maxHeight ? { maxHeight } : undefined}
		>
			<pre className="bg-[var(--sdm-bg,inherit)] dark:bg-[var(--shiki-dark-bg,var(--sdm-bg,inherit))]" style={rootStyle(result)}>
				<code className={codeClassName}>
					{result.tokens.map((line, lineIndex) => (
						<span key={lineIndex} className={lineClassName}>
							{line.length === 0 || line.length === 1 && line[0].content === ""
								? "\n"
								: line.map((token, tokenIndex) => (
									<span
										key={tokenIndex}
										className={`text-[var(--sdm-c,inherit)] dark:text-[var(--shiki-dark,var(--sdm-c,inherit))]${token.bgColor ? " bg-[var(--sdm-tbg)] dark:bg-[var(--shiki-dark-bg,var(--sdm-tbg))]" : ""}`}
										style={tokenStyle(token)}
										{...token.htmlAttrs}
									>
										{token.content}
									</span>
								))}
						</span>
					))}
				</code>
			</pre>
		</div>
	);
}

interface CodeToolbarProps {
	moreOpen: boolean;
	moreId: string;
	editing: boolean;
	canRun: boolean;
	isIncomplete: boolean;
	copyEnabled: boolean;
	downloadEnabled: boolean;
	fullscreenEnabled: boolean;
	expandable: boolean;
	expanded: boolean;
	wrapped: boolean;
	copied: boolean;
	isFullscreen: boolean;
	hasEditedSource: boolean;
	onToggleMore: () => void;
	onCloseMore: () => void;
	onRun: () => void;
	onApply: () => void;
	onEdit: () => void;
	onRestore: () => void;
	onWrap: () => void;
	onExpand: () => void;
	onCopy: () => void | Promise<void>;
	onDownload: () => void;
	onFullscreen: () => void;
}

function CodeToolbar({
	moreOpen,
	moreId,
	editing,
	canRun,
	isIncomplete,
	copyEnabled,
	downloadEnabled,
	fullscreenEnabled,
	expandable,
	expanded,
	wrapped,
	copied,
	isFullscreen,
	hasEditedSource,
	onToggleMore,
	onCloseMore,
	onRun,
	onApply,
	onEdit,
	onRestore,
	onWrap,
	onExpand,
	onCopy,
	onDownload,
	onFullscreen,
}: CodeToolbarProps) {
	const { t } = useTranslation();
	// Keep the header useful: copy, run, and editing are primary actions with
	// labels. Wrapping, exporting, and fullscreen stay behind More.
	const canEdit = !isIncomplete && !isFullscreen;
	const canDownload = downloadEnabled && !isIncomplete;
	const canFullscreen = fullscreenEnabled && !isFullscreen && !isIncomplete && !editing;
	// Wrapping is always available in the More menu once the fence is complete.
	const hasMoreActions = !isIncomplete;
	const hasActions = copyEnabled || canRun || hasMoreActions;
	if (!hasActions) return null;

	return (
		<MarkdownToolbar label={t("markdown.codeTools", "代码工具")}>
			<MarkdownToolbarGroup>
				{copyEnabled ? <ToolbarIconButton label={copied ? t("markdown.copied", "已复制") : t("markdown.copyCode", "复制代码")} showLabel onClick={onCopy}>
					{copied ? <Check size={14} /> : <Copy size={14} />}
				</ToolbarIconButton> : null}
				{canRun ? <ToolbarIconButton label={t("markdown.runCode", "运行代码")} showLabel onClick={onRun}><Play size={14} /></ToolbarIconButton> : null}
				{canEdit ? (
					<ToolbarIconButton
						label={editing ? t("markdown.applyChanges", "应用更改") : t("markdown.editCopy", "编辑副本")}
						showLabel
						onClick={editing ? onApply : onEdit}
					>
						{editing ? <Save size={14} /> : <Pencil size={14} />}
					</ToolbarIconButton>
				) : null}
				{hasMoreActions ? <div className="inno-markdown-toolbar-menu-anchor">
					<ToolbarIconButton
						label={t("markdown.moreTools", "更多")}
						showLabel
						menu
						expanded={moreOpen}
						aria-controls={moreId}
						onClick={onToggleMore}
					>
						<MoreHorizontal size={14} />
					</ToolbarIconButton>
					<ToolbarMenu id={moreId} open={moreOpen} onClose={onCloseMore} label={t("markdown.moreTools", "更多")}>
						{expandable ? (
							<ToolbarMenuItem label={expanded ? t("markdown.collapseCode", "折叠代码") : t("markdown.expandCode", "展开代码")} onClick={onExpand}>
								{expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
							</ToolbarMenuItem>
						) : null}
						<ToolbarMenuItem label={wrapped ? t("markdown.disableWrapText", "取消自动换行") : t("markdown.wrapText", "自动换行")} onClick={onWrap}>
							<WrapText size={14} />
						</ToolbarMenuItem>
						{hasEditedSource ? <ToolbarMenuItem label={t("markdown.restoreOriginal", "恢复模型原文")} onClick={onRestore}><RotateCcw size={14} /></ToolbarMenuItem> : null}
						{canDownload ? <ToolbarMenuItem label={t("markdown.downloadCode", "下载代码")} onClick={onDownload}><Download size={14} /></ToolbarMenuItem> : null}
						{canFullscreen ? <ToolbarMenuItem label={t("markdown.fullscreen", "全屏查看")} onClick={onFullscreen}><Maximize2 size={14} /></ToolbarMenuItem> : null}
					</ToolbarMenu>
				</div> : null}
			</MarkdownToolbarGroup>
		</MarkdownToolbar>
	);
}

export function EnhancedCodeRenderer({ code, language, isIncomplete }: CustomRendererProps) {
	const { t } = useTranslation();
	const streamdownContext = useContext(StreamdownContext);
	const toolbarEnabled = markdownToolbarEnabled(streamdownContext.controls, "code");
	const copyEnabled = markdownControlEnabled(streamdownContext.controls, "code", "copy");
	const downloadEnabled = markdownControlEnabled(streamdownContext.controls, "code", "download");
	const fullscreenEnabled = markdownControlEnabled(streamdownContext.controls, "code", "fullscreen");
	const moreId = `inno-code-more-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
	const fullscreenMoreId = `${moreId}-fullscreen`;
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
	const [moreOpen, setMoreOpen] = useState(false);
	const [copied, setCopied] = useState(false);
	// "Run code" feeds the practice terminal, which Simple Mode hides; without
	// this gate the click would queue a run into a drawer that never renders.
	const simpleMode = useStoreSnapshot(settingsStore, () => settingsStore.settings?.simpleMode?.enabled === true);
	const canRun = !simpleMode && /^(?:python|py)$/i.test(language) && !isIncomplete && !editing;
	const source = editedSource ?? code;
	// The length check short-circuits before the line scan for short snippets;
	// both avoid allocating a per-line array on every streaming re-render.
	const expandable = source.length > 1800 || countLines(source) > 16;

	useEffect(() => setMoreOpen(false), [code, isIncomplete]);

	const handleCopy = async () => {
		await navigator.clipboard.writeText(editing ? draft : source);
		setCopied(true);
		setTimeout(() => setCopied(false), 1600);
	};

	const handleDownload = () => {
		downloadBlob(codeFilename(language), new Blob([editing ? draft : source], { type: "text/plain;charset=utf-8" }));
	};

	const handleEdit = () => {
		setDraft(source);
		setEditing(true);
	};

	const handleApply = () => {
		setEditedSource(draft);
		setEditing(false);
	};

	const handleRestore = () => {
		setEditedSource(null);
		setDraft(code);
		setEditing(false);
	};

	const handleFullscreen = () => {
		setMoreOpen(false);
		setFullscreen(true);
	};

	const renderToolbar = (toolbarMoreId: string, isFullscreen = false) => toolbarEnabled ? (
		<CodeToolbar
			moreOpen={moreOpen}
			moreId={toolbarMoreId}
			editing={editing}
			canRun={canRun}
			isIncomplete={isIncomplete}
			copyEnabled={copyEnabled}
			downloadEnabled={downloadEnabled}
			fullscreenEnabled={fullscreenEnabled}
			expandable={expandable}
			expanded={expanded}
			wrapped={wrapped}
			copied={copied}
			isFullscreen={isFullscreen}
			onToggleMore={() => setMoreOpen((value) => !value)}
			onCloseMore={() => setMoreOpen(false)}
			onRun={() => runPython(source)}
			onApply={handleApply}
			onEdit={handleEdit}
			onRestore={handleRestore}
			onWrap={() => setWrapped((value) => !value)}
			onExpand={() => setExpanded((value) => !value)}
			onCopy={() => void handleCopy()}
			onDownload={handleDownload}
			onFullscreen={handleFullscreen}
			hasEditedSource={editedSource !== null && editedSource !== code}
		/>
	) : null;
	const toolbar = renderToolbar(moreId);

	const resolvedContext = useMemo(() => ({
		...streamdownContext,
		codeBlockMaxHeight: expanded ? Infinity : streamdownContext.codeBlockMaxHeight,
	}), [expanded, streamdownContext]);

	const renderedCode = (forceExpanded = false, withToolbar = true) => (
		<StreamdownContext.Provider value={forceExpanded ? { ...resolvedContext, codeBlockMaxHeight: Infinity } : resolvedContext}>
			<div data-inno-code-block="" data-inno-content-block="code" data-wrap={wrapped ? "true" : "false"} className={wrapped ? "inno-code-wrap" : ""}>
				<CodeBlockContainer dir="ltr" language={language || "text"} isIncomplete={isIncomplete}>
					<div data-streamdown="code-block-header" data-language={language || "text"} className="inno-markdown-content-header">
						<span className="inno-markdown-content-title">{language || "text"}</span>
						{isIncomplete ? <span className="inno-markdown-content-status"><span className="inno-markdown-content-status-dot" />{t("markdown.generating", "生成中")}</span> : null}
						{withToolbar ? renderToolbar(forceExpanded ? fullscreenMoreId : moreId, forceExpanded) : null}
					</div>
					<StableCodeBlockBody code={source} language={language || "text"} />
				</CodeBlockContainer>
			</div>
		</StreamdownContext.Provider>
	);

	return (
		<Fragment>
			{editing ? (
				<div data-inno-code-block="" data-inno-content-block="code" data-inno-content-editing="" className="inno-markdown-content-block inno-markdown-content-block--code">
					<div className="inno-markdown-content-header">
						<span className="inno-markdown-content-title">{language || "text"} · {t("markdown.editCopy", "编辑副本")}</span>
						{toolbar}
					</div>
					<textarea value={draft} onChange={(event) => setDraft(event.target.value)} spellCheck={false} className="inno-markdown-code-editor" />
				</div>
			) : renderedCode()}

			<MarkdownFullscreenDialog
			open={fullscreen}
			title={language || "text"}
			ariaLabel={t("markdown.codeFullscreen", "代码全屏查看")}
				closeLabel={t("markdown.exitFullscreen", "退出全屏")}
				onClose={() => setFullscreen(false)}
				actions={toolbarEnabled ? renderToolbar(fullscreenMoreId, true) : null}
			>
				{renderedCode(true, false)}
			</MarkdownFullscreenDialog>
		</Fragment>
	);
}
