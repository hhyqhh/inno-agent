import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { motion } from "motion/react";
import type { PendingQuestion, QuestionAnswer, QuestionData, QuestionnaireResult } from "../types/chat.js";
import { chatStore } from "../stores/chat-store.js";

function OptionRow({
	label,
	description,
	selected,
	multi,
	onSelect,
	onFocus,
}: {
	label: string;
	description: string;
	selected: boolean;
	multi: boolean;
	onSelect: () => void;
	onFocus: () => void;
}) {
	return (
		<button
			className={`flex w-full items-start gap-2.5 rounded-md border px-3 py-2 text-left text-[13px] transition-colors ${
				selected
					? "border-[var(--inno-accent)] bg-[var(--inno-accent-soft)] text-[var(--inno-text)]"
					: "border-[var(--inno-border)] bg-[var(--inno-surface)] text-[var(--inno-text)] hover:border-[var(--inno-border-strong)] hover:bg-[var(--inno-surface-muted)]"
			}`}
			onClick={onSelect}
			onMouseEnter={onFocus}
		>
			<span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-[var(--inno-border-strong)]">
				{selected ? (
					<span className={`block ${multi ? "h-2 w-2 rounded-sm bg-[var(--inno-accent)]" : "h-2 w-2 rounded-full bg-[var(--inno-accent)]"}`} />
				) : null}
			</span>
			<span className="min-w-0 flex-1">
				<span className="font-medium">{label}</span>
				{description ? <span className="mt-0.5 block text-xs text-[var(--inno-text-muted)]">{description}</span> : null}
			</span>
		</button>
	);
}

function QuestionTab({
	q,
	questionIndex,
	answer,
	onAnswer,
	onDismiss,
	focusedOption,
	setFocusedOption,
	customDraft,
	onCustomDraftChange,
}: {
	q: QuestionData;
	questionIndex: number;
	answer: QuestionAnswer | undefined;
	onAnswer: (a: QuestionAnswer) => void;
	onDismiss: () => void;
	focusedOption: number;
	setFocusedOption: (i: number) => void;
	customDraft: string;
	onCustomDraftChange: (text: string) => void;
}) {
	const { t } = useTranslation();
	const isMulti = q.multiSelect === true;
	const hasPreview = q.options.some((o) => o.preview);
	const selectedLabels = new Set(answer?.selected ?? (answer?.answer ? [answer.answer] : []));
	// 选项优先：当前题已选了选项/多选时，文字输入框不生效
	const hasOptionAnswer = answer?.kind === "option" || answer?.kind === "multi";

	const handleOptionClick = (label: string) => {
		if (isMulti) {
			const next = new Set(selectedLabels);
			if (next.has(label)) next.delete(label);
			else next.add(label);
			if (next.size === 0) {
				// 多选全部脱选 → 撤回答案
				onAnswer({ questionIndex, question: q.question, kind: "multi", answer: null, selected: [] });
			} else {
				onAnswer({
					questionIndex,
					question: q.question,
					kind: "multi",
					answer: null,
					selected: Array.from(next),
				});
			}
		} else {
			// 单选：再次点击已选项 = 脱选，回到未答
			if (selectedLabels.has(label)) {
				onAnswer({ questionIndex, question: q.question, kind: "option", answer: null });
			} else {
				onAnswer({
					questionIndex,
					question: q.question,
					kind: "option",
					answer: label,
					preview: q.options.find((o) => o.label === label)?.preview,
				});
			}
		}
	};

	// 输入即作答：文字非空且未选选项时立刻同步为 custom 答案；清空则撤回。
	// 草稿始终写入父组件（跨 tab 持久），但只在无选项答案时才成为正式答案。
	const handleCustomChange = (text: string) => {
		onCustomDraftChange(text);
		if (hasOptionAnswer) return; // 选项优先，文字不生效
		const trimmed = text.trim();
		if (trimmed) {
			onAnswer({ questionIndex, question: q.question, kind: "custom", answer: trimmed });
		} else if (answer?.kind === "custom") {
			// 文字清空：撤回 custom 作答
			onAnswer({ questionIndex, question: q.question, kind: "custom", answer: null });
		}
	};

	const preview = hasPreview ? q.options[focusedOption]?.preview : undefined;

	return (
		<div className="space-y-3">
			<p className="text-sm font-medium text-[var(--inno-text)]">{q.question}</p>

			<div className={hasPreview ? "flex gap-3" : ""}>
				<div className={`space-y-1.5 ${hasPreview ? "w-1/2" : ""}`}>
					{q.options.map((opt, i) => (
						<OptionRow
							key={opt.label}
							label={opt.label}
							description={opt.description}
							selected={selectedLabels.has(opt.label)}
							multi={isMulti}
							onSelect={() => handleOptionClick(opt.label)}
							onFocus={() => setFocusedOption(i)}
						/>
					))}

					<div className="flex flex-col gap-1 pt-1">
						<input
							type="text"
							className={`min-w-0 flex-1 rounded-md border px-2.5 py-1.5 text-[13px] focus-visible:outline-none focus-visible:shadow-[var(--inno-ring)] ${
								hasOptionAnswer
									? "cursor-not-allowed border-[var(--inno-border)] bg-[var(--inno-surface-muted)] text-[var(--inno-text-subtle)]"
									: "border-[var(--inno-border)] bg-[var(--inno-surface)] text-[var(--inno-text)] focus-visible:border-[var(--inno-focus-border)]"
							}`}
							placeholder={hasOptionAnswer ? t("question.optionSelectedHint") : t("question.typeSomething")}
							value={customDraft}
							disabled={hasOptionAnswer}
							onChange={(e) => handleCustomChange(e.target.value)}
						/>
					</div>
				</div>

				{hasPreview && preview ? (
					<div className="w-1/2 rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] p-3">
						<pre className="whitespace-pre-wrap font-mono text-xs text-[var(--inno-text)]">{preview}</pre>
					</div>
				) : null}
			</div>

			<button
				className="text-xs text-[var(--inno-text-subtle)] underline hover:text-[var(--inno-text-muted)]"
				onClick={onDismiss}
			>
				{t("question.chatAboutThis")}
			</button>
		</div>
	);
}

export function QuestionDialog({ pending }: { pending: PendingQuestion }) {
	const { t } = useTranslation();
	const { questionId, params } = pending;
	const questions = params.questions;
	const [activeTab, setActiveTab] = useState(0);
	const [answers, setAnswers] = useState<Map<number, QuestionAnswer>>(new Map());
	const [focusedOptions, setFocusedOptions] = useState<number[]>(questions.map(() => 0));
	// 每个 tab 的自定义文字草稿，提升到外层避免切换 tab 丢失
	const [customDrafts, setCustomDrafts] = useState<Map<number, string>>(new Map());

	const handleAnswer = useCallback(
		(a: QuestionAnswer) => {
			setAnswers((prev) => {
				const next = new Map(prev);
				// custom/option 答案被撤回（answer 为 null）视为未答，移出 Map。
				// 否则 allAnswered 会把空答案误判为已答。
				if ((a.kind === "custom" || a.kind === "option") && a.answer === null) {
					next.delete(a.questionIndex);
				} else if (a.kind === "multi" && (!a.selected || a.selected.length === 0)) {
					next.delete(a.questionIndex);
				} else {
					next.set(a.questionIndex, a);
				}
				return next;
			});
		},
		[],
	);

	const handleDismiss = useCallback(() => {
		void chatStore.dismissQuestion(questionId);
	}, [questionId]);

	// 逐题推进：只要当前题答了，就能点按钮推进或提交。
	const currentAnswered = answers.has(activeTab);
	const isLast = activeTab === questions.length - 1;

	const handleClick = useCallback(() => {
		if (!answers.has(activeTab)) return;
		if (isLast) {
			// 最后一题（或单题）：提交全部已答题目。未答的题不在 answers 里，自然不发。
			const result: QuestionnaireResult = {
				answers: Array.from(answers.values()),
				cancelled: false,
			};
			void chatStore.submitQuestionResponse(questionId, result);
		} else {
			// 暂存当前答案，跳到下一题
			setActiveTab((prev) => Math.min(prev + 1, questions.length - 1));
		}
	}, [questionId, answers, activeTab, isLast, questions.length]);

	const setFocusedForTab = useCallback(
		(tab: number, optionIdx: number) => {
			setFocusedOptions((prev) => {
				const next = [...prev];
				next[tab] = optionIdx;
				return next;
			});
		},
		[],
	);

	const setCustomDraftForTab = useCallback((tab: number, text: string) => {
		setCustomDrafts((prev) => {
			const next = new Map(prev);
			next.set(tab, text);
			return next;
		});
	}, []);

	return (
		<motion.div
			className="flex justify-start"
			initial={{ opacity: 0, y: 16 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{ duration: 0.3, ease: "easeOut" }}
		>
			<div className="w-full max-w-[76%] rounded-lg border border-[var(--inno-accent-soft)] bg-[var(--inno-surface)] px-4 py-3 shadow-sm">
				{questions.length > 1 ? (
					<div className="mb-3 flex gap-1">
						{questions.map((q, i) => (
							<button
								key={q.header}
								className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
									activeTab === i
										? "bg-[var(--inno-accent-soft)] text-[var(--inno-accent)]"
										: "bg-[var(--inno-surface-muted)] text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)]"
								}`}
								onClick={() => setActiveTab(i)}
							>
								{q.header}
							</button>
						))}
					</div>
				) : null}

				<QuestionTab
					q={questions[activeTab]}
					questionIndex={activeTab}
					answer={answers.get(activeTab)}
					onAnswer={handleAnswer}
					onDismiss={handleDismiss}
					focusedOption={focusedOptions[activeTab]}
					setFocusedOption={(i) => setFocusedForTab(activeTab, i)}
					customDraft={customDrafts.get(activeTab) ?? ""}
					onCustomDraftChange={(text) => setCustomDraftForTab(activeTab, text)}
				/>

				<div className="mt-3 flex items-center justify-end gap-2">
					{questions.length > 1 ? (
						<span className="text-xs text-[var(--inno-text-subtle)]">
							{activeTab + 1} / {questions.length}
						</span>
					) : null}
					<button
						className={`rounded-lg px-4 py-1.5 text-sm font-medium transition-colors ${ currentAnswered ? "inno-primary-button" : "cursor-not-allowed bg-[var(--inno-surface-muted)] text-[var(--inno-text-subtle)]" }`}
						disabled={!currentAnswered}
						onClick={handleClick}
					>
						{isLast ? t("question.submit") : t("question.submitNext")}
					</button>
				</div>
			</div>
		</motion.div>
	);
}
