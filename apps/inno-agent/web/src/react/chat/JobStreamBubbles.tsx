import { useRef } from "react";
import { motion } from "motion/react";
import { chatStore } from "../../stores/chat-store.js";
import { useStoreSnapshot } from "../hooks.js";
import { QuestionDialog } from "../QuestionDialog.js";
import { PermissionDialog } from "../PermissionDialog.js";
import { AgentTraceTimeline } from "./AgentTraceTimeline.js";
import { AgentAvatar } from "./MessageBubble.js";

/** Live view of a manual job run. Deliberately renders with the exact same
 *  trace timeline as a normal chat turn (StreamingBubbles), but is driven by
 *  the job-run SSE namespace so the composer never locks (isSending stays
 *  false) and an active chat stream is never disturbed. */
export function JobStreamBubbles({ holdCompleted = false }: { holdCompleted?: boolean }) {
	const stream = useStoreSnapshot(chatStore, () => ({
		active: chatStore.jobStreaming,
		belongsToCurrentSession: chatStore.jobStreamInCurrentSession,
		text: chatStore.jobStreamText,
		trace: chatStore.jobStreamTrace,
		startedAt: chatStore.jobStreamStartedAt,
		error: chatStore.jobStreamError,
		pendingQuestion: chatStore.pendingQuestion,
		pendingPermission: chatStore.pendingPermission,
	}));
	// The job store clears its live fields in the same update that appends the
	// canonical assistant message. Keep the last live snapshot for the parent's
	// deferred handoff so the timeline does not jump or briefly disappear.
	const heldRef = useRef<typeof stream | null>(null);
	if (stream.active && stream.belongsToCurrentSession) heldRef.current = stream;
	const effective = stream.active ? stream : (holdCompleted ? heldRef.current : null);
	if (!effective || !effective.belongsToCurrentSession) return null;
	const pendingQuestion = effective.pendingQuestion
		? {
			questionId: effective.pendingQuestion.questionId,
			card: <QuestionDialog pending={effective.pendingQuestion} />,
		}
		: undefined;
	const permissionCard = effective.pendingPermission
		? <PermissionDialog pending={effective.pendingPermission} />
		: undefined;
	return (
		<motion.div
			className="inno-trace-shell inno-trace-shell-live flex gap-3"
			initial={{ opacity: 0, y: 8 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{ duration: 0.2, ease: "easeOut" }}
		>
			<AgentAvatar />
			<div className="min-w-0 flex-1">
				<AgentTraceTimeline
					steps={effective.trace}
					isSending
					startedAt={effective.startedAt}
					finishedAt={null}
					error={effective.error}
					showText
					fallbackText={effective.text}
					pendingQuestion={pendingQuestion}
					trailingCard={permissionCard}
				/>
			</div>
		</motion.div>
	);
}
