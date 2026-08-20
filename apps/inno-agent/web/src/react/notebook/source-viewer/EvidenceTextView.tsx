import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { EvidenceBlock } from "../../../types/wiki.js";
import { findTextOffsetsAtOccurrence, findUniqueTextOffsets, preferredScrollBehavior } from "./text-highlight.js";

export interface EvidenceTextViewProps {
	blocks: readonly EvidenceBlock[];
	targetBlockId?: string;
	quote?: string;
	occurrence?: number;
	emptyMessage?: string;
}

function BlockText({ text, quote, occurrence }: { text: string; quote?: string; occurrence?: number }) {
	const match = quote === undefined
		? { status: "none" as const }
		: occurrence === undefined ? findUniqueTextOffsets(text, quote) : findTextOffsetsAtOccurrence(text, quote, occurrence);
	if (match.status !== "unique") return <>{text}</>;
	return (
		<>
			{text.slice(0, match.start)}
			<mark className="rounded-sm bg-[var(--inno-warning-bg)] px-0.5 text-inherit">{text.slice(match.start, match.end)}</mark>
			{text.slice(match.end)}
		</>
	);
}

function blockLocation(block: EvidenceBlock, t: TFunction): string | undefined {
	if (block.page !== undefined) return t("notebook.page.sourceViewer.location.page", { page: block.page });
	if (block.heading && block.paragraph !== undefined) return t("notebook.page.sourceViewer.location.headingParagraph", { heading: block.heading, paragraph: block.paragraph });
	if (block.paragraph !== undefined) return t("notebook.page.sourceViewer.location.paragraph", { paragraph: block.paragraph });
	return block.heading;
}

export function EvidenceTextView({ blocks, targetBlockId, quote, occurrence, emptyMessage = "No extracted evidence is available." }: EvidenceTextViewProps) {
	const { t } = useTranslation();
	const targetRef = useRef<HTMLElement | null>(null);

	useEffect(() => {
		targetRef.current?.scrollIntoView?.({ block: "center", behavior: preferredScrollBehavior() });
	}, [blocks, targetBlockId]);

	if (blocks.length === 0) {
		return <div data-evidence-text-view className="p-5 text-sm text-[var(--inno-text-muted)]">{emptyMessage === "No extracted evidence is available." ? t("notebook.page.sourceViewer.evidence.empty") : emptyMessage}</div>;
	}

	return (
		<div data-evidence-text-view className="space-y-3 p-4">
			{blocks.map((block) => {
				const targeted = block.id === targetBlockId;
				return (
					<article
						key={block.id}
						ref={targeted ? targetRef : undefined}
						data-block-id={block.id}
						aria-current={targeted ? "location" : undefined}
						className={`border-l-2 px-3 py-2 ${targeted ? "border-[var(--inno-accent)] bg-[var(--inno-accent-soft)]" : "border-[var(--inno-border)]"}`}
					>
						{blockLocation(block, t) ? (
							<div className="mb-1 text-xs font-medium text-[var(--inno-text-muted)]">{blockLocation(block, t)}</div>
						) : null}
						<div className="whitespace-pre-wrap break-words text-sm leading-6 text-[var(--inno-text)]">
							<BlockText text={block.text} quote={targeted ? quote : undefined} occurrence={targeted ? occurrence : undefined} />
						</div>
					</article>
				);
			})}
		</div>
	);
}
