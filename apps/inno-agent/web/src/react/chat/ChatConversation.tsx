import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { ArrowDown, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AttachmentRef, ChatMessage, ChatToolRecord, PendingQuestion } from "../../types/chat.js";
import { workspaceFileUrl } from "../../api/workspace.js";
import { workspaceStore } from "../../stores/workspace-store.js";
import { settingsStore } from "../../stores/settings-store.js";
import { buildConversationTurns, ConversationMinimap } from "../ConversationMinimap.js";
import { useStoreSnapshot } from "../hooks.js";
import { Spinner } from "../ui/Spinner.js";
import { MessageBubble } from "./MessageBubble.js";
import { StreamingBubbles } from "./StreamingBubbles.js";
import { TodoWidget, extractTodoTasks } from "./TodoWidget.js";
import { answeredQuestionnaireFromTool } from "../../utils/questionnaire.js";
import type { AnsweredQuestionnaireView } from "../../utils/questionnaire.js";
import { TerminalDrawer } from "../terminal/TerminalDrawer.js";

function traceContainsAssistantText(message: ChatMessage): boolean {
	if (message.trace?.some((step) => (step.kind === "progress" || step.kind === "answer") && Boolean(step.text?.trim()))) return true;
	return Boolean(message.traceEvents?.some((record) => (
		record.event.type === "text_delta" && Boolean(record.event.delta.trim())
	)));
}

interface ChatConversationProps {
	chat: {
		messages: ChatMessage[];
		isSending: boolean;
		isLoadingHistory: boolean;
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
	showLatestButton: boolean;
	onJumpToLatest: () => void;
	questionHint: ReactNode;
	busyBlocker: ReactNode;
	smartToast: ReactNode;
	composer: ReactNode;
	onOpenAttachment: (file: AttachmentRef) => void;
	onOpenSkill: (skillName: string) => void;
	onEditMessage: (message: ChatMessage) => void;
	canRetry: boolean;
	onRetry: () => void;
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
	showLatestButton,
	onJumpToLatest,
	questionHint,
	busyBlocker,
	smartToast,
	composer,
	onOpenAttachment,
	onOpenSkill,
	onEditMessage,
	canRetry,
	onRetry,
	wsError,
}: ChatConversationProps) {
	const { t } = useTranslation();
	// Simple Mode hides the practice terminal entirely; the drawer entry points
	// (panel toggle, run-code action) are gated the same way.
	const simpleMode = useStoreSnapshot(settingsStore, () => settingsStore.settings?.simpleMode?.enabled === true);
	const [showHistoryLoading, setShowHistoryLoading] = useState(false);
	useEffect(() => {
		const shouldShow = chat.isLoadingHistory && chat.messages.length === 0;
		if (!shouldShow) {
			setShowHistoryLoading(false);
			return;
		}
		const timer = window.setTimeout(() => setShowHistoryLoading(true), 500);
		return () => window.clearTimeout(timer);
	}, [chat.isLoadingHistory, chat.messages.length]);
	const conversationTurns = useMemo(() => buildConversationTurns(chat.messages), [chat.messages]);
	const turnIndexByStartMessage = useMemo(
		() => new Map(conversationTurns.map((turn) => [turn.startMessageIndex, turn.index])),
		[conversationTurns],
	);
	const lastAssistantMessageIndexes = useMemo(() => {
		const indexes = new Set<number>();
		for (const turn of conversationTurns) {
			for (let index = turn.endMessageIndex; index >= turn.startMessageIndex; index -= 1) {
				if (chat.messages[index]?.role === "assistant") {
					indexes.add(index);
					break;
				}
			}
		}
		return indexes;
	}, [chat.messages, conversationTurns]);
	// Finalizing a turn mounts the canonical assistant record (a full static
	// markdown re-parse) in place of the live stream tree. Defer that swap to
	// a transition-scheduled render so React can slice the expensive mount
	// across frames while StreamingBubbles keeps showing the finished stream.
	const settledSending = useDeferredValue(chat.isSending);
	const activeTurnStartMessage = settledSending ? conversationTurns.at(-1)?.startMessageIndex : undefined;
	// The assistant record for a finished stream mounts at the same render the
	// live trace unmounts; skip its entrance fade so the swap is seamless.
	// Messages mounted any other way (e.g. switching conversations) still fade in.
	const skipFadeKeysRef = useRef<Set<string>>(new Set());
	const wasSendingRef = useRef(chat.isSending);
	const knownKeysRef = useRef<Set<string>>(new Set());
	const currentKeys = chat.messages.map((message, index) => `${message.timestamp}-${index}`);
	// Fresh conversation load: none of the previously seen keys survive, so
	// per-turn flags (skip fade, live body shape) must not leak across chats.
	if (knownKeysRef.current.size > 0 && !currentKeys.some((key) => knownKeysRef.current.has(key))) {
		skipFadeKeysRef.current.clear();
	}
	knownKeysRef.current = new Set(currentKeys);
	if (wasSendingRef.current && !chat.isSending) {
		for (let index = chat.messages.length - 1; index >= 0; index -= 1) {
			if (chat.messages[index]?.role === "assistant") {
				skipFadeKeysRef.current.add(`${chat.messages[index].timestamp}-${index}`);
				break;
			}
		}
	}
	wasSendingRef.current = chat.isSending;
	const traceTurnPresentation = useMemo(() => {
		const coveredAssistantIndexes = new Set<number>();
		const actionOwnerIndexes = new Set<number>();
		const questionnairesByOwner = new Map<number, AnsweredQuestionnaireView[]>();
		for (const turn of conversationTurns) {
			const assistantIndexes: number[] = [];
			for (let index = turn.startMessageIndex; index <= turn.endMessageIndex; index += 1) {
				if (chat.messages[index]?.role === "assistant") assistantIndexes.push(index);
			}
			const traceCandidates = assistantIndexes.filter((index) => {
				const message = chat.messages[index];
				return Boolean(message?.trace?.length || message?.traceEvents?.length) && traceContainsAssistantText(message);
			});
			const ownerIndex = traceCandidates.find((index) => Boolean(chat.messages[index]?.traceEvents?.length)) ?? traceCandidates.at(-1);
			if (ownerIndex === undefined) continue;
			actionOwnerIndexes.add(ownerIndex);
			for (const index of assistantIndexes) {
				if (index !== ownerIndex) coveredAssistantIndexes.add(index);
			}
			const questionnaires = assistantIndexes.flatMap((index) => (chat.messages[index]?.tools ?? []).flatMap((tool) => {
				const questionnaire = answeredQuestionnaireFromTool(tool);
				return questionnaire ? [{ tool, questionnaire }] : [];
			}));
			if (questionnaires.length) questionnairesByOwner.set(ownerIndex, questionnaires);
		}
		return { coveredAssistantIndexes, actionOwnerIndexes, questionnairesByOwner };
	}, [chat.messages, conversationTurns]);
	const todoTasks = useMemo(
		() => extractTodoTasks(chat),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[chat.messages, chat.activeTools, chat.completedTools],
	);
	const activeWorkspaceId = useStoreSnapshot(workspaceStore, () => workspaceStore.activeWorkspaceId);
	const resolveAttachmentUrl = useCallback(
		(file: AttachmentRef) => workspaceFileUrl(file.path, activeWorkspaceId ?? undefined),
		[activeWorkspaceId],
	);

	return (
		<section className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[var(--inno-chat-bg)]">
			{smartToast}
			<div className="conversation-stage relative flex-1 min-h-0">
				<div
					ref={scrollRef}
					onScroll={onScroll}
					onWheel={onWheel}
					onTouchStart={onTouchStart}
					onPointerDown={onPointerDown}
					className="chat-scroll inno-chat-grid h-full min-h-0 overflow-y-scroll px-4 py-4"
				>
					<div data-conversation-content className="mx-auto flex min-w-0 max-w-3xl flex-col gap-3">
						{showHistoryLoading ? (
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
								const messageKey = `${message.timestamp}-${index}`;
								if (message.role === "assistant" && traceTurnPresentation.coveredAssistantIndexes.has(index)) return null;
								// The canonical assistant record can arrive just before the
								// terminal stream event. Keep the live trace as the only
								// visible representation until the turn is finalized, so the
								// trace does not briefly duplicate or change its geometry.
								if (settledSending && index === chat.messages.length - 1 && message.role === "assistant") return null;
								const isActiveTurnAssistant = activeTurnStartMessage !== undefined && index >= activeTurnStartMessage && message.role === "assistant";
								const isTurnActionOwner = lastAssistantMessageIndexes.has(index) || traceTurnPresentation.actionOwnerIndexes.has(index);
								const showActions = message.role === "user" || (isTurnActionOwner && !isActiveTurnAssistant);
								return (
									<div key={messageKey} data-conversation-turn={turnIndex}>
										<MessageBubble
											message={message}
											animateEntry={!skipFadeKeysRef.current.has(messageKey)}
											liveBodies={skipFadeKeysRef.current.has(messageKey)}
											showChannel={multiChannel}
											resolveAttachmentUrl={resolveAttachmentUrl}
											onOpenAttachment={onOpenAttachment}
											onOpenSkill={onOpenSkill}
												onEdit={chat.isSending || chat.pendingQuestion ? undefined : onEditMessage}
											showRetry={canRetry && index === chat.messages.length - 1}
											showActions={showActions}
											answeredQuestionnaires={traceTurnPresentation.questionnairesByOwner.get(index)}
											onRetry={onRetry}
										/>
									</div>
								);
							});
						})()}

						<StreamingBubbles onOpenSkill={onOpenSkill} holdCompleted={settledSending} />
					</div>
				</div>
				<ConversationMinimap messages={chat.messages} scrollContainerRef={scrollRef} onNavigateStart={onPauseAutoScroll} />
				<div className="inno-conversation-composer-layer">
					{showLatestButton ? (
						<div className="inno-latest-row">
							<button
								type="button"
								className="inno-latest-button"
								aria-label={t("chat.trace.jumpToLatest", "回到最新位置")}
								onClick={onJumpToLatest}
							>
								<ArrowDown size={15} aria-hidden="true" />
							</button>
						</div>
					) : null}
					<div className="inno-conversation-composer-content mx-auto max-w-3xl">
						{questionHint || busyBlocker ? (
							<div className="inno-conversation-status-wrap">
								<div className="inno-conversation-composer-mask" aria-hidden="true" />
								<div className="inno-conversation-status-content">
									{questionHint}
									{busyBlocker}
								</div>
								<div className="inno-conversation-status-gap-mask" aria-hidden="true" />
							</div>
						) : null}
						{todoTasks ? <TodoWidget tasks={todoTasks} /> : null}
						{wsError ? <p className="mb-2 text-xs text-[var(--inno-danger)]">{wsError}</p> : null}
						<div className="inno-conversation-composer-wrap">
							<div className="inno-conversation-composer-mask" aria-hidden="true" />
							{composer}
						</div>
					</div>
				</div>
			</div>
			{simpleMode ? null : <TerminalDrawer />}
		</section>
	);
}
