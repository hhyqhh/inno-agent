import { memo, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { ChevronRight, Copy } from "lucide-react";
import type { ChatTraceStep } from "../../types/chat.js";
import { MarkdownArtifact } from "../MarkdownArtifact.js";
import { Button, IconButton, TabPanel, Tabs, getTabTriggerId } from "../ui/index.js";
import { isOpenStatus, safeJson } from "../../utils/chat-trace.js";
import { TraceCollapsible, useBottomFollowingScroll } from "./trace-motion.js";
import { textFromToolPayload, workspaceChangeLabel } from "./trace-format.js";

function DetailPayload({ label, value }: { label: string; value: unknown }) {
	const content = safeJson(value);
	if (!content) return null;
	return (
		<div className="inno-trace-detail-block">
			<div className="inno-trace-detail-label">{label}</div>
			<pre className="inno-trace-payload">{content}</pre>
		</div>
	);
}

/** Measure wrapping as well as newlines so narrow chat columns also get a
 * full-text action. Re-measure streaming text without pinning its height. */
function TraceTextPreview({ text, thinking = false, t }: { text: string; thinking?: boolean; t: TFunction }) {
	const id = useId();
	const body = useRef<HTMLDivElement>(null);
	const [expanded, setExpanded] = useState(false);
	const [overflows, setOverflows] = useState(false);
	useLayoutEffect(() => {
		const element = body.current;
		if (!element || expanded) return;
		const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [text, expanded]);
	return (
		<div className="inno-trace-text-preview">
			<div ref={body} id={id} className={`inno-trace-readable ${thinking ? "inno-trace-thinking" : ""} ${expanded ? "is-expanded" : "is-clipped"}`}>
				{thinking ? <MarkdownArtifact content={text} compact /> : text}
			</div>
			{overflows || expanded ? (
				<Button variant="ghost" size="xs" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(!expanded)}>
					{expanded ? t("chat.trace.details.collapseText", "收起全文") : t("chat.trace.details.expandText", "展开全文")}
				</Button>
			) : null}
		</div>
	);
}

/**
 * ZCode-aligned thinking body:
 * - Max-height scroll viewport with bottom-following auto-scroll and top/bottom
 *   24px fade mask.
 * - Renders plain pre-wrap text while streaming (avoiding per-chunk Markdown
 *   reparse jank), then renders MarkdownArtifact once settled to satisfy
 *   design.md's Markdown semantics requirement.
 */
function ThinkingTraceDetails({ step, expanded, t }: { step: ChatTraceStep; expanded: boolean; t: TFunction }) {
	const isLive = isOpenStatus(step.status);
	const text = step.text ?? "";
	// Only follow the bottom while actively streaming; settled thinking opens at the top.
	const scroll = useBottomFollowingScroll(expanded, text, isLive);
	if (!text) {
		return <span className="inno-trace-empty">{t("chat.trace.details.noThinkingText", "暂无思考文本")}</span>;
	}
	return (
		<div
			ref={scroll.scrollRef}
			className="inno-trace-thinking-scroll"
			data-scroll-mask={scroll.maskData}
			onScroll={scroll.onScroll}
			style={scroll.maskStyle}
		>
			<div ref={scroll.contentRef} className={`inno-trace-readable inno-trace-thinking ${isLive ? "is-live-plain" : ""}`}>
				{isLive ? text : <MarkdownArtifact content={text} compact />}
			</div>
		</div>
	);
}

function RawToolPayload({ step, t }: { step: ChatTraceStep; t: TFunction }) {
	const id = useId();
	const entries = [
		{ value: "arguments", label: t("chat.trace.details.arguments", "参数"), content: safeJson(step.args ?? step.argsText) },
		{ value: "partial", label: t("chat.trace.details.partialResult", "实时结果"), content: safeJson(step.partialResult) },
		{ value: "result", label: step.isError || step.status === "error" ? t("chat.trace.details.error", "错误") : t("chat.trace.details.result", "结果"), content: safeJson(step.result) },
		{ value: "question", label: t("chat.trace.details.question", "提问"), content: safeJson(step.questionParams) },
	].filter((entry) => Boolean(entry.content));
	const [selected, setSelected] = useState("arguments");
	const [full, setFull] = useState(false);
	const [copyStatus, setCopyStatus] = useState("");
	const active = entries.find((entry) => entry.value === selected) ?? entries[0];
	useEffect(() => { setCopyStatus(""); }, [active?.value, active?.content]);
	useEffect(() => { setFull(false); }, [active?.value]);
	if (!active) return null;
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(active.content);
			setCopyStatus(t("chat.trace.details.copied", "已复制"));
		} catch {
			setCopyStatus(t("chat.trace.details.copyFailed", "复制失败，请选择文本复制"));
		}
	};
	return (
		<div className="inno-trace-raw-panel">
			<div className="inno-trace-raw-toolbar">
				<Tabs id={id} value={active.value} onValueChange={setSelected} items={entries} size="compact" ariaLabel={t("chat.trace.details.rawData", "原始数据")} />
				<div className="inno-trace-raw-actions">
					<IconButton size="xs" aria-label={t("chat.trace.details.copy", "复制原始数据")} title={t("chat.trace.details.copy", "复制原始数据")} onClick={copy}><Copy size={14} /></IconButton>
					<Button variant="ghost" size="xs" aria-expanded={full} aria-controls={`${id}-panel`} onClick={() => setFull(!full)}>
						{full ? t("chat.trace.details.collapseText", "收起全文") : t("chat.trace.details.expandText", "展开全文")}
					</Button>
				</div>
			</div>
			{copyStatus ? <span className="inno-trace-copy-status" role="status">{copyStatus}</span> : null}
			<TabPanel id={`${id}-panel`} labelledBy={getTabTriggerId(id, active.value)}>
				<pre className={`inno-trace-payload ${full ? "is-expanded" : ""}`}>{active.content}</pre>
			</TabPanel>
		</div>
	);
}

function ToolTraceDetails({ step, t }: { step: ChatTraceStep; t: TFunction }) {
	const id = useId();
	const [showRaw, setShowRaw] = useState(false);
	// Prefer the final output: retaining partial and final JSON side by side
	// duplicated tool output and made a single expanded row fill the chat.
	const output = step.result ?? step.partialResult;
	const isError = step.isError || step.status === "error";
	// Error-only objects may have no content[].text; keep their actual
	// diagnostic visible without making the user open the raw-data panel.
	const text = textFromToolPayload(output) ?? (isError && output != null ? safeJson(output) : undefined);
	const hasPayload = [step.args, step.argsText, step.partialResult, step.result, step.questionParams].some((value) => value != null && value !== "");
	return (
		<div className={`inno-trace-tool-details ${isError ? "has-error" : ""}`}>
			{text?.trim() ? <div>
				<div className="inno-trace-detail-label">{isError ? t("chat.trace.details.error", "错误") : step.result != null ? t("chat.trace.details.result", "结果") : t("chat.trace.details.partialResult", "实时结果")}</div>
				<TraceTextPreview text={text} t={t} />
			</div> : <span className="inno-trace-empty">{output != null ? t("chat.trace.details.structuredResult", "返回了结构化数据，可查看原始数据") : t("chat.trace.details.noResult", "暂无结果")}</span>}
			{step.workspaceChanges?.length ? <ul className="inno-trace-change-list" aria-label={t("chat.trace.details.workspaceChanges", "工作区变化")}>
				{step.workspaceChanges.map((change) => <li key={`${change.change}:${change.path}`}>{workspaceChangeLabel(change.change, t)} · {change.path}</li>)}
			</ul> : null}
			{hasPayload ? <div className="inno-trace-raw-disclosure">
				<Button variant="ghost" size="xs" aria-expanded={showRaw} aria-controls={id} onClick={() => setShowRaw(!showRaw)}>
					<ChevronRight size={14} className={`inno-trace-chevron ${showRaw ? "is-open" : ""}`} aria-hidden="true" />
					{t("chat.trace.details.rawData", "原始数据")}
				</Button>
				{step.toolName ? <code className="inno-trace-tool-name">{step.toolName}</code> : null}
			</div> : null}
			<TraceCollapsible open={showRaw} id={id}>
				<div className="inno-trace-raw-collapse-pad">
					<RawToolPayload step={step} t={t} />
				</div>
			</TraceCollapsible>
		</div>
	);
}

export const TraceDetails = memo(function TraceDetails({
	step,
	expanded,
	onOpenSkill,
	t,
}: {
	step: ChatTraceStep;
	expanded: boolean;
	onOpenSkill?: (skillName: string) => void;
	t: TFunction;
}) {
	if (step.kind === "thinking") {
		return <ThinkingTraceDetails step={step} expanded={expanded} t={t} />;
	}
	if (step.kind === "progress") {
		return step.text
			? <MarkdownArtifact content={step.text} />
			: <span className="inno-trace-empty">{t("chat.trace.details.noProgressText", "暂无进度文本")}</span>;
	}
	if (step.kind === "tool") {
		return <ToolTraceDetails step={step} t={t} />;
	}
	if (step.kind === "skill") {
		return (
			<div className="inno-trace-skill-details">
				{step.skillName ? <div><span className="inno-trace-detail-label">{t("chat.trace.details.skill", "技能")}</span>{step.skillName}</div> : null}
				{step.skillSource ? <div><span className="inno-trace-detail-label">{t("chat.trace.details.source", "来源")}</span>{step.skillSource}</div> : null}
				{step.skillPath ? <div className="break-all"><span className="inno-trace-detail-label">{t("chat.trace.details.path", "路径")}</span>{step.skillPath}</div> : null}
				{step.skillDescription ? <div><span className="inno-trace-detail-label">{t("chat.trace.details.description", "说明")}</span>{step.skillDescription}</div> : null}
				{step.skillArgs ? <DetailPayload label={t("chat.trace.details.arguments", "参数")} value={step.skillArgs} /> : null}
				{step.skillName && onOpenSkill ? (
					<button type="button" className="inno-trace-open-skill" onClick={() => onOpenSkill(step.skillName!)}>
						{t("chat.trace.details.openSkillsPanel", "打开 Skills 面板")}
					</button>
				) : null}
				{step.skillState === "loaded" && step.eventDetail ? <DetailPayload label={t("chat.trace.details.preloadedSkills", "已预载技能")} value={step.eventDetail} /> : null}
			</div>
		);
	}
	if (step.kind === "system") {
		return (
			<div className="inno-trace-system-details">
				{step.eventType ? <div><span className="inno-trace-detail-label">{t("chat.trace.details.piEvent", "PI 事件")}</span>{step.eventType}</div> : null}
				{step.attempt !== undefined ? <div><span className="inno-trace-detail-label">{t("chat.trace.details.attempt", "尝试")}</span>{step.attempt}</div> : null}
				<DetailPayload label={t("chat.trace.details.details", "详情")} value={step.eventDetail} />
			</div>
		);
	}
	return step.text ? <pre className="inno-trace-error-details">{step.text}</pre> : null;
});
