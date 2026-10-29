import { useTranslation } from "react-i18next";
import { useState } from "react";
import type { AnsweredQuestionnaire } from "../../utils/questionnaire.js";
import { normalizeMarkdownMath } from "../../utils/markdown-math.js";
import { Checkbox, Radio } from "../ui/index.js";
import { QuestionCard } from "./QuestionCard.js";

// Pure, props-driven questionnaire rendering. This module must NOT import
// stores or the api/ layer — apps/showcase reuses it (via chat/MessageBubble)
// to replay recorded sessions, so everything here renders from props alone.

export function OptionRow({
	label,
	description,
	selected,
	multi,
	groupName,
	onSelect,
	onFocus,
	readOnly = false,
}: {
	label: string;
	description: string;
	selected: boolean;
	multi: boolean;
	groupName?: string;
	onSelect?: () => void;
	onFocus?: () => void;
	readOnly?: boolean;
}) {
	return (
		<label
			className={`flex w-full min-w-0 items-start gap-2.5 rounded-lg border px-3 py-2 text-left text-xs transition-colors ${readOnly ? "cursor-default" : "cursor-pointer"} ${
				selected
					? "border-[var(--inno-accent)] bg-[var(--inno-accent-soft)] text-[var(--inno-text)]"
					: `border-[var(--inno-border)] bg-[var(--inno-surface)] text-[var(--inno-text)] ${readOnly ? "opacity-60" : "hover:border-[var(--inno-border-strong)] hover:bg-[var(--inno-surface-muted)]"}`
			}`}
			onMouseEnter={onFocus}
		>
			{multi ? <Checkbox className="mt-1" checked={selected} disabled={readOnly} aria-label={label} onChange={onSelect} onFocus={onFocus} />
				: <Radio className="mt-1" name={groupName} checked={selected} disabled={readOnly} aria-label={label} onChange={onSelect} onFocus={onFocus}
					onClick={selected ? onSelect : undefined} />}
			<span className="min-w-0 flex-1">
				<markdown-block className="font-medium" content={normalizeMarkdownMath(label)} />
				{description ? <markdown-block className="mt-0.5 text-xs text-[var(--inno-text-muted)]" content={normalizeMarkdownMath(description)} /> : null}
			</span>
		</label>
	);
}

/** Read-only counterpart to the pending questionnaire. It deliberately keeps
 * the original options visible so the selected state remains part of the
 * conversation instead of disappearing into generic tool-call details. */
export function AnsweredQuestionCard({ questionnaire }: { questionnaire: AnsweredQuestionnaire }) {
	const { t } = useTranslation();

	// Archived questions keep the same one-question-per-tab structure as the
	// pending card; expanding every question made completion change its size.
	const [activeTab, setActiveTab] = useState(0);
	const question = questionnaire.questions[activeTab];
	const answer = questionnaire.result.answers.find((item) => item.questionIndex === activeTab);
	const selectedLabels = new Set(answer?.selected ?? (answer?.kind === "option" && answer.answer ? [answer.answer] : []));
	return (
		<QuestionCard questions={questionnaire.questions} activeTab={activeTab} onTabChange={setActiveTab}
			isAnswered={(index) => questionnaire.result.answers.some((item) => item.questionIndex === index)} completed>
			<div className="min-w-0 space-y-3">
				<markdown-block className="text-xs font-medium text-[var(--inno-text)]" content={normalizeMarkdownMath(question.question)} />
				<div className="space-y-1.5">
					{question.options.map((option) => (
						<OptionRow key={option.label} label={option.label} description={option.description}
							selected={selectedLabels.has(option.label)} multi={question.multiSelect === true} readOnly />
					))}
				</div>
				{answer?.kind === "custom" && answer.answer ? (
					<div className="rounded-md border border-[var(--inno-accent)] bg-[var(--inno-accent-soft)] px-3 py-2 text-sm text-[var(--inno-text)] whitespace-pre-wrap break-words">
						{answer.answer}
					</div>
				) : null}
				{answer?.kind === "chat" ? (
					<div className="text-xs text-[var(--inno-text-muted)]">{answer.answer ?? t("question.answeredViaChat")}</div>
				) : null}
			</div>
		</QuestionCard>
	);
}
