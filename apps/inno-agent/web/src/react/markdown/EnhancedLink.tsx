import { ExternalLink, ShieldCheck, X } from "lucide-react";
import { Children, type ComponentProps, type MouseEvent, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ExtraProps } from "streamdown";

type EnhancedLinkProps = ComponentProps<"a"> & ExtraProps;

function parseWebUrl(href: string | undefined): URL | null {
	if (!href) return null;
	try {
		const url = new URL(href);
		return url.protocol === "http:" || url.protocol === "https:" ? url : null;
	} catch {
		return null;
	}
}

function scrollToHeading(anchor: HTMLAnchorElement, href: string) {
	try {
		const raw = decodeURIComponent(href.slice(1));
		if (!raw) return;
		const escaped = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(raw) : raw.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
		if (!escaped) return;
		// Heading ids are prefixed per MarkdownRuntime instance, so resolve
		// within the anchor's own message — otherwise duplicate heading text in
		// an older message would win the suffix match and scroll away.
		const scope: ParentNode = anchor.closest(".inno-markdown") ?? document;
		const exact = scope.querySelector<HTMLElement>(`#${escaped}`);
		const needle = `-${raw.toLowerCase()}`;
		const suffix = Array.from(scope.querySelectorAll<HTMLElement>("h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]"))
			.find((heading) => heading.id.toLowerCase().endsWith(needle));
		(exact ?? suffix)?.scrollIntoView({ behavior: "smooth", block: "start" });
	} catch {
		// Malformed anchors ("#", bad percent-encoding) are a no-op, not a crash.
	}
}

export function EnhancedLink({ href, children, className, node: _node, onClick, ...props }: EnhancedLinkProps) {
	const { t } = useTranslation();
	const [hovered, setHovered] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const url = useMemo(() => parseWebUrl(href), [href]);
	const childText = Children.toArray(children).join("").trim();
	const isCitation = /^\d+$/.test(childText);

	if (href?.startsWith("#")) {
		return <a {...props} href={href} className={className} onClick={(event) => {
			onClick?.(event);
			if (event.defaultPrevented) return;
			event.preventDefault();
			scrollToHeading(event.currentTarget, href);
		}}>{children}</a>;
	}

	if (!url) return <a {...props} href={href} className={className} onClick={onClick}>{children}</a>;

	const openExternal = () => {
		setConfirming(false);
		window.open(url.href, "_blank", "noopener,noreferrer");
	};
	const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
		onClick?.(event);
		if (event.defaultPrevented) return;
		event.preventDefault();
		event.stopPropagation();
		setConfirming(true);
	};

	return (
		<span
			className="group/link relative inline"
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
			onFocus={() => setHovered(true)}
			onBlur={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
					setHovered(false);
					setConfirming(false);
				}
			}}
		>
			<a
				{...props}
				href={url.href}
				target="_blank"
				rel="noopener noreferrer"
				aria-label={isCitation ? t("markdown.citationAt", "引用 {{index}}：{{host}}", { index: childText, host: url.hostname }) : props["aria-label"]}
				className={isCitation ? `mx-0.5 inline-flex min-w-5 items-center justify-center rounded-full bg-[var(--inno-accent-soft)] px-1.5 text-[10px] font-semibold leading-5 text-[var(--inno-accent)] no-underline ${className ?? ""}` : className}
				onClick={handleClick}
			>
				{hovered && !isCitation ? <img src={`${url.origin}/favicon.ico`} alt="" aria-hidden="true" className="mr-1 inline size-3.5 rounded-sm align-[-0.1em]" onError={(event) => { event.currentTarget.style.display = "none"; }} /> : null}
				{isCitation ? childText : children}
			</a>
			{hovered && !confirming ? (
				<span role="tooltip" className="pointer-events-none absolute bottom-full left-0 z-50 mb-1.5 w-max max-w-72 rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2.5 py-2 text-left text-[11px] leading-4 text-[var(--inno-text-muted)] shadow-lg">
					<span className="flex items-center gap-1 font-medium text-[var(--inno-text)]"><ExternalLink size={12} />{isCitation ? `${t("markdown.citation", "引用 {{index}}", { index: childText })} · ` : ""}{url.hostname}</span>
					<span className="mt-0.5 block max-w-64 truncate">{url.href}</span>
				</span>
			) : null}
			{confirming ? (
				<span role="dialog" aria-label={t("markdown.externalLinkConfirm", "打开外部链接确认")} className="absolute bottom-full left-0 z-50 mb-1.5 w-72 rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] p-2.5 text-left text-xs text-[var(--inno-text)] shadow-xl">
					<span className="flex items-start gap-2"><ShieldCheck size={15} className="mt-0.5 shrink-0 text-[var(--inno-accent)]" /><span className="min-w-0"><span className="block font-medium">{t("markdown.externalLinkTitle", "即将打开外部网站")}</span><span className="mt-0.5 block truncate text-[11px] text-[var(--inno-text-muted)]">{url.hostname}</span></span></span>
					<span className="mt-2 flex justify-end gap-1.5">
						<button type="button" className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)]" onClick={() => setConfirming(false)}><X size={12} />{t("common.cancel", "取消")}</button>
						<button type="button" className="rounded-md bg-[var(--inno-accent)] px-2 py-1 text-white" onClick={openExternal}>{t("markdown.continueOpen", "继续打开")}</button>
					</span>
				</span>
			) : null}
		</span>
	);
}
