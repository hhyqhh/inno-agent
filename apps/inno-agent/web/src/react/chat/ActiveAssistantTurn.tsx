import { useMemo, useRef, type ReactNode } from "react";
import { chatStore } from "../../stores/chat-store.js";
import type { ChatMessage } from "../../types/chat.js";
import { answeredQuestionnaireFromTool, type AnsweredQuestionnaireView } from "../../utils/questionnaire.js";
import { useStoreSnapshot } from "../hooks.js";
import { PermissionDialog } from "../PermissionDialog.js";
import { QuestionDialog } from "../QuestionDialog.js";
import { MessageBubble, type AttachmentOpenHandler, type AttachmentUrlResolver } from "./MessageBubble.js";

export interface SettledAssistantBubbleProps {
	message: ChatMessage;
	turnIndex?: number;
	showChannel: boolean;
	collapseUserToFirstLine: boolean;
	resolveAttachmentUrl?: AttachmentUrlResolver;
	onOpenAttachment?: AttachmentOpenHandler;
	onOpenSkill?: (skillName: string) => void;
	showRetry: boolean;
	showActions: boolean;
	answeredQuestionnaires?: AnsweredQuestionnaireView[];
	resultContent?: ReactNode;
	onRetry?: () => void;
}

/**
 * Single-tree assistant slot modeled on ZCode's live-to-settled message flow:
 * - While streaming, subscribes locally to `chatStore` so high-frequency chunks
 *   only re-render this bubble and never the conversation history above it.
 * - When the turn settles, stays mounted under the same React key and switches
 *   its backing data to the canonical persisted message in place, avoiding the
 *   unmount/remount flicker across Streamdown, code blocks, charts, and trace
 *   collapse animations.
 */
export function ActiveAssistantTurn({
	isLive,
	settled,
	onOpenSkill,
}: {
	isLive: boolean;
	settled: SettledAssistantBubbleProps | null;
	onOpenSkill?: (skillName: string) => void;
}) {
	const stream = useStoreSnapshot(chatStore, () => ({
		text: chatStore.streamingText,
		trace: chatStore.streamingTrace,
		completedTools: chatStore.completedTools,
		isSending: chatStore.isSending,
		streamingError: chatStore.streamingError,
		streamingStartedAt: chatStore.streamingStartedAt,
		streamingFinishedAt: chatStore.streamingFinishedAt,
		pendingQuestion: chatStore.pendingQuestion,
		pendingPermission: chatStore.pendingPermission,
	}));

	const hasLivePayload = Boolean(
		stream.text.trim()
		|| stream.trace.length > 0
		|| stream.completedTools.length > 0
		|| stream.pendingQuestion
		|| stream.pendingPermission
		|| stream.streamingError
		|| stream.isSending,
	);

	// Keep the last live snapshot across the brief gap between store reset and
	// the canonical message arriving so the tree never flickers to null.
	const lastLiveRef = useRef<typeof stream | null>(null);
	if (hasLivePayload) lastLiveRef.current = stream;

	const effectiveStream = hasLivePayload ? stream : (isLive ? lastLiveRef.current : null);
	const useLiveSource = isLive && Boolean(effectiveStream);

	const liveQuestionnaires = useMemo(
		() => (effectiveStream?.completedTools ?? []).flatMap((tool): AnsweredQuestionnaireView[] => {
			const questionnaire = answeredQuestionnaireFromTool(tool);
			return questionnaire ? [{ tool, questionnaire }] : [];
		}),
		[effectiveStream?.completedTools],
	);

	const liveMessage = useMemo<ChatMessage | null>(() => {
		if (!effectiveStream) return null;
		return {
			role: "assistant",
			content: effectiveStream.text,
			timestamp: Date.now(),
			trace: effectiveStream.trace,
			traceStartedAt: effectiveStream.streamingStartedAt ?? undefined,
			traceFinishedAt: effectiveStream.streamingFinishedAt ?? undefined,
			error: effectiveStream.streamingError || undefined,
			transient: true,
			complete: false,
		};
	}, [effectiveStream]);

	const pendingQuestion = useLiveSource && effectiveStream?.pendingQuestion
		? {
			questionId: effectiveStream.pendingQuestion.questionId,
			card: <QuestionDialog pending={effectiveStream.pendingQuestion} />,
		}
		: undefined;
	const permissionCard = useLiveSource && effectiveStream?.pendingPermission
		? <PermissionDialog pending={effectiveStream.pendingPermission} />
		: undefined;

	const message = useLiveSource ? liveMessage : settled?.message ?? null;
	if (!message) return null;

	return (
		<div
			data-conversation-turn={settled?.turnIndex}
			data-entry-id={useLiveSource ? undefined : settled?.message.entryId}
		>
			<MessageBubble
				message={message}
				collapseUserToFirstLine={settled?.collapseUserToFirstLine ?? false}
				animateEntry={useLiveSource}
				liveBodies
				isStreaming={isLive}
				showChannel={!isLive && Boolean(settled?.showChannel)}
				resolveAttachmentUrl={settled?.resolveAttachmentUrl}
				onOpenAttachment={settled?.onOpenAttachment}
				onOpenSkill={settled?.onOpenSkill ?? onOpenSkill}
				showRetry={!isLive && Boolean(settled?.showRetry)}
				showActions={!isLive && Boolean(settled?.showActions)}
				answeredQuestionnaires={useLiveSource ? liveQuestionnaires : settled?.answeredQuestionnaires}
				pendingQuestion={pendingQuestion}
				trailingCard={permissionCard}
				resultContent={!isLive ? settled?.resultContent : undefined}
				onRetry={!isLive ? settled?.onRetry : undefined}
			/>
		</div>
	);
}
