import { useCallback, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { motion, useReducedMotion } from "motion/react";
import { ChevronRight } from "lucide-react";
import type { PendingQuestion, QuestionAnswer, QuestionData, QuestionnaireResult } from "../types/chat.js";
import { chatStore } from "../stores/chat-store.js";
import { normalizeMarkdownMath } from "../utils/markdown-math.js";
import { AnsweredQuestionCard, OptionRow } from "./chat/AnsweredQuestionCard.js";
import { Button, Textarea, useUITransition } from "./ui/index.js";
import { QuestionCard } from "./chat/QuestionCard.js";

// Re-exported so existing import sites keep working; the component itself
// lives in the pure chat/ module (no store/api imports allowed there).
export { AnsweredQuestionCard };


function QuestionTab({
	q,
	questionIndex,
	answer,
	onAnswer,
	focusedOption,
	setFocusedOption,
	customDraft,
	onCustomDraftChange,
}: {
	q: QuestionData;
	questionIndex: number;
	answer: QuestionAnswer | undefined;
	onAnswer: (a: QuestionAnswer) => void;
	focusedOption: number;
	setFocusedOption: (i: number) => void;
	customDraft: string;
	onCustomDraftChange: (text: string) => void;
}) {
	const { t } = useTranslation();
	const customId = useId();
	const optionGroupId = useId();
	const isMulti = q.multiSelect === true;
	const hasPreview = q.options.some((o) => o.preview);
	const selectedLabels = new Set(answer?.selected ?? (answer?.kind === "option" && answer.answer ? [answer.answer] : []));
	// 选项优先：当前题已选了选项/多选时，文字输入框不生效
	const hasOptionAnswer = answer?.kind === "option" || answer?.kind === "multi";

	const handleOptionClick = (label: string) => {
		const customAnswer = customDraft.trim();
		if (isMulti) {
			const next = new Set(selectedLabels);
			if (next.has(label)) next.delete(label);
			else next.add(label);
			if (next.size === 0) {
				// 多选全部脱选：有文字草稿则恢复文字答案，否则撤回答案。
				if (customAnswer) {
					onAnswer({ questionIndex, question: q.question, kind: "custom", answer: customAnswer });
				} else {
					onAnswer({ questionIndex, question: q.question, kind: "multi", answer: null, selected: [] });
				}
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
				if (customAnswer) {
					onAnswer({ questionIndex, question: q.question, kind: "custom", answer: customAnswer });
				} else {
					onAnswer({ questionIndex, question: q.question, kind: "option", answer: null });
				}
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
		<div className="min-w-0 space-y-3">
			<markdown-block className="text-sm font-medium text-[var(--inno-text)]" content={normalizeMarkdownMath(q.question)} />

			<div className={hasPreview ? "grid min-w-0 gap-3 @min-[480px]:grid-cols-2" : "min-w-0"}>
				<div className="min-w-0 space-y-1.5" role="group" aria-label={t(isMulti ? "question.multiSelect" : "question.singleSelect")}>
					{q.options.map((opt, i) => (
						<OptionRow
							key={opt.label}
							label={opt.label}
							description={opt.description}
							selected={selectedLabels.has(opt.label)}
							multi={isMulti}
							groupName={optionGroupId}
							onSelect={() => handleOptionClick(opt.label)}
							onFocus={() => setFocusedOption(i)}
						/>
					))}
				</div>

				{hasPreview && preview ? (
					<div className="min-w-0 rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] p-3">
						<pre className="whitespace-pre-wrap break-words font-mono text-xs text-[var(--inno-text)] [overflow-wrap:anywhere]">{preview}</pre>
					</div>
				) : null}
			</div>

			<div className="space-y-1">
				<label htmlFor={customId} className="block text-xs text-[var(--inno-text-muted)]">{t("question.customAnswer")}</label>
				{/* A flex-1 input in a column lost its shared height and collapsed.
				    Keep the compact field in normal flow so resizing moves the footer. */}
				<Textarea
					id={customId}
					rows={1}
					className="block min-h-9 resize-y"
					placeholder={hasOptionAnswer ? t("question.optionSelectedHint") : t("question.typeSomething")}
					value={customDraft}
					disabled={hasOptionAnswer}
					onChange={(e) => handleCustomChange(e.target.value)}
				/>
			</div>
		</div>
	);
}

export function QuestionDialog({ pending }: { pending: PendingQuestion }) {
	const { t } = useTranslation();
	const reduceMotion = useReducedMotion();
	const transition = useUITransition();
	const { questionId, params } = pending;
	const questions = params.questions;
	const [activeTab, setActiveTab] = useState(0);
	const [answers, setAnswers] = useState<Map<number, QuestionAnswer>>(new Map());
	const [focusedOptions, setFocusedOptions] = useState<number[]>(questions.map(() => 0));
	// 每个 tab 的自定义文字草稿，提升到外层避免切换 tab 丢失
	const [customDrafts, setCustomDrafts] = useState<Map<number, string>>(new Map());

	// Do not retain a maximum card height: that left blank space below a
	// shrunken textarea and kept the submit row at its former position.

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

	const isLast = activeTab === questions.length - 1;
	// 中间题只需当前题有答案；最后一题提交前必须完成全部题目。
	const currentAnswered = answers.has(activeTab);
	const canContinue = currentAnswered && (!isLast || answers.size === questions.length);

	const handleClick = useCallback(() => {
		if (!canContinue) return;
		if (isLast) {
			// 最后一题（或单题）：提交全部题目的答案。
			const result: QuestionnaireResult = {
				answers: Array.from(answers.values()),
				cancelled: false,
			};
			void chatStore.submitQuestionResponse(questionId, result);
		} else {
			// 暂存当前答案，跳到下一题
			setActiveTab((prev) => Math.min(prev + 1, questions.length - 1));
		}
	}, [questionId, answers, canContinue, isLast]);

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
			className="min-w-0"
			initial={reduceMotion ? false : { opacity: 0, y: 8 }}
			animate={{ opacity: 1, y: 0 }}
			transition={transition}
		>
			<QuestionCard questions={questions} activeTab={activeTab} onTabChange={setActiveTab} isAnswered={(index) => answers.has(index)}
				footer={
					<div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--inno-border)] pt-3">
						<Button variant="ghost" size="sm" onClick={handleDismiss}>{t("question.chatAboutThis")}</Button>
						<Button variant="primary" size="sm" disabled={!canContinue} onClick={handleClick}>
							{isLast ? t("question.submit") : t("question.submitNext")}
							{!isLast ? <ChevronRight size={14} aria-hidden="true" /> : null}
						</Button>
					</div>
				}>
				<QuestionTab
					q={questions[activeTab]}
					questionIndex={activeTab}
					answer={answers.get(activeTab)}
					onAnswer={handleAnswer}
					focusedOption={focusedOptions[activeTab]}
					setFocusedOption={(i) => setFocusedForTab(activeTab, i)}
					customDraft={customDrafts.get(activeTab) ?? ""}
					onCustomDraftChange={(text) => setCustomDraftForTab(activeTab, text)}
				/>
			</QuestionCard>
		</motion.div>
	);
}
