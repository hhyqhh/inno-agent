import { useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import type { QuestionData } from "../../types/chat.js";
import { Tabs, TabPanel } from "../ui/index.js";

/** Pending and archived questionnaires share one width, header and panel layout. */
export function QuestionCard({ questions, activeTab, onTabChange, isAnswered, completed = false, children, footer }: {
	questions: QuestionData[];
	activeTab: number;
	onTabChange: (index: number) => void;
	isAnswered: (index: number) => boolean;
	completed?: boolean;
	children: ReactNode;
	footer?: ReactNode;
}) {
	const { t } = useTranslation();
	const tabsId = useId();
	return (
		<div className="inno-question-card @container w-full min-w-0 max-w-[36.5rem] space-y-3 rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] p-3">
			<div className="flex min-w-0 items-center gap-3">
				{questions.length > 1 ? (
					<Tabs id={tabsId} value={String(activeTab)} onValueChange={(value) => onTabChange(Number(value))}
						ariaLabel={t("question.questions")} className="min-w-0 flex-1"
						items={questions.map((question, index) => ({
							value: String(index), ariaLabel: question.header,
							label: <>{question.header}{isAnswered(index) ? <Check size={14} aria-hidden="true" /> : null}</>,
						}))} />
				) : <span className="min-w-0 text-xs font-medium text-[var(--inno-text-muted)]">{questions[activeTab].header}</span>}
				<div className="ml-auto flex shrink-0 items-center gap-2 text-xs">
					{completed ? <span className="text-[var(--inno-accent)]">{t("question.answered")}</span> : null}
					<span className="tabular-nums text-[var(--inno-text-subtle)]">{activeTab + 1} / {questions.length}</span>
				</div>
			</div>
			<TabPanel id={`${tabsId}-panel`} labelledBy={questions.length > 1 ? `${tabsId}-tab-${activeTab}` : undefined}
				aria-label={questions.length === 1 ? questions[activeTab].header : undefined} className="min-w-0">
				{children}
			</TabPanel>
			{footer}
		</div>
	);
}
