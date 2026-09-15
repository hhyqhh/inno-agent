import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useContextUsage } from "./useContextUsage.js";
import "./context-usage.css";

export function formatContextTokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
	return String(Math.round(value));
}

function formatSummaryTokens(value: number): string {
	if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}M`;
	if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
	return String(Math.round(value));
}

function formatSummaryPercent(value: number): string {
	return `${Number(value.toFixed(1))}%`;
}

/** Mount with a session/model key so an old session's numbers can never flash. */
export function ContextUsage({ sessionId, streaming, revision, modelKey, activating = false }: { sessionId: string; streaming: boolean; revision: string; modelKey?: string; activating?: boolean }) {
	const { t } = useTranslation();
	const { data, loading, failed, detailsLoaded, refresh } = useContextUsage(sessionId, streaming, revision, modelKey, activating);
	const [open, setOpen] = useState(false);
	const [hint, setHint] = useState(false);
	const trigger = useRef<HTMLButtonElement>(null);
	const panel = useRef<HTMLDivElement>(null);
	const closeButton = useRef<HTMLButtonElement>(null);
	const skipNextFocusHint = useRef(false);
	const id = useId();
	const [position, setPosition] = useState({ left: 8, top: 8, maxHeight: 480, width: 336 });
	const percent = data?.status === "ready" ? data.percent : null;
	const known = percent !== null && percent !== undefined && data?.tokens !== null;
	const percentage = known ? `${percent.toFixed(1)}%` : "—";
	const amount = data?.tokens != null && data.contextWindow != null
		? `${formatContextTokens(data.tokens)} / ${formatContextTokens(data.contextWindow)}` : "—";
	const summaryAmount = data?.tokens != null && data.contextWindow != null
		? `${formatSummaryTokens(data.tokens)} / ${formatSummaryTokens(data.contextWindow)}` : "—";
	const status = loading ? "loading" : failed ? "failed" : data?.status === "pending" ? "pending" : data?.status === "inactive" ? "inactive" : "unavailable";
	const summary = known ? t("contextUsage.summary", {
		percent: formatSummaryPercent(percent),
		remaining: formatSummaryPercent(Math.max(0, 100 - percent)),
		amount: summaryAmount,
	}) : t(`contextUsage.${status}`);
	const close = () => {
		setOpen(false);
		setHint(false);
		if (trigger.current) {
			skipNextFocusHint.current = true;
			trigger.current.focus({ preventScroll: true });
		}
	};
	const handleClick = () => {
		if (!known) return;
		setHint(false);
		if (!detailsLoaded) {
			void refresh().then((latest) => {
				if (latest?.status === "ready" && latest.sessionId === sessionId) setOpen(true);
			});
			return;
		}
		setOpen(!open);
	};

	useLayoutEffect(() => {
		if (!open && !hint) return;
		const update = () => {
			if (!trigger.current) return;
			const rect = trigger.current.getBoundingClientRect();
			const view = window.visualViewport;
			const viewportLeft = view?.offsetLeft ?? 0;
			const viewportTop = view?.offsetTop ?? 0;
			const viewportWidth = view?.width ?? window.innerWidth;
			const width = Math.min(open ? 336 : known ? 240 : 180, viewportWidth - 16);
			const maxHeight = Math.max(0, (view?.height ?? window.innerHeight) - 16);
			const height = Math.min(panel.current?.offsetHeight || (open ? 380 : 40), maxHeight);
			const maxTop = viewportTop + maxHeight + 8 - height;
			const above = rect.top - height - 10;
			const maxLeft = viewportLeft + viewportWidth - width - 8;
			const left = open ? rect.right - width : rect.left + (rect.width - width) / 2;
			setPosition({
				left: Math.max(viewportLeft + 8, Math.min(left, maxLeft)),
				top: Math.max(viewportTop + 8, Math.min(above >= viewportTop + 8 ? above : rect.bottom + 10, maxTop)),
				width, maxHeight,
			});
		};
		update();
		const observer = new ResizeObserver(update);
		if (panel.current) observer.observe(panel.current);
		window.addEventListener("resize", update);
		window.addEventListener("scroll", update, true);
		window.visualViewport?.addEventListener("resize", update);
		window.visualViewport?.addEventListener("scroll", update);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", update);
			window.removeEventListener("scroll", update, true);
			window.visualViewport?.removeEventListener("resize", update);
			window.visualViewport?.removeEventListener("scroll", update);
		};
	}, [open, hint, known]);

	useEffect(() => {
		if (!open) return;
		closeButton.current?.focus({ preventScroll: true });
		const dismiss = (event: PointerEvent) => {
			if (!trigger.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) {
				setOpen(false); setHint(false);
			}
		};
		const keyboard = (event: KeyboardEvent) => {
			if (event.key === "Escape") { event.preventDefault(); close(); }
			// The read-only dialog has one focusable control. Keep keyboard focus
			// here until dismissed; outside pointer clicks still close the popover.
			if (event.key === "Tab") { event.preventDefault(); closeButton.current?.focus(); }
		};
		document.addEventListener("pointerdown", dismiss);
		document.addEventListener("keydown", keyboard);
		return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", keyboard); };
	}, [open]);

	const fill = known ? Math.max(0, Math.min(100, percent)) : 0;
	return <>
		<button ref={trigger} type="button" className="inno-context-trigger" aria-label={`${t("contextUsage.title")} · ${summary}`}
			aria-haspopup={known ? "dialog" : undefined} aria-expanded={known ? open : undefined} aria-controls={open ? id : undefined}
			onClick={handleClick} onMouseEnter={() => setHint(true)} onMouseLeave={() => setHint(false)}
			onFocus={() => {
				if (skipNextFocusHint.current) {
					skipNextFocusHint.current = false;
					return;
				}
				setHint(true);
			}} onBlur={() => setHint(false)} onKeyDown={(event) => { if (event.key === "Escape") setHint(false); }}>
			<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
				<circle cx="12" cy="12" r="9" fill="none" stroke="var(--inno-border)" strokeWidth="2.5" />
				<circle cx="12" cy="12" r="9" fill="none" stroke={fill >= 95 ? "#dc6464" : fill >= 80 ? "#d99a35" : "currentColor"}
					strokeWidth="2.5" strokeLinecap="round" pathLength="100" strokeDasharray={`${fill} 100`} transform="rotate(-90 12 12)" opacity={fill ? 1 : 0} />
			</svg>
		</button>
		{(open || hint) && createPortal(open ? <div ref={panel} id={id} role="dialog" aria-labelledby={`${id}-title`} className="inno-context-panel" style={position}>
			<div className="inno-context-header"><h3 id={`${id}-title`}>{t("contextUsage.title")}</h3>
				<button ref={closeButton} type="button" className="inno-context-close" aria-label={t("contextUsage.close")} onClick={close}><X size={18} /></button>
			</div>
			<div className="inno-context-total"><strong>{percentage}</strong><span>{known ? t("contextUsage.used", { amount }) : t(`contextUsage.${status}`)}</span></div>
			<div className="inno-context-bar" role="meter" aria-label={t("contextUsage.title")} aria-valuemin={0} aria-valuemax={100}
				aria-valuenow={known ? fill : undefined} aria-valuetext={summary}>
				{known && data?.breakdown.map((part) => <span key={part.id} className={`inno-context-color-${part.id}`}
					style={{ width: `${part.percent * (percent > 100 ? 100 / percent : 1)}%` }} />)}
			</div>
			{known && <ul className="inno-context-breakdown">{data?.breakdown.map((part) => <li key={part.id}>
				<span className={`inno-context-dot inno-context-color-${part.id}`} /><span>{t(`contextUsage.categories.${part.id}`)}</span>
				<span className="inno-context-part-value" title={`${part.tokens.toLocaleString()} tokens`}>{part.percent.toFixed(1)}%</span>
			</li>)}</ul>}
			<p className="inno-context-note">{known ? t(data?.source === "estimated" ? "contextUsage.estimatedNote" : "contextUsage.note") : t("contextUsage.unknownNote")}</p>
		</div> : <div ref={panel} role="tooltip" className="inno-context-tooltip" style={position}>{summary}</div>, document.body)}
	</>;
}
