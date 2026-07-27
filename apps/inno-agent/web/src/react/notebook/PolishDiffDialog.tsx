import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Check, Sparkles, X } from "lucide-react";
import type { PolishPreview } from "../../stores/notes-store.js";

interface DiffLine {
	type: "same" | "added" | "removed";
	text: string;
	oldLine?: number;
	newLine?: number;
}

function splitLines(content: string): string[] {
	return content.length === 0 ? [] : content.split("\n");
}

function fallbackDiff(before: string[], after: string[]): DiffLine[] {
	let prefix = 0;
	while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
	let suffix = 0;
	while (
		suffix < before.length - prefix &&
		suffix < after.length - prefix &&
		before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
	) suffix += 1;
	const lines: DiffLine[] = [];
	for (let index = 0; index < prefix; index += 1) {
		lines.push({ type: "same", text: before[index], oldLine: index + 1, newLine: index + 1 });
	}
	for (let index = prefix; index < before.length - suffix; index += 1) {
		lines.push({ type: "removed", text: before[index], oldLine: index + 1 });
	}
	for (let index = prefix; index < after.length - suffix; index += 1) {
		lines.push({ type: "added", text: after[index], newLine: index + 1 });
	}
	for (let offset = suffix; offset > 0; offset -= 1) {
		const oldIndex = before.length - offset;
		const newIndex = after.length - offset;
		lines.push({ type: "same", text: before[oldIndex], oldLine: oldIndex + 1, newLine: newIndex + 1 });
	}
	return lines;
}

export function buildLineDiff(originalContent: string, polishedContent: string): DiffLine[] {
	const before = splitLines(originalContent);
	const after = splitLines(polishedContent);
	const rows = before.length + 1;
	const columns = after.length + 1;
	if (rows * columns > 600_000) return fallbackDiff(before, after);

	const lcs = new Uint32Array(rows * columns);
	for (let oldIndex = before.length - 1; oldIndex >= 0; oldIndex -= 1) {
		for (let newIndex = after.length - 1; newIndex >= 0; newIndex -= 1) {
			const cell = oldIndex * columns + newIndex;
			lcs[cell] = before[oldIndex] === after[newIndex]
				? lcs[(oldIndex + 1) * columns + newIndex + 1] + 1
				: Math.max(lcs[(oldIndex + 1) * columns + newIndex], lcs[oldIndex * columns + newIndex + 1]);
		}
	}

	const lines: DiffLine[] = [];
	let oldIndex = 0;
	let newIndex = 0;
	while (oldIndex < before.length && newIndex < after.length) {
		if (before[oldIndex] === after[newIndex]) {
			lines.push({ type: "same", text: before[oldIndex], oldLine: oldIndex + 1, newLine: newIndex + 1 });
			oldIndex += 1;
			newIndex += 1;
		} else if (lcs[(oldIndex + 1) * columns + newIndex] >= lcs[oldIndex * columns + newIndex + 1]) {
			lines.push({ type: "removed", text: before[oldIndex], oldLine: oldIndex + 1 });
			oldIndex += 1;
		} else {
			lines.push({ type: "added", text: after[newIndex], newLine: newIndex + 1 });
			newIndex += 1;
		}
	}
	while (oldIndex < before.length) {
		lines.push({ type: "removed", text: before[oldIndex], oldLine: oldIndex + 1 });
		oldIndex += 1;
	}
	while (newIndex < after.length) {
		lines.push({ type: "added", text: after[newIndex], newLine: newIndex + 1 });
		newIndex += 1;
	}
	return lines;
}

interface PolishDiffPanelProps {
	preview: PolishPreview;
	onApply(): void;
	onDiscard(): void;
}

export function PolishDiffPanel({ preview, onApply, onDiscard }: PolishDiffPanelProps) {
	const { t } = useTranslation();
	const lines = useMemo(
		() => buildLineDiff(preview.originalContent, preview.polishedContent),
		[preview],
	);
	const additions = lines.filter((line) => line.type === "added").length;
	const deletions = lines.filter((line) => line.type === "removed").length;

	return (
		<div className="flex h-full min-h-0 flex-col bg-[var(--inno-surface)]" aria-labelledby="polish-diff-title">
				<div className="flex items-start gap-3 border-b border-[var(--inno-border)] px-5 py-4">
					<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-violet-50 text-violet-600">
						<Sparkles size={18} />
					</div>
					<div className="min-w-0 flex-1">
						<h2 id="polish-diff-title" className="font-semibold text-[var(--inno-text)]">{t("notes.polishDiff.title")}</h2>
						<p className="mt-1 text-xs text-[var(--inno-text-muted)]">
							{t("notes.polishDiff.summary", { additions, deletions })}
							{preview.templateLabel ? ` · ${t("notes.polishDiff.template", { template: preview.templateLabel })}` : ""}
						</p>
						{preview.suggestedTags.length > 0 ? (
							<p className="mt-1 truncate text-xs text-[var(--inno-text-muted)]">{t("notes.polishDiff.tags", { tags: preview.suggestedTags.join("、") })}</p>
						) : null}
					</div>
					<button type="button" className="rounded p-1.5 text-[var(--inno-text-subtle)] hover:bg-[var(--inno-surface-muted)]" onClick={onDiscard} aria-label={t("common.cancel")}>
						<X size={17} />
					</button>
				</div>

				<div className="min-h-0 flex-1 overflow-auto bg-[var(--inno-surface-muted)]/50 p-3">
					<div className="min-w-0 overflow-hidden rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] font-mono text-xs leading-5">
						{lines.map((line, index) => (
							<div
								key={`${index}:${line.type}`}
								className={`grid grid-cols-[42px_42px_24px_minmax(0,1fr)] ${line.type === "added" ? "bg-emerald-50 text-emerald-950" : line.type === "removed" ? "bg-red-50 text-red-950" : "text-[var(--inno-text-muted)]"}`}
							>
								<span className="select-none border-r border-[var(--inno-border)] px-2 text-right text-[var(--inno-text-subtle)]">{line.oldLine ?? ""}</span>
								<span className="select-none border-r border-[var(--inno-border)] px-2 text-right text-[var(--inno-text-subtle)]">{line.newLine ?? ""}</span>
								<span className="select-none text-center font-semibold">{line.type === "added" ? "+" : line.type === "removed" ? "−" : " "}</span>
								<span className="min-w-0 whitespace-pre-wrap break-words pr-4 [overflow-wrap:anywhere]">{line.text || " "}</span>
							</div>
						))}
					</div>
				</div>

				<div className="flex justify-end gap-2 border-t border-[var(--inno-border)] px-5 py-3">
					<button type="button" className="rounded-md border border-[var(--inno-border)] px-3.5 py-1.5 text-sm hover:bg-[var(--inno-surface-muted)]" onClick={onDiscard}>
						{t("notes.polishDiff.discard")}
					</button>
					<button type="button" className="inline-flex items-center gap-1.5 rounded-md bg-[var(--inno-accent)] px-3.5 py-1.5 text-sm font-medium text-white hover:opacity-90" onClick={onApply}>
						<Check size={15} />
						{t("notes.polishDiff.apply")}
					</button>
				</div>
		</div>
	);
}
