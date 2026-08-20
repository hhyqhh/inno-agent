import { useLayoutEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { marked, type Token, type Tokens } from "marked";
import type { EvidenceBlock, EvidenceSliceResponse } from "../../../types/wiki.js";
import { clearTextHighlights, findTextRangeAtOccurrence, findUniqueTextRange, highlightTextRange, preferredScrollBehavior } from "./text-highlight.js";

export function evidenceBlocksInDocumentOrder(evidence: EvidenceSliceResponse): EvidenceBlock[] {
	const byId = new Map<string, EvidenceBlock>();
	const suppliedPrecedingCount = evidence.precedingNeighborCount;
	const precedingCount = suppliedPrecedingCount !== undefined
		&& Number.isSafeInteger(suppliedPrecedingCount)
		&& suppliedPrecedingCount >= 0
		&& suppliedPrecedingCount <= evidence.neighbors.length
		? suppliedPrecedingCount
		: evidence.neighbors.length;
	// Newer responses identify where the target belongs between the two neighbor
	// slices. Keep the legacy append behavior for responses from older servers.
	const blocks = [
		...evidence.neighbors.slice(0, precedingCount),
		evidence.target,
		...evidence.neighbors.slice(precedingCount),
	];
	for (const block of blocks) byId.set(block.id, block);
	return [...byId.values()];
}

function blockLocation(block: EvidenceBlock, t: TFunction): string | undefined {
	if (block.page !== undefined) return t("notebook.page.sourceViewer.location.page", { page: block.page });
	if (block.heading && block.paragraph !== undefined) return t("notebook.page.sourceViewer.location.headingParagraph", { heading: block.heading, paragraph: block.paragraph });
	if (block.paragraph !== undefined) return t("notebook.page.sourceViewer.location.paragraph", { paragraph: block.paragraph });
	return block.heading;
}

function renderTokens(tokens: readonly Token[], keyPrefix: string): ReactNode[] {
	return tokens.map((token, index) => renderToken(token, `${keyPrefix}-${index}`));
}

function renderTableCell(cell: Tokens.TableCell, key: string): ReactNode {
	const Tag = cell.header ? "th" : "td";
	return (
		<Tag key={key} className="border border-[var(--inno-border)] px-2 py-1 text-left align-top">
			{renderTokens(cell.tokens, `${key}-inline`)}
		</Tag>
	);
}

function renderHeading(token: Tokens.Heading, key: string): ReactNode {
	const content = renderTokens(token.tokens, `${key}-inline`);
	const className = "mb-2 mt-3 font-semibold text-[var(--inno-text)] first:mt-0";
	if (token.depth === 1) return <h1 key={key} className={`${className} text-xl`}>{content}</h1>;
	if (token.depth === 2) return <h2 key={key} className={`${className} text-lg`}>{content}</h2>;
	if (token.depth === 3) return <h3 key={key} className={`${className} text-base`}>{content}</h3>;
	if (token.depth === 4) return <h4 key={key} className={className}>{content}</h4>;
	if (token.depth === 5) return <h5 key={key} className={className}>{content}</h5>;
	return <h6 key={key} className={className}>{content}</h6>;
}

function renderToken(token: Token, key: string): ReactNode {
	switch (token.type) {
		case "space":
		case "def":
			return null;
		case "heading":
			return renderHeading(token as Tokens.Heading, key);
		case "paragraph": {
			const paragraph = token as Tokens.Paragraph;
			return <p key={key} className="mb-2 whitespace-pre-wrap break-words last:mb-0">{renderTokens(paragraph.tokens, `${key}-inline`)}</p>;
		}
		case "text": {
			const text = token as Tokens.Text;
			return text.tokens?.length ? <span key={key}>{renderTokens(text.tokens, `${key}-inline`)}</span> : text.text;
		}
		case "escape":
			return (token as Tokens.Escape).text;
		case "strong": {
			const strong = token as Tokens.Strong;
			return <strong key={key}>{renderTokens(strong.tokens, `${key}-inline`)}</strong>;
		}
		case "em": {
			const emphasis = token as Tokens.Em;
			return <em key={key}>{renderTokens(emphasis.tokens, `${key}-inline`)}</em>;
		}
		case "del": {
			const deleted = token as Tokens.Del;
			return <del key={key}>{renderTokens(deleted.tokens, `${key}-inline`)}</del>;
		}
		case "codespan":
			return <code key={key} className="rounded bg-[var(--inno-surface-muted)] px-1 py-0.5">{(token as Tokens.Codespan).text}</code>;
		case "code":
			return <pre key={key} className="my-2 overflow-x-auto rounded bg-[var(--inno-surface-muted)] p-3"><code>{(token as Tokens.Code).text}</code></pre>;
		case "blockquote": {
			const blockquote = token as Tokens.Blockquote;
			return <blockquote key={key} className="my-2 border-l-2 border-[var(--inno-border)] pl-3">{renderTokens(blockquote.tokens, `${key}-block`)}</blockquote>;
		}
		case "list": {
			const list = token as Tokens.List;
			const Tag = list.ordered ? "ol" : "ul";
			return (
				<Tag key={key} className={`my-2 pl-5 ${list.ordered ? "list-decimal" : "list-disc"}`}>
					{list.items.map((item: Tokens.ListItem, index: number) => (
						<li key={`${key}-item-${index}`}>
							{item.task ? <span aria-hidden="true">[{item.checked ? "x" : " "}] </span> : null}
							{renderTokens(item.tokens, `${key}-item-${index}`)}
						</li>
					))}
				</Tag>
			);
		}
		case "link": {
			const link = token as Tokens.Link;
			return <span key={key}>{renderTokens(link.tokens, `${key}-inline`)}</span>;
		}
		case "image":
			return <span key={key} data-markdown-image-omitted>{(token as Tokens.Image).text}</span>;
		case "html":
			return <span key={key}>{token.raw}</span>;
		case "br":
			return <br key={key} />;
		case "hr":
			return <hr key={key} className="my-3 border-[var(--inno-border)]" />;
		case "table": {
			const table = token as Tokens.Table;
			return (
				<div key={key} className="my-2 overflow-x-auto">
					<table className="w-full border-collapse text-sm">
						<thead><tr>{table.header.map((cell: Tokens.TableCell, index: number) => renderTableCell(cell, `${key}-head-${index}`))}</tr></thead>
						<tbody>{table.rows.map((row: Tokens.TableCell[], rowIndex: number) => <tr key={`${key}-row-${rowIndex}`}>{row.map((cell: Tokens.TableCell, cellIndex: number) => renderTableCell(cell, `${key}-row-${rowIndex}-${cellIndex}`))}</tr>)}</tbody>
					</table>
				</div>
			);
		}
		default: {
			const generic = token as Token & { text?: string; tokens?: Token[] };
			if (generic.tokens?.length) return <span key={key}>{renderTokens(generic.tokens, `${key}-inline`)}</span>;
			return generic.text ?? token.raw;
		}
	}
}

function plainTokenText(token: Token): string {
	switch (token.type) {
		case "space":
		case "br":
		case "hr":
			return "\n";
		case "def":
			return "";
		case "code":
			return (token as Tokens.Code).text;
		case "codespan":
			return (token as Tokens.Codespan).text;
		case "escape":
			return (token as Tokens.Escape).text;
		case "html":
			return token.raw;
		case "image":
			return (token as Tokens.Image).text;
		case "list": {
			const list = token as Tokens.List;
			return list.items.map((item: Tokens.ListItem) => plainTokenList(item.tokens)).join("\n");
		}
		case "table": {
			const table = token as Tokens.Table;
			return [table.header, ...table.rows]
				.map((row: Tokens.TableCell[]) => row.map((cell: Tokens.TableCell) => plainTokenList(cell.tokens)).join(" "))
				.join("\n");
		}
		default: {
			const withChildren = token as Token & { text?: string; tokens?: Token[] };
			return withChildren.tokens?.length ? plainTokenList(withChildren.tokens) : (withChildren.text ?? token.raw);
		}
	}
}

function plainTokenList(tokens: readonly Token[]): string {
	return tokens.map(plainTokenText).join("");
}

function visibleMarkdownText(markdown: string): string {
	return plainTokenList(marked.lexer(markdown)).trim();
}

function normalizedRawBlock(markdown: string): string {
	return markdown.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
}

function documentTokens(markdown: string): Token[] {
	return marked.lexer(markdown).filter((token) => token.type !== "space" && token.type !== "def");
}

type DocumentTargetMapping =
	| { status: "none" }
	| { status: "ambiguous" }
	| { status: "unique"; index: number };

function mapEvidenceTarget(tokens: readonly Token[], evidence?: EvidenceSliceResponse): DocumentTargetMapping {
	if (!evidence) return { status: "none" };
	const target = normalizedRawBlock(evidence.target.text);
	const matches = tokens
		.map((token, index) => ({ index, raw: normalizedRawBlock(token.raw) }))
		.filter((candidate) => candidate.raw === target);
	if (matches.length === 1) return { status: "unique", index: matches[0].index };
	return { status: matches.length > 1 ? "ambiguous" : "none" };
}

function MarkdownDocumentBlock({
	token,
	index,
	targeted,
	quote,
	occurrence,
}: {
	token: Token;
	index: number;
	targeted: boolean;
	quote?: string;
	occurrence?: number;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const visibleQuote = quote ? visibleMarkdownText(quote) : undefined;

	useLayoutEffect(() => {
		const container = containerRef.current;
		if (!targeted || !container) return;
		clearTextHighlights(container);
		container.scrollIntoView?.({ block: "center", behavior: preferredScrollBehavior() });
		if (!visibleQuote) return;
		const match = occurrence === undefined
			? findUniqueTextRange(container, visibleQuote)
			: findTextRangeAtOccurrence(container, visibleQuote, occurrence);
		if (match.status === "unique") highlightTextRange(match.range);
		return () => clearTextHighlights(container);
	}, [targeted, visibleQuote, occurrence, token.raw]);

	return (
		<div
			ref={containerRef}
			data-markdown-document-block
			data-markdown-block-index={index}
			aria-current={targeted ? "location" : undefined}
			className={targeted ? "border-l-2 border-[var(--inno-accent)] bg-[var(--inno-accent-soft)] px-3 py-2" : undefined}
		>
			{renderToken(token, `document-${index}`)}
		</div>
	);
}

function MarkdownBlockItem({ block, targeted, quote, occurrence, t }: { block: EvidenceBlock; targeted: boolean; quote?: string; occurrence?: number; t: TFunction }) {
	const containerRef = useRef<HTMLDivElement>(null);
	const rendered = renderTokens(marked.lexer(block.text), block.id);
	const visibleQuote = quote ? visibleMarkdownText(quote) : undefined;

	useLayoutEffect(() => {
		const container = containerRef.current;
		if (!targeted || !container) return;
		clearTextHighlights(container);
		container.scrollIntoView?.({ block: "center", behavior: preferredScrollBehavior() });
		if (!visibleQuote) return;
		const match = occurrence === undefined
			? findUniqueTextRange(container, visibleQuote)
			: findTextRangeAtOccurrence(container, visibleQuote, occurrence);
		if (match.status === "unique") highlightTextRange(match.range);
		return () => clearTextHighlights(container);
	}, [targeted, visibleQuote, occurrence, block.id]);

	return (
		<article
			data-block-id={block.id}
			aria-current={targeted ? "location" : undefined}
			className={`border-l-2 px-3 py-2 ${targeted ? "border-[var(--inno-accent)] bg-[var(--inno-accent-soft)]" : "border-[var(--inno-border)]"}`}
		>
			{blockLocation(block, t) ? (
				<div className="mb-1 text-xs font-medium text-[var(--inno-text-muted)]">{blockLocation(block, t)}</div>
			) : null}
			<div ref={containerRef} className="text-sm leading-6 text-[var(--inno-text)]">{rendered}</div>
		</article>
	);
}

export function MarkdownSourceView({
	content,
	evidence,
	quote,
	occurrence,
}: {
	content?: string;
	evidence?: EvidenceSliceResponse;
	quote?: string;
	occurrence?: number;
}) {
	const { t } = useTranslation();
	if (content !== undefined) {
		const tokens = documentTokens(content);
		const mapping = mapEvidenceTarget(tokens, evidence);
		return (
			<div data-markdown-source-view className="h-full overflow-y-auto p-4">
				{evidence && mapping.status !== "unique" ? (
					<div role="alert" className="mb-3 border-l-2 border-[var(--inno-warning)] bg-[var(--inno-warning-bg)] px-3 py-2 text-sm text-[var(--inno-text)]">
						{t(mapping.status === "ambiguous"
							? "notebook.page.sourceViewer.markdown.targetAmbiguous"
							: "notebook.page.sourceViewer.markdown.targetMissing")}
					</div>
				) : null}
				<div className="text-sm leading-6 text-[var(--inno-text)]">
					{tokens.map((token, index) => (
						<MarkdownDocumentBlock
							key={`${token.type}-${index}`}
							token={token}
							index={index}
							targeted={mapping.status === "unique" && mapping.index === index}
							quote={mapping.status === "unique" && mapping.index === index ? quote : undefined}
							occurrence={mapping.status === "unique" && mapping.index === index ? occurrence : undefined}
						/>
					))}
				</div>
			</div>
		);
	}

	if (!evidence) return null;
	const blocks = evidenceBlocksInDocumentOrder(evidence);
	return (
		<div data-markdown-source-view className="h-full overflow-y-auto space-y-3 p-4">
			<div role="alert" className="border-l-2 border-[var(--inno-warning)] bg-[var(--inno-warning-bg)] px-3 py-2 text-sm text-[var(--inno-text)]">
				{t("notebook.page.sourceViewer.markdown.extractedFallback")}
			</div>
			{blocks.map((block) => (
				<MarkdownBlockItem
					key={block.id}
					block={block}
					targeted={block.id === evidence.target.id}
					quote={block.id === evidence.target.id ? quote : undefined}
					occurrence={block.id === evidence.target.id ? occurrence : undefined}
					t={t}
				/>
			))}
		</div>
	);
}
