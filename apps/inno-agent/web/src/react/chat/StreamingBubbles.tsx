import { Fragment, memo, useCallback, useMemo, useRef } from "react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import type { ChatToolRecord } from "../../types/chat.js";
import { chatStore } from "../../stores/chat-store.js";
import { normalizeMarkdownMath } from "../../utils/markdown-math.js";
import { splitStreamingMarkdown } from "../../utils/markdown-blocks.js";
import { answeredQuestionnaireFromTool, buildAnsweredQuestionnaireTimeline } from "../../utils/questionnaire.js";
import type { AnsweredQuestionnaireView } from "../../utils/questionnaire.js";
import { useStoreSnapshot } from "../hooks.js";
import { AnsweredQuestionCard } from "./AnsweredQuestionCard.js";
import { MarkdownArtifact } from "../MarkdownArtifact.js";
import { ToolRecordDetails } from "./MessageBubble.js";

/** Closed streaming blocks are parsed once and never re-rendered. */
const StableStreamingMarkdown = memo(function StableStreamingMarkdown({ content }: { content: string }) {
	return <MarkdownArtifact content={content} />;
});

export function CompletedToolRecords({ tools }: { tools: ChatToolRecord[] }) {
	const views = tools.map((tool) => ({ tool, questionnaire: answeredQuestionnaireFromTool(tool) }));
	const regularTools = views.filter((item) => item.questionnaire === null).map((item) => item.tool);

	return regularTools.length ? (
		<motion.div
			className="flex justify-start"
			initial={{ opacity: 0 }}
			animate={{ opacity: 1 }}
			transition={{ duration: 0.2 }}
		>
			<details className="inno-message min-w-0 max-w-[78%] overflow-hidden rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-2 text-xs text-[var(--inno-text-muted)]">
				<summary className="cursor-pointer break-words [overflow-wrap:anywhere]">Completed tool calls · {regularTools.length}</summary>
				<div className="mt-2 grid min-w-0 max-w-full gap-1.5">
					{regularTools.map((tool) => (
						<ToolRecordDetails key={tool.toolCallId} tool={tool} className="min-w-0 max-w-full overflow-hidden rounded border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] px-2 py-1" />
					))}
				</div>
			</details>
		</motion.div>
	) : null;
}

/** Owns the high-frequency streaming subscription so the page shell stays stable. */
export function StreamingBubbles() {
	const { t } = useTranslation();
	const stream = useStoreSnapshot(chatStore, () => ({
		text: chatStore.streamingText,
		thinking: chatStore.streamingThinking,
		target: chatStore.streamingTarget,
		isSending: chatStore.isSending,
		hasError: chatStore.streamingError !== "",
		hasPendingQuestion: chatStore.pendingQuestion !== null,
		activeToolCount: chatStore.activeTools.length,
		completedTools: chatStore.completedTools,
	}));

	const questionnaires = useMemo(() => stream.completedTools.flatMap((tool): AnsweredQuestionnaireView[] => {
		const questionnaire = answeredQuestionnaireFromTool(tool);
		return questionnaire ? [{ tool, questionnaire }] : [];
	}), [stream.completedTools]);
	const timeline = useMemo(
		() => buildAnsweredQuestionnaireTimeline(stream.text, questionnaires),
		[stream.text, questionnaires],
	);
	const normalized = useMemo(() => normalizeMarkdownMath(timeline.tail), [timeline.tail]);
	const { blocks, tail } = useMemo(() => splitStreamingMarkdown(normalized), [normalized]);

	// Keep the bubble at its tallest observed height while markdown is reparsed.
	const heightWatermarkRef = useRef(0);
	const bubbleObserverRef = useRef<ResizeObserver | null>(null);
	const streamingBubbleRef = useCallback((el: HTMLDivElement | null) => {
		bubbleObserverRef.current?.disconnect();
		bubbleObserverRef.current = null;
		if (!el) return;
		heightWatermarkRef.current = 0;
		el.style.minHeight = "";
		const observer = new ResizeObserver(() => {
			const height = el.offsetHeight;
			if (height > heightWatermarkRef.current) heightWatermarkRef.current = height;
			const minHeight = `${heightWatermarkRef.current}px`;
			if (el.style.minHeight !== minHeight) el.style.minHeight = minHeight;
		});
		observer.observe(el);
		bubbleObserverRef.current = observer;
	}, []);

	return (
		<>
			{stream.thinking ? (
				<motion.div className="flex justify-start" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: "easeOut" }}>
					<details className="inno-message min-w-0 max-w-[78%] overflow-hidden rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-2 text-xs text-[var(--inno-text-muted)]">
						<summary className="cursor-pointer break-words [overflow-wrap:anywhere]">Thinking...</summary>
						<pre className="mt-1 max-w-full overflow-auto whitespace-pre-wrap break-words font-mono [overflow-wrap:anywhere]">{stream.thinking}</pre>
					</details>
				</motion.div>
			) : null}

			{stream.text && stream.target === "workspace" ? (
				<motion.div key="workspace-streaming-status" className="flex justify-start" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: "easeOut" }}>
					<div className="inno-message max-w-[78%] rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-2 text-[13px] text-[var(--inno-text-muted)]">
						<div className="flex min-w-0 items-center gap-2">
							<span className="inno-stream-status-dot is-streaming shrink-0" />
							<span className="min-w-0 break-words [overflow-wrap:anywhere]">{t("chat.streamingInWorkspace", "长内容正在右侧文件区生成")}</span>
						</div>
					</div>
				</motion.div>
			) : stream.text || questionnaires.length ? (
				<motion.div key="chat-streaming-bubble" className="flex justify-start" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: "easeOut" }}>
					<div ref={streamingBubbleRef} className={`inno-message inno-streaming-blocks ${questionnaires.length > 0 ? "w-full max-w-[76%]" : "max-w-[78%]"} rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3.5 py-2.5 text-[13px] leading-relaxed text-[var(--inno-text)]`}>
						{timeline.entries.map(({ tool, questionnaire, before }) => (
							<Fragment key={tool.toolCallId}>
								{before.trim() ? <StableStreamingMarkdown content={normalizeMarkdownMath(before.trim())} /> : null}
								<div className="my-2"><AnsweredQuestionCard questionnaire={questionnaire} /></div>
							</Fragment>
						))}
						{blocks.map((block, index) => <StableStreamingMarkdown key={index} content={block} />)}
						<MarkdownArtifact content={tail} />
					</div>
				</motion.div>
			) : null}

			{stream.isSending && !stream.hasPendingQuestion && !stream.text && questionnaires.length === 0 && !stream.hasError && stream.activeToolCount === 0 ? (
				<motion.div className="flex justify-start" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.15 }}>
					<div className="inno-message max-w-[78%] rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] px-3 py-2 text-sm text-[var(--inno-text-muted)]">
						<span className="inline-flex gap-1">
							<span className="animate-bounce">·</span>
							<span className="animate-bounce" style={{ animationDelay: "150ms" }}>·</span>
							<span className="animate-bounce" style={{ animationDelay: "300ms" }}>·</span>
						</span>
					</div>
				</motion.div>
			) : null}
		</>
	);
}
