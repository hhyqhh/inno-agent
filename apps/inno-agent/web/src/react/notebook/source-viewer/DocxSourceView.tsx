import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { renderAsync } from "docx-preview";
import type { EvidenceBlock, EvidenceSliceResponse } from "../../../types/wiki.js";
import { EvidenceTextView } from "./EvidenceTextView.js";
import { evidenceBlocksInDocumentOrder } from "./MarkdownSourceView.js";
import {
	clearTextHighlights,
	findTextRangeAtOccurrence,
	findUniqueTextRange,
	highlightTextRange,
	preferredScrollBehavior,
} from "./text-highlight.js";

interface DocxSourceViewProps {
	content: ArrayBuffer;
	evidence?: EvidenceSliceResponse;
	quote?: string;
	occurrence?: number;
	forceExtractedFallback?: boolean;
}

const DOCX_OPTIONS = {
	className: "docx",
	inWrapper: true,
	ignoreWidth: true,
	ignoreHeight: false,
	ignoreFonts: false,
	breakPages: true,
	ignoreLastRenderedPageBreak: true,
	experimental: false,
	trimXmlDeclaration: true,
	useBase64URL: false,
	renderHeaders: true,
	renderFooters: true,
	renderFootnotes: true,
	renderEndnotes: true,
};

function sanitizeDocxDom(root: HTMLElement): void {
	for (const active of root.querySelectorAll("script, iframe, object, embed, form")) active.remove();
	for (const element of root.querySelectorAll("*")) {
		for (const attribute of [...element.attributes]) {
			if (attribute.name.toLowerCase().startsWith("on") || attribute.name.toLowerCase() === "srcdoc") {
				element.removeAttribute(attribute.name);
			}
		}
	}
	for (const link of root.querySelectorAll("a")) {
		link.removeAttribute("href");
		link.removeAttribute("target");
		link.removeAttribute("ping");
		link.removeAttribute("download");
		link.setAttribute("rel", "noopener noreferrer");
		link.setAttribute("aria-disabled", "true");
		link.setAttribute("tabindex", "-1");
		link.addEventListener("click", (event) => event.preventDefault());
	}
}

function fallbackMessage(kind: "none" | "ambiguous" | "forced" | "error", t: TFunction, detail?: string): string {
	if (kind === "forced") {
		return t("notebook.page.sourceViewer.docx.forced");
	}
	if (kind === "ambiguous") {
		return t("notebook.page.sourceViewer.docx.ambiguous");
	}
	if (kind === "none") {
		return t("notebook.page.sourceViewer.docx.none");
	}
	return t("notebook.page.sourceViewer.docx.error", { detail: detail ? `: ${detail}` : "" });
}

function normalizeDocxBlockText(text: string): string {
	return text.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function targetDocxParagraph(paragraphs: readonly HTMLElement[], target?: EvidenceBlock): HTMLElement | undefined {
	if (!target) return undefined;
	const targetText = normalizeDocxBlockText(target.text);
	if (targetText.length > 0) {
		const textMatches = paragraphs.filter((paragraph) => normalizeDocxBlockText(paragraph.textContent ?? "") === targetText);
		if (textMatches.length === 1) return textMatches[0];
	}
	if (target.paragraph !== undefined && Number.isSafeInteger(target.paragraph) && target.paragraph > 0) {
		return paragraphs[target.paragraph - 1];
	}
	return undefined;
}

function findUniqueDocxRange(root: HTMLElement, quote: string, occurrence?: number, target?: EvidenceBlock) {
	const paragraphs = [...root.querySelectorAll("p")];
	let searchRoots: Node[];
	if (paragraphs.length === 0) {
		searchRoots = [root];
	} else if (!target) {
		searchRoots = paragraphs;
	} else {
		const targetParagraph = targetDocxParagraph(paragraphs, target);
		searchRoots = targetParagraph ? [targetParagraph] : [];
	}
	let uniqueRange: Range | undefined;
	let count = 0;
	for (const searchRoot of searchRoots) {
		if (occurrence !== undefined) {
			const localMatches = findUniqueTextRange(searchRoot, quote);
			const localCount = localMatches.status === "unique" ? 1 : localMatches.status === "ambiguous" ? localMatches.count : 0;
			if (occurrence > count && occurrence <= count + localCount) {
				const match = findTextRangeAtOccurrence(searchRoot, quote, occurrence - count);
				if (match.status === "unique") return match;
				return { status: "none" as const };
			}
			count += localCount;
			continue;
		}
		const match = findUniqueTextRange(searchRoot, quote);
		if (match.status === "unique") {
			uniqueRange = match.range;
			count += 1;
		} else if (match.status === "ambiguous") {
			count += match.count;
		}
	}
	if (occurrence !== undefined) return { status: "none" as const };
	if (count === 0) return { status: "none" as const };
	if (count > 1 || uniqueRange === undefined) return { status: "ambiguous" as const, count };
	return { status: "unique" as const, range: uniqueRange };
}

export function DocxSourceView({ content, evidence, quote, occurrence, forceExtractedFallback = false }: DocxSourceViewProps) {
	const { t } = useTranslation();
	const containerRef = useRef<HTMLDivElement>(null);
	const styleRef = useRef<HTMLDivElement>(null);
	const [loading, setLoading] = useState(true);
	const [fallbackReason, setFallbackReason] = useState<string>();

	useEffect(() => {
		const controller = new AbortController();
		const container = containerRef.current;
		const styleHost = styleRef.current;
		if (container === null || styleHost === null) return () => controller.abort();
		container.replaceChildren();
		styleHost.replaceChildren();
		setLoading(true);
		setFallbackReason(undefined);
		if (forceExtractedFallback) {
			setLoading(false);
			return () => {
				controller.abort();
				container.replaceChildren();
				styleHost.replaceChildren();
			};
		}
		const staging = container.ownerDocument.createElement("div");
		const styleStaging = container.ownerDocument.createElement("div");

		void (async () => {
			try {
				await renderAsync(content.slice(0), staging, styleStaging, DOCX_OPTIONS);
				if (controller.signal.aborted) return;
				sanitizeDocxDom(staging);
				sanitizeDocxDom(styleStaging);
				styleHost.replaceChildren(...styleStaging.childNodes);
				container.replaceChildren(...staging.childNodes);
				if (quote) {
					const match = findUniqueDocxRange(container, quote, occurrence, evidence?.target);
					if (match.status !== "unique") {
						container.replaceChildren();
						setFallbackReason(fallbackMessage(match.status, t));
						return;
					}
					const marks = highlightTextRange(match.range);
					marks[0]?.scrollIntoView?.({ block: "center", behavior: preferredScrollBehavior() });
				}
			} catch (error) {
				if (!controller.signal.aborted) {
					container.replaceChildren();
					setFallbackReason(fallbackMessage("error", t, error instanceof Error ? error.message : undefined));
				}
			} finally {
				if (!controller.signal.aborted) setLoading(false);
			}
		})();

		return () => {
			controller.abort();
			clearTextHighlights(container);
			container.replaceChildren();
			styleHost.replaceChildren();
		};
	}, [
		content,
		evidence?.target.id,
		evidence?.target.text,
		evidence?.target.paragraph,
		quote,
		occurrence,
		forceExtractedFallback,
		t,
	]);

	const activeFallbackReason = forceExtractedFallback ? fallbackMessage("forced", t) : fallbackReason;

	return (
		<div className="relative h-full overflow-y-auto bg-[var(--inno-surface-muted)]">
			{activeFallbackReason ? (
				<div className="h-full overflow-y-auto bg-[var(--inno-surface)]">
					<div role="alert" className="border-b border-[var(--inno-warning)] bg-[var(--inno-warning-bg)] px-4 py-2 text-sm text-[var(--inno-text)]">
						{activeFallbackReason}
				</div>
				<EvidenceTextView
					blocks={evidence ? evidenceBlocksInDocumentOrder(evidence) : []}
					targetBlockId={evidence?.target.id}
					quote={quote}
					occurrence={occurrence}
					emptyMessage={t("notebook.page.sourceViewer.evidence.originalDownload")}
				/>
				</div>
			) : null}
			<div className={activeFallbackReason ? "hidden" : "h-full"}>
				{loading ? (
					<div className="absolute inset-0 flex items-center justify-center text-sm text-[var(--inno-text-muted)]" aria-live="polite">
						{t("notebook.page.sourceViewer.docx.rendering")}
					</div>
				) : null}
				<div ref={styleRef} data-docx-style-host />
				<div ref={containerRef} className={`docx-host px-4 py-4 ${loading ? "invisible" : ""}`} />
			</div>
		</div>
	);
}
