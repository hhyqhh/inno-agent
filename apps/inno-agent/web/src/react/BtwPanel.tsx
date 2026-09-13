import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion } from "motion/react";
import { Check, CornerUpLeft, Loader2, MessageCircleQuestion, RotateCcw, SendHorizontal, X } from "lucide-react";
import { btwStore } from "../stores/btw-store.js";
import { chatStore } from "../stores/chat-store.js";
import { sessionsStore } from "../stores/sessions-store.js";
import { useStoreSnapshot } from "./hooks.js";
import { MarkdownArtifact } from "./MarkdownArtifact.js";
import { getSession } from "../api/sessions.js";
import type { BtwExchange } from "../types/btw.js";

/**
 * "顺便问问" bottom slide-up panel: a side-question thread that never enters
 * the main transcript. Each answered exchange can be explicitly brought back
 * into the main session as a pinned note.
 */
export function BtwPanel() {
	const { t } = useTranslation();
	const sessionId = useStoreSnapshot(sessionsStore, () => sessionsStore.currentSessionId);
	const btw = useStoreSnapshot(btwStore, () => ({
		panelOpen: btwStore.panelOpen,
		draft: btwStore.draft,
		thread: btwStore.threadFor(sessionsStore.currentSessionId),
	}));
	const [sending, setSending] = useState(false);
	const [bringingBackId, setBringingBackId] = useState<string | null>(null);
	const inputRef = useRef<HTMLTextAreaElement | null>(null);
	const listRef = useRef<HTMLDivElement | null>(null);

	const thread = btw.thread;
	const pending = thread.some((e) => e.status === "pending");

	useEffect(() => {
		if (btw.panelOpen) inputRef.current?.focus();
	}, [btw.panelOpen]);

	// Keep the newest exchange in view as answers land.
	useEffect(() => {
		const list = listRef.current;
		if (list) list.scrollTop = list.scrollHeight;
	}, [thread.length, thread[thread.length - 1]?.answer]);

	if (!sessionId) return null;

	const send = () => {
		const question = btwStore.draft.trim();
		if (!question || sending || pending) return;
		setSending(true);
		void btwStore.ask(sessionId, question).finally(() => setSending(false));
	};

	const bringBack = (exchange: BtwExchange) => {
		if (bringingBackId) return;
		setBringingBackId(exchange.id);
		void btwStore
			.bringBack(sessionId, exchange.id)
			.then(async () => {
				// The note is persisted before the POST returns (the server queues
				// the append), so a history reload shows it immediately — unless a
				// turn is streaming, in which case the next reload picks it up.
				if (chatStore.isSending) return;
				const session = await getSession(sessionId);
				chatStore.loadHistory(session.messages, sessionId);
			})
			.catch(() => {
				// Leave broughtBack unset so the learner can retry.
			})
			.finally(() => setBringingBackId(null));
	};

	const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			send();
		}
	};

	return (
		<AnimatePresence>
			{btw.panelOpen ? (
				<motion.div
					key="btw-panel"
					className="absolute inset-x-0 bottom-0 z-30 mx-auto flex max-h-[70%] w-full max-w-3xl flex-col px-4 pb-2"
					initial={{ opacity: 0, y: 48 }}
					animate={{ opacity: 1, y: 0 }}
					exit={{ opacity: 0, y: 48 }}
					transition={{ duration: 0.25, ease: "easeOut" }}
				>
					<div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-[var(--inno-border)] bg-[var(--inno-surface)] shadow-lg">
						<div className="flex shrink-0 items-center gap-2 border-b border-[var(--inno-border)] px-4 py-2.5">
							<MessageCircleQuestion size={16} className="text-[var(--inno-accent)]" aria-hidden="true" />
							<span className="text-sm font-medium text-[var(--inno-text)]">{t("btw.title")}</span>
							<span className="hidden text-xs text-[var(--inno-text-subtle)] sm:inline">{t("btw.subtitle")}</span>
							<button
								type="button"
								className="ml-auto flex h-7 w-7 items-center justify-center rounded-md text-[var(--inno-text-muted)] transition-colors hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]"
								title={t("btw.close")}
								aria-label={t("btw.close")}
								onClick={() => btwStore.togglePanel(false)}
							>
								<X size={15} />
							</button>
						</div>

						<div ref={listRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
							{thread.length === 0 ? (
								<p className="py-6 text-center text-xs text-[var(--inno-text-subtle)]">{t("btw.emptyHint")}</p>
							) : null}
							{thread.map((exchange) => (
								<div key={exchange.id} className="flex flex-col gap-1.5">
									<div className="self-end rounded-lg bg-[var(--inno-accent-soft)] px-3 py-1.5 text-sm text-[var(--inno-text)]">
										{exchange.question}
									</div>
									<div className="self-stretch rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] px-3 py-2 text-sm">
										{exchange.status === "pending" ? (
											<span className="flex items-center gap-2 text-[var(--inno-text-muted)]">
												<Loader2 size={14} className="animate-spin" aria-hidden="true" />
												{t("btw.thinking")}
											</span>
										) : exchange.status === "error" ? (
											<span className="flex items-center gap-2 text-[var(--inno-danger)]">
												<span className="min-w-0 flex-1 text-xs">{t("btw.error", { message: exchange.error ?? "" })}</span>
												<button
													type="button"
													className="flex shrink-0 items-center gap-1 rounded-md border border-[var(--inno-border)] px-2 py-1 text-xs text-[var(--inno-text)] transition-colors hover:bg-[var(--inno-surface)]"
													onClick={() => void btwStore.retry(sessionId, exchange.id)}
												>
													<RotateCcw size={12} aria-hidden="true" />
													{t("btw.retry")}
												</button>
											</span>
										) : (
											<>
												<MarkdownArtifact content={exchange.answer} compact />
												<div className="mt-2 flex justify-end">
													{exchange.broughtBack ? (
														<span className="flex items-center gap-1 text-xs text-[var(--inno-text-subtle)]">
															<Check size={12} aria-hidden="true" />
															{t("btw.broughtBack")}
														</span>
													) : (
														<button
															type="button"
															className="flex items-center gap-1 rounded-md border border-[var(--inno-border)] px-2 py-1 text-xs text-[var(--inno-text-muted)] transition-colors hover:bg-[var(--inno-surface)] hover:text-[var(--inno-text)] disabled:opacity-50"
															disabled={bringingBackId !== null}
															title={t("btw.bringBackHint")}
															onClick={() => bringBack(exchange)}
														>
															{bringingBackId === exchange.id ? (
																<Loader2 size={12} className="animate-spin" aria-hidden="true" />
															) : (
																<CornerUpLeft size={12} aria-hidden="true" />
															)}
															{t("btw.bringBack")}
														</button>
													)}
												</div>
											</>
										)}
									</div>
								</div>
							))}
						</div>

						<div className="flex shrink-0 items-end gap-2 border-t border-[var(--inno-border)] px-4 py-2.5">
							<textarea
								ref={inputRef}
								className="max-h-28 min-h-[2.25rem] flex-1 resize-none rounded-lg border border-[var(--inno-border)] bg-[var(--inno-chat-bg)] px-3 py-2 text-sm text-[var(--inno-text)] outline-none placeholder:text-[var(--inno-text-subtle)] focus:border-[var(--inno-accent)]"
								placeholder={t("btw.placeholder")}
								rows={1}
								value={btw.draft}
								onChange={(e) => btwStore.setDraft(e.target.value)}
								onKeyDown={handleKeyDown}
							/>
							<button
								type="button"
								className="inno-composer-send flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-50"
								title={t("btw.send")}
								aria-label={t("btw.send")}
								disabled={!btw.draft.trim() || sending || pending}
								onClick={send}
							>
								{sending ? <Loader2 size={15} className="animate-spin" /> : <SendHorizontal size={15} />}
							</button>
						</div>
					</div>
				</motion.div>
			) : null}
		</AnimatePresence>
	);
}
