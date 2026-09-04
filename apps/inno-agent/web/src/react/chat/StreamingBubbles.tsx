import { useMemo } from "react";
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
export function StreamingBubbles({ onOpenSkill }: { onOpenSkill?: (skillName: string) => void }) {
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

	const questionnaires = useMemo(() => stream.completedTools.flatMap((tool): AnsweredQuestionnaireView[] => {
		const questionnaire = answeredQuestionnaireFromTool(tool);
		return questionnaire ? [{ tool, questionnaire }] : [];
	}), [stream.completedTools]);
	const pendingQuestion = stream.pendingQuestion
		? {
			questionId: stream.pendingQuestion.questionId,
			card: <QuestionDialog pending={stream.pendingQuestion} />,
		}
		: undefined;

	const hasText = Boolean(stream.text.trim());
	if (!hasText && stream.trace.length === 0 && questionnaires.length === 0 && !pendingQuestion && !stream.streamingError && !stream.isSending) return null;
	return (
		<motion.div
			className="inno-trace-shell inno-trace-shell-live"
			initial={{ opacity: 0, y: 8 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{ duration: 0.2, ease: "easeOut" }}
		>
			<AgentTraceTimeline
				steps={stream.trace}
				isSending={stream.isSending}
				startedAt={stream.streamingStartedAt}
				finishedAt={stream.streamingFinishedAt}
				error={stream.streamingError}
				showText
				fallbackText={stream.text}
				answeredQuestionnaires={questionnaires}
				pendingQuestion={pendingQuestion}
				onOpenSkill={onOpenSkill}
			/>
		</motion.div>
	);
}
