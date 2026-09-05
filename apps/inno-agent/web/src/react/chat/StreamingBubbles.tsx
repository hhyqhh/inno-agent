import { useMemo, useRef } from "react";
import { motion } from "motion/react";
import { chatStore } from "../../stores/chat-store.js";
import { useStoreSnapshot } from "../hooks.js";
import { answeredQuestionnaireFromTool } from "../../utils/questionnaire.js";
import type { AnsweredQuestionnaireView } from "../../utils/questionnaire.js";
import { QuestionDialog } from "../QuestionDialog.js";
import { AgentTraceTimeline } from "./AgentTraceTimeline.js";

/** Render the live turn as one ordered flow. Text records stay in the same
 * sequence as thinking and tool records instead of being painted as a
 * separate answer block above the process timeline. */
export function StreamingBubbles({ onOpenSkill, holdCompleted = false }: { onOpenSkill?: (skillName: string) => void; holdCompleted?: boolean }) {
	const stream = useStoreSnapshot(chatStore, () => ({
		text: chatStore.streamingText,
		trace: chatStore.streamingTrace,
		completedTools: chatStore.completedTools,
		isSending: chatStore.isSending,
		streamingError: chatStore.streamingError,
		streamingStartedAt: chatStore.streamingStartedAt,
		streamingFinishedAt: chatStore.streamingFinishedAt,
		pendingQuestion: chatStore.pendingQuestion,
	}));

	const hasText = Boolean(stream.text.trim());
	const isLive = hasText || stream.trace.length > 0 || stream.completedTools.length > 0 || Boolean(stream.pendingQuestion) || Boolean(stream.streamingError) || stream.isSending;

	// The store clears the stream the instant a turn finalizes, which would
	// unmount this tree in the same commit the canonical message mounts. While
	// the parent defers that swap, keep rendering the last live snapshot so
	// the on-screen tree (and its parsed markdown) survives until the static
	// replacement has rendered.
	const heldRef = useRef<typeof stream | null>(null);
	if (isLive) heldRef.current = stream;
	const effective = isLive ? stream : (holdCompleted ? heldRef.current : null);

	const questionnaires = useMemo(() => (effective?.completedTools ?? []).flatMap((tool): AnsweredQuestionnaireView[] => {
		const questionnaire = answeredQuestionnaireFromTool(tool);
		return questionnaire ? [{ tool, questionnaire }] : [];
	}), [effective?.completedTools]);
	const pendingQuestion = effective?.pendingQuestion
		? {
			questionId: effective.pendingQuestion.questionId,
			card: <QuestionDialog pending={effective.pendingQuestion} />,
		}
		: undefined;

	if (!effective) return null;
	return (
		<motion.div
			className="inno-trace-shell inno-trace-shell-live"
			initial={{ opacity: 0, y: 8 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{ duration: 0.2, ease: "easeOut" }}
		>
			<AgentTraceTimeline
				steps={effective.trace}
				isSending={effective.isSending}
				startedAt={effective.streamingStartedAt}
				finishedAt={effective.streamingFinishedAt}
				error={effective.streamingError}
				showText
				fallbackText={effective.text}
				answeredQuestionnaires={questionnaires}
				pendingQuestion={pendingQuestion}
				onOpenSkill={onOpenSkill}
			/>
		</motion.div>
	);
}
