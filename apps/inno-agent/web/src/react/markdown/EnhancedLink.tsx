import { ExternalLink, ShieldCheck, X } from "lucide-react";
import { Children, type ComponentProps, type MouseEvent, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ExtraProps } from "streamdown";
import { Button, Popover, PopoverContent, PopoverTrigger, Tooltip } from "../ui/index.js";

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
		<Popover open={confirming} onOpenChange={setConfirming}>
			<span
				className="group/link relative inline"
				onMouseEnter={() => setHovered(true)}
				onMouseLeave={() => setHovered(false)}
				onFocus={() => setHovered(true)}
				onBlur={(event) => {
					if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHovered(false);
				}}
			>
				<Tooltip
					label={<span className="inline-flex items-center gap-1"><ExternalLink size={12} />{isCitation ? `${t("markdown.citation", "引用 {{index}}", { index: childText })} · ` : ""}{url.hostname}</span>}
					description={url.href}
					side="top"
					align="start"
				>
					<PopoverTrigger asChild>
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
					</PopoverTrigger>
				</Tooltip>
			</span>
			<PopoverContent
				align="start"
				side="top"
				sideOffset={6}
				aria-label={t("markdown.externalLinkConfirm", "打开外部链接确认")}
				className="inno-markdown-link-confirm"
			>
				<span className="flex items-start gap-2"><ShieldCheck size={15} className="mt-0.5 shrink-0 text-[var(--inno-accent)]" /><span className="min-w-0"><span className="block font-medium">{t("markdown.externalLinkTitle", "即将打开外部网站")}</span><span className="mt-0.5 block truncate text-[11px] text-[var(--inno-text-muted)]">{url.hostname}</span></span></span>
				<span className="mt-2 flex justify-end gap-1.5">
					<Button variant="ghost" size="xs" onClick={() => setConfirming(false)}><X size={12} />{t("common.cancel", "取消")}</Button>
					<Button variant="primary" size="xs" onClick={openExternal}>{t("markdown.continueOpen", "继续打开")}</Button>
				</span>
			</PopoverContent>
		</Popover>
	);
}
