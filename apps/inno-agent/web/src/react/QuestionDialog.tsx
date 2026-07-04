import { useCallback, useState } from "react";
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
}: {
	q: QuestionData;
	questionIndex: number;
	answer: QuestionAnswer | undefined;
	onAnswer: (a: QuestionAnswer) => void;
	onDismiss: () => void;
	focusedOption: number;
	setFocusedOption: (i: number) => void;
}) {
	const [customText, setCustomText] = useState("");
	const isMulti = q.multiSelect === true;
	const hasPreview = q.options.some((o) => o.preview);
	const selectedLabels = new Set(answer?.selected ?? (answer?.answer ? [answer.answer] : []));

	const handleOptionClick = (label: string) => {
		if (isMulti) {
			const next = new Set(selectedLabels);
			if (next.has(label)) next.delete(label);
			else next.add(label);
			onAnswer({
				questionIndex,
				question: q.question,
				kind: "multi",
				answer: null,
				selected: Array.from(next),
			});
		} else {
			onAnswer({
				questionIndex,
				question: q.question,
				kind: "option",
				answer: label,
				preview: q.options.find((o) => o.label === label)?.preview,
			});
		}
	};

	const handleCustomSubmit = () => {
		if (!customText.trim()) return;
		onAnswer({
			questionIndex,
			question: q.question,
			kind: "custom",
			answer: customText.trim(),
		});
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

					{!isMulti ? (
						<div className="flex items-center gap-1.5 pt-1">
							<input
								type="text"
								className="min-w-0 flex-1 rounded-md border border-[var(--inno-border)] px-2.5 py-1.5 text-[13px] focus-visible:border-[var(--inno-focus-border)] focus-visible:outline-none focus-visible:shadow-[var(--inno-ring)]"
								placeholder="Type something..."
								value={customText}
								onChange={(e) => setCustomText(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && !e.nativeEvent.isComposing) {
										e.preventDefault();
										handleCustomSubmit();
									}
								}}
							/>
						</div>
					) : null}
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
				Chat about this
			</button>
		</div>
	);
}

export function QuestionDialog({ pending }: { pending: PendingQuestion }) {
	const { questionId, params } = pending;
	const questions = params.questions;
	const [activeTab, setActiveTab] = useState(0);
	const [answers, setAnswers] = useState<Map<number, QuestionAnswer>>(new Map());
	const [focusedOptions, setFocusedOptions] = useState<number[]>(questions.map(() => 0));

	const handleAnswer = useCallback(
		(a: QuestionAnswer) => {
			setAnswers((prev) => {
				const next = new Map(prev);
				next.set(a.questionIndex, a);
				return next;
			});
		},
		[],
	);

	const handleDismiss = useCallback(() => {
		void chatStore.dismissQuestion(questionId);
	}, [questionId]);

	const allAnswered = questions.every((_, i) => answers.has(i));

	const handleSubmit = useCallback(() => {
		if (!allAnswered) return;
		const result: QuestionnaireResult = {
			answers: Array.from(answers.values()),
			cancelled: false,
		};
		void chatStore.submitQuestionResponse(questionId, result);
	}, [questionId, answers, allAnswered]);

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
				/>

				<div className="mt-3 flex justify-end">
					<button
						className={`rounded-lg px-4 py-1.5 text-sm font-medium transition-colors ${ allAnswered ? "inno-primary-button" : "cursor-not-allowed bg-[var(--inno-surface-muted)] text-[var(--inno-text-subtle)]" }`}
						disabled={!allAnswered}
						onClick={handleSubmit}
					>
						Submit
					</button>
				</div>
			</div>
		</motion.div>
	);
}
