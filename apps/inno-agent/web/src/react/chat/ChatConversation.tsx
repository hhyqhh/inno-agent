import { useMemo, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { motion } from "motion/react";
import { Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ChatMessage, ChatToolRecord, PendingQuestion } from "../../types/chat.js";
import { buildConversationTurns, ConversationMinimap } from "../ConversationMinimap.js";
import { Spinner } from "../ui/Spinner.js";
import { QuestionDialog } from "../QuestionDialog.js";
import { ErrorBlock, MessageBubble } from "./MessageBubble.js";
import { CompletedToolRecords, StreamingBubbles } from "./StreamingBubbles.js";

interface ChatConversationProps {
	chat: {
		messages: ChatMessage[];
		isSending: boolean;
		isLoadingHistory: boolean;
		streamingActivity: string;
		streamingActivityDetail: string;
		streamingError: string;
		activeTools: ChatToolRecord[];
		completedTools: ChatToolRecord[];
		pendingQuestion: PendingQuestion | null;
	};
	scrollRef: RefObject<HTMLDivElement | null>;
	onScroll: () => void;
	onWheel: () => void;
	onTouchStart: () => void;
	onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
	onPauseAutoScroll: () => void;
	uploadChips: ReactNode;
	questionHint: ReactNode;
	busyBlocker: ReactNode;
	composer: ReactNode;
	workspaceContext: ReactNode;
	wsError: string;
}

export function ChatConversation({
	chat,
	scrollRef,
	onScroll,
	onWheel,
	onTouchStart,
	onPointerDown,
	onPauseAutoScroll,
	uploadChips,
	questionHint,
	busyBlocker,
	composer,
	workspaceContext,
	wsError,
}: ChatConversationProps) {
	const { t } = useTranslation();
	const turnIndexByStartMessage = useMemo(
		() => new Map(buildConversationTurns(chat.messages).map((turn) => [turn.startMessageIndex, turn.index])),
		[chat.messages],
	);

	return (
		<section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[var(--inno-chat-bg)]">
			<div className="conversation-stage relative flex-1 min-h-0">
				<div
					ref={scrollRef}
					onScroll={onScroll}
					onWheel={onWheel}
					onTouchStart={onTouchStart}
					onPointerDown={onPointerDown}
					className="chat-scroll inno-chat-grid h-full min-h-0 overflow-y-auto px-4 py-4"
				>
					<div data-conversation-content className="mx-auto flex min-w-0 max-w-3xl flex-col gap-3">
						{chat.isLoadingHistory && chat.messages.length === 0 ? (
							<div className="flex h-full flex-col items-center justify-center pt-20 text-[var(--inno-text-muted)]">
								<Spinner size={20} className="mb-3 text-[var(--inno-border-strong)]" />
								<p className="text-sm">{t("chat.loadingSession")}</p>
							</div>
						) : null}

						{!chat.isLoadingHistory && chat.messages.length === 0 && !chat.isSending ? (
							<div className="flex flex-col items-center justify-center pt-20 text-center text-[var(--inno-text-muted)]">
								<div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-[var(--inno-surface-muted)] text-[var(--inno-text-subtle)]"><Sparkles size={18} /></div>
								<p className="text-sm font-medium text-[var(--inno-text)]">{t("chat.emptySessionTitle")}</p>
								<p className="mt-1 text-xs">{t("chat.emptySessionHint")}</p>
							</div>
						) : null}

						{(() => {
							const channels = new Set(chat.messages.map((message) => message.channel).filter(Boolean));
							const multiChannel = channels.size > 1;
							return chat.messages.map((message, index) => {
								const turnIndex = turnIndexByStartMessage.get(index);
								return (
									<div key={`${message.timestamp}-${index}`} data-conversation-turn={turnIndex}>
										<MessageBubble message={message} showChannel={multiChannel} />
									</div>
								);
							});
						})()}

						{chat.isSending && chat.streamingActivity ? (
							<motion.div className="flex justify-start" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: "easeOut" }}>
								<div className="inno-message min-w-0 max-w-[78%] rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-2 text-[13px] text-[var(--inno-text-muted)] shadow-sm">
									<div className="flex min-w-0 items-center gap-2">
										<span className="inno-stream-status-dot is-streaming shrink-0" />
										<Sparkles size={14} className="shrink-0 text-[var(--inno-accent)]" />
										<span className="min-w-0 font-medium text-[var(--inno-text)]">{chat.streamingActivity}</span>
										{chat.streamingActivityDetail ? <span className="min-w-0 truncate text-xs text-[var(--inno-text-subtle)]">{chat.streamingActivityDetail}</span> : null}
									</div>
								</div>
							</motion.div>
						) : null}

						{chat.activeTools.length > 0 ? (
							<motion.div className="flex justify-start" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: "easeOut" }}>
								<div className="inno-message min-w-0 max-w-[78%] overflow-hidden rounded-lg border border-[var(--inno-accent-soft)] bg-[var(--inno-accent-soft)] px-3 py-2 text-[13px]">
									{chat.activeTools.map((tool) => (
										<div key={tool.toolCallId} className="flex min-w-0 items-center gap-2 text-[var(--inno-text-muted)]">
											<Spinner size={12} className="shrink-0" />
											<span className="min-w-0 break-words font-mono text-xs [overflow-wrap:anywhere]">{tool.toolName}</span>
										</div>
									))}
								</div>
							</motion.div>
						) : null}

						{chat.completedTools.length > 0 ? <CompletedToolRecords tools={chat.completedTools} /> : null}
						<StreamingBubbles />

						{chat.streamingError ? (
							<motion.div className="flex justify-start" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: "easeOut" }}>
								<div className="inno-message max-w-[78%]"><ErrorBlock error={chat.streamingError} /></div>
							</motion.div>
						) : null}

						{chat.pendingQuestion ? <QuestionDialog pending={chat.pendingQuestion} /> : null}
					</div>
				</div>
				<ConversationMinimap messages={chat.messages} scrollContainerRef={scrollRef} onNavigateStart={onPauseAutoScroll} />
			</div>

			<div className="shrink-0 border-t border-[var(--inno-border)] bg-[var(--inno-surface)] p-3">
				<div className="mx-auto max-w-3xl">
					{uploadChips}
					{questionHint}
					{busyBlocker}
					{wsError ? <p className="mb-2 text-xs text-[var(--inno-danger)]">{wsError}</p> : null}
					{composer}
					<div className="mt-2">{workspaceContext}</div>
				</div>
			</div>
		</section>
	);
}
