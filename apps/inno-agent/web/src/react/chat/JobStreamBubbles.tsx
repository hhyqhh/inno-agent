import { motion } from "motion/react";
import { chatStore } from "../../stores/chat-store.js";
import { useStoreSnapshot } from "../hooks.js";
import { QuestionDialog } from "../QuestionDialog.js";
import { AgentTraceTimeline } from "./AgentTraceTimeline.js";

/** Live view of a manual job run. Deliberately renders with the exact same
 *  trace timeline as a normal chat turn (StreamingBubbles), but is driven by
 *  the job-run SSE namespace so the composer never locks (isSending stays
 *  false) and an active chat stream is never disturbed. */
export function JobStreamBubbles() {
	const stream = useStoreSnapshot(chatStore, () => ({
		active: chatStore.jobStreaming,
		belongsToCurrentSession: chatStore.jobStreamInCurrentSession,
		text: chatStore.jobStreamText,
		trace: chatStore.jobStreamTrace,
		startedAt: chatStore.jobStreamStartedAt,
		error: chatStore.jobStreamError,
		pendingQuestion: chatStore.pendingQuestion,
	}));
	if (!stream.active || !stream.belongsToCurrentSession) return null;
	const pendingQuestion = stream.pendingQuestion
		? {
			questionId: stream.pendingQuestion.questionId,
			card: <QuestionDialog pending={stream.pendingQuestion} />,
		}
		: undefined;
	return (
		<motion.div
			className="inno-trace-shell inno-trace-shell-live"
			initial={{ opacity: 0, y: 8 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{ duration: 0.2, ease: "easeOut" }}
		>
			<AgentTraceTimeline
				steps={stream.trace}
				isSending
				startedAt={stream.startedAt}
				finishedAt={null}
				error={stream.error}
				showText
				fallbackText={stream.text}
				pendingQuestion={pendingQuestion}
			/>
		</motion.div>
	);
}
