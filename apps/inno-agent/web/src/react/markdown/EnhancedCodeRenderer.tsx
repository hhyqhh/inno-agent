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
import { Fragment, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { CodeBlock, StreamdownContext, type CustomRendererProps } from "streamdown";
import { terminalStore } from "../../stores/terminal-store.js";

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

function downloadCode(language: string, source: string): void {
	const url = URL.createObjectURL(new Blob([source], { type: "text/plain;charset=utf-8" }));
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = codeFilename(language);
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
	setTimeout(() => URL.revokeObjectURL(url), 0);
}

function encodeUtf8Base64(value: string): string {
	const bytes = new TextEncoder().encode(value);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function runPython(source: string): void {
	const encoded = encodeUtf8Base64(source);
	const command = `python -c "import base64;exec(compile(base64.b64decode('${encoded}'),'model_reply.py','exec'))"`;
	terminalStore.runCommand(command, "model_reply.py");
}

function CodeAction({ label, active = false, disabled = false, onClick, children }: {
	label: string;
	active?: boolean;
	disabled?: boolean;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			disabled={disabled}
			onClick={onClick}
			className={`cursor-pointer rounded p-1 transition-colors ${active ? "bg-[var(--inno-accent-soft)] text-[var(--inno-accent)]" : "text-[var(--inno-text-muted)] hover:text-[var(--inno-text)]"} disabled:cursor-not-allowed disabled:opacity-40`}
		>
			{children}
		</button>
	);
}

export function EnhancedCodeRenderer({ code, language, isIncomplete }: CustomRendererProps) {
	const streamdownContext = useContext(StreamdownContext);
	const [source, setSource] = useState(code);
	const [draft, setDraft] = useState(code);
	const [editing, setEditing] = useState(false);
	const [wrapped, setWrapped] = useState(false);
	const [expanded, setExpanded] = useState(code.split("\n").length <= 16);
	const [fullscreen, setFullscreen] = useState(false);
	const [copied, setCopied] = useState(false);
	const canRun = /^(?:python|py)$/i.test(language) && !isIncomplete;
	const expandable = source.split("\n").length > 16 || source.length > 1800;

	useEffect(() => {
		if (editing) return;
		setSource(code);
		setDraft(code);
	}, [code, editing]);

	useEffect(() => {
		if (!fullscreen) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setFullscreen(false);
		};
		document.addEventListener("keydown", onKeyDown);
		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => {
			document.removeEventListener("keydown", onKeyDown);
			document.body.style.overflow = previousOverflow;
		};
	}, [fullscreen]);

	const handleCopy = async () => {
		await navigator.clipboard.writeText(editing ? draft : source);
		setCopied(true);
		setTimeout(() => setCopied(false), 1600);
	};

	const actions = (
		<Fragment>
			{canRun ? <CodeAction label="在练习终端运行 Python" onClick={() => runPython(source)}><Play size={14} /></CodeAction> : null}
			{editing ? (
				<CodeAction label="应用更改" onClick={() => { setSource(draft); setEditing(false); }}><Save size={14} /></CodeAction>
			) : (
				<CodeAction label="编辑副本" disabled={isIncomplete} onClick={() => { setDraft(source); setEditing(true); }}><Pencil size={14} /></CodeAction>
			)}
			{source !== code ? <CodeAction label="恢复模型原文" onClick={() => { setSource(code); setDraft(code); setEditing(false); }}><RotateCcw size={14} /></CodeAction> : null}
			<CodeAction label="自动换行" active={wrapped} onClick={() => setWrapped((value) => !value)}><WrapText size={14} /></CodeAction>
			{expandable ? <CodeAction label={expanded ? "折叠代码" : "展开代码"} active={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</CodeAction> : null}
			<CodeAction label={copied ? "已复制" : "复制代码"} onClick={() => void handleCopy()}>{copied ? <Check size={14} /> : <Copy size={14} />}</CodeAction>
			<CodeAction label="下载代码" onClick={() => downloadCode(language, editing ? draft : source)}><Download size={14} /></CodeAction>
			<CodeAction label="全屏查看" onClick={() => setFullscreen(true)}><Maximize2 size={14} /></CodeAction>
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
						<span className="min-w-0 flex-1 truncate font-mono lowercase">{language || "text"} · 编辑副本</span>
						{actions}
					</div>
					<textarea value={draft} onChange={(event) => setDraft(event.target.value)} spellCheck={false} className="min-h-64 w-full resize-y rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] p-3 font-mono text-xs leading-relaxed text-[var(--inno-text)] outline-none" />
				</div>
			) : renderedCode()}

			{fullscreen && typeof document !== "undefined" ? createPortal(
				<div role="dialog" aria-modal="true" aria-label="代码全屏查看" className="fixed inset-0 z-[1000] flex flex-col bg-[var(--inno-background)]">
					<div className="flex items-center border-b border-[var(--inno-border)] bg-[var(--inno-surface)] px-4 py-2">
						<span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--inno-text-muted)]">{language || "text"}</span>
						<CodeAction label="退出全屏" onClick={() => setFullscreen(false)}><Minimize2 size={16} /></CodeAction>
					</div>
					<div className="min-h-0 flex-1 overflow-auto p-3">{renderedCode(true)}</div>
				</div>,
				document.body,
			) : null}
		</Fragment>
	);
}
