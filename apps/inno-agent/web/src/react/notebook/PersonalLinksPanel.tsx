import { useEffect, useMemo, useState } from "react";
import { Check, Link2, RefreshCw, Save, Sparkles, X } from "lucide-react";
import type { PersonalLink } from "../../types/learner.js";
import type { WikiGraphNode } from "../../types/wiki.js";
import { createPersonalLink, listPersonalLinks, reviewPersonalLinksBatch } from "../../api/learner.js";
import { sessionsStore } from "../../stores/sessions-store.js";

interface PersonalLinksPanelProps {
	nodes: WikiGraphNode[];
	selectedIds: string[];
	onResetSelection: () => void;
	onClose: () => void;
	onReviewComplete: (feedback: string) => void;
	onLinksChange: (links: PersonalLink[]) => void;
}

export function PersonalLinksPanel({ nodes, selectedIds, onResetSelection, onClose, onReviewComplete, onLinksChange }: PersonalLinksPanelProps) {
	const [links, setLinks] = useState<PersonalLink[]>([]);
	const [reason, setReason] = useState("");
	const [isSaving, setIsSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [roundId] = useState(() => `link-round-${crypto.randomUUID()}`);
	const [roundLinkIds, setRoundLinkIds] = useState<string[]>([]);
	const [isReviewingRound, setIsReviewingRound] = useState(false);

	const selectedNodes = useMemo(
		() => selectedIds.map((id) => nodes.find((node) => node.id === id)).filter((node): node is WikiGraphNode => Boolean(node)),
		[nodes, selectedIds],
	);

	useEffect(() => {
		let cancelled = false;
		void (async () => {
			try {
				const response = await listPersonalLinks();
				if (!cancelled) setLinks(response.links);
			} catch (err) {
				if (!cancelled) setError(err instanceof Error ? err.message : "无法读取个人连接。");
			}
		})();
		return () => { cancelled = true; };
	}, []);

	useEffect(() => {
		onLinksChange(links);
	}, [links, onLinksChange]);

	async function save(): Promise<void> {
		if (selectedIds.length !== 2 || !reason.trim()) return;
		setIsSaving(true);
		try {
			const link = await createPersonalLink({ source: selectedIds[0]!, target: selectedIds[1]!, reason, batch_id: roundId });
			setLinks((current) => [link, ...current]);
			setRoundLinkIds((current) => [...current, link.id]);
			setReason("");
			onResetSelection();
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : "保存连接失败。");
		} finally {
			setIsSaving(false);
		}
	}

	async function finishRound(): Promise<void> {
		if (roundLinkIds.length === 0) return;
		setIsReviewingRound(true);
		try {
			const result = await reviewPersonalLinksBatch(roundLinkIds, sessionsStore.currentSessionId);
			const reviewedById = new Map(result.links.map((link) => [link.id, link]));
			setLinks((current) => current.map((link) => reviewedById.get(link.id) ?? link));
			setRoundLinkIds([]);
			setError(null);
			onReviewComplete(result.chat_feedback);
		} catch (err) {
			setError(err instanceof Error ? err.message : "本轮连接评议失败。");
		} finally {
			setIsReviewingRound(false);
		}
	}

	const isReasonDialogOpen = selectedIds.length === 2;
	const selectionHint = selectedIds.length === 0
		? "请选择第一个节点"
		: selectedIds.length === 1
			? `已选「${selectedNodes[0]?.title ?? selectedIds[0]}」，请选择第二个节点`
			: "已选两个节点，请说明你的联想理由。";

	return (
		<>
			<div className="absolute left-3 top-3 z-20 flex max-w-[calc(100%-1.5rem)] items-center gap-2 rounded-md border border-teal-200 bg-white/95 px-3 py-2 shadow-sm backdrop-blur">
				<Link2 size={15} className="shrink-0 text-teal-700" />
				<span className="truncate text-xs font-medium text-teal-950">{selectionHint}</span>
				<button type="button" onClick={onResetSelection} disabled={selectedIds.length === 0} className="shrink-0 rounded p-1 text-teal-800 hover:bg-teal-50 disabled:opacity-40" title="重新选择节点"><RefreshCw size={14} /></button>
				<button type="button" onClick={onClose} className="shrink-0 rounded p-1 text-[var(--inno-text-subtle)] hover:bg-[var(--inno-surface-muted)]" title="退出共建模式"><X size={15} /></button>
			</div>

			{roundLinkIds.length > 0 ? (
				<div className="absolute bottom-3 left-1/2 z-20 flex w-[min(34rem,calc(100%-1.5rem))] -translate-x-1/2 items-center gap-3 rounded-md border border-teal-200 bg-white/95 px-3 py-2 shadow-lg backdrop-blur">
					<Check size={16} className="shrink-0 text-teal-700" />
					<div className="min-w-0 flex-1"><div className="text-xs font-medium text-teal-950">本轮已加入 {roundLinkIds.length} 条连接</div><div className="truncate text-xs text-teal-800">可以继续选节点，结束时再让 AI 统一评议。</div></div>
					<button type="button" disabled={isReviewingRound} onClick={() => void finishRound()} className="inline-flex shrink-0 items-center gap-1 rounded-md bg-teal-700 px-2.5 py-1.5 text-xs text-white hover:bg-teal-800 disabled:opacity-50"><Sparkles size={13} /> {isReviewingRound ? "评议中" : "完成本轮"}</button>
				</div>
			) : null}

			{isReasonDialogOpen ? (
				<div className="absolute inset-0 z-30 flex items-end justify-center bg-slate-950/10 p-3 sm:items-center">
					<div className="w-full max-w-lg rounded-lg border border-[var(--inno-border-strong)] bg-[var(--inno-surface)] p-4 shadow-xl">
						<div className="flex items-center justify-between gap-3"><div className="text-sm font-medium text-[var(--inno-text)]">为什么你认为这两个概念有关？</div><button type="button" onClick={onResetSelection} className="rounded p-1 text-[var(--inno-text-subtle)] hover:bg-[var(--inno-surface-muted)]" title="取消本次连接"><X size={16} /></button></div>
						<div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 text-xs"><div className="truncate rounded border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] px-2 py-1.5 text-[var(--inno-text)]">{selectedNodes[0]?.title ?? selectedIds[0]}</div><Link2 size={14} className="text-teal-700" /><div className="truncate rounded border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] px-2 py-1.5 text-[var(--inno-text)]">{selectedNodes[1]?.title ?? selectedIds[1]}</div></div>
						<textarea autoFocus value={reason} onChange={(event) => setReason(event.target.value)} placeholder="例如：它们都在回答什么问题？中间发生了什么？" className="mt-3 min-h-28 w-full resize-y rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-2 text-sm text-[var(--inno-text)] outline-none placeholder:text-[var(--inno-text-subtle)] focus:border-teal-700" />
						{error ? <div className="mt-2 text-xs text-rose-700">{error}</div> : null}
						<div className="mt-3 flex justify-end gap-2"><button type="button" onClick={onResetSelection} className="rounded-md px-3 py-1.5 text-xs text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)]">重选</button><button type="button" disabled={!reason.trim() || isSaving} onClick={() => void save()} className="inline-flex items-center gap-1 rounded-md inno-primary-button px-3 py-1.5 text-xs text-white disabled:cursor-not-allowed disabled:opacity-50"><Save size={13} /> {isSaving ? "保存中" : "加入本轮"}</button></div>
					</div>
				</div>
			) : null}

		</>
	);
}
