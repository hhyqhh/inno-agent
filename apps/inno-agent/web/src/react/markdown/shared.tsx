import {
	Check,
	Copy,
	Download,
	ExternalLink,
	Loader2,
	Maximize2,
	RotateCcw,
	X,
	ZoomIn,
	ZoomOut,
	type LucideIcon,
} from "lucide-react";
import { createPortal } from "react-dom";
import {
	createContext,
	type ComponentProps,
	type ReactNode,
	type SVGProps,
	useContext,
	useEffect,
	useId,
	useRef,
} from "react";
import type { ControlsConfig, IconMap } from "streamdown";

type ToolbarButtonProps = Omit<ComponentProps<"button">, "children" | "onClick" | "type" | "aria-label" | "title" | "aria-pressed" | "aria-haspopup" | "aria-expanded">;

export interface ToolbarIconButtonProps extends ToolbarButtonProps {
	label: string;
	title?: string;
	active?: boolean;
	showLabel?: boolean;
	menu?: boolean;
	expanded?: boolean;
	onClick: () => void | Promise<void>;
	children: ReactNode;
}

/** The single icon-button primitive used by every Markdown toolbar. */
export function ToolbarIconButton({
	label,
	title: titleOverride,
	active,
	showLabel = false,
	menu = false,
	expanded = false,
	onClick,
	children,
	className = "",
	...buttonProps
}: ToolbarIconButtonProps) {
	return (
		<button
			{...buttonProps}
			type="button"
			aria-label={label}
			aria-pressed={active ?? false}
			aria-haspopup={menu ? "menu" : undefined}
			aria-expanded={menu ? expanded : undefined}
			title={titleOverride ?? label}
			onClick={() => void onClick()}
			data-inno-toolbar-button=""
			className={`inno-markdown-toolbar-button${active ? " is-active" : ""}${showLabel ? " has-label" : ""}${className ? ` ${className}` : ""}`}
		>
			{children}
			{showLabel ? <span className="inno-markdown-toolbar-button-label">{label}</span> : null}
		</button>
	);
}

export interface ToolbarSegmentedButtonProps extends ToolbarButtonProps {
	label: string;
	selected: boolean;
	showLabel?: boolean;
	onClick: () => void | Promise<void>;
	children: ReactNode;
}

/** Icon-only mode button for preview/source/split and chart/code switches. */
export function ToolbarSegmentedButton({
	label,
	selected,
	showLabel = false,
	onClick,
	children,
	className = "",
	...buttonProps
}: ToolbarSegmentedButtonProps) {
	return (
		<button
			{...buttonProps}
			type="button"
			role="tab"
			aria-label={label}
			aria-pressed={selected}
			aria-selected={selected}
			title={label}
			onClick={() => void onClick()}
			data-inno-toolbar-segment=""
			className={`inno-markdown-toolbar-segment${selected ? " is-active" : ""}${showLabel ? " has-label" : ""}${className ? ` ${className}` : ""}`}
		>
			{children}
			{showLabel ? <span className="inno-markdown-toolbar-button-label">{label}</span> : null}
		</button>
	);
}

export function MarkdownToolbar({ children, label, className = "" }: { children: ReactNode; label?: string; className?: string }) {
	return (
		<div className={`inno-markdown-toolbar${className ? ` ${className}` : ""}`} role="toolbar" aria-label={label} data-inno-markdown-toolbar="">
			{children}
		</div>
	);
}

export function MarkdownToolbarGroup({ children, className = "" }: { children: ReactNode; className?: string }) {
	return <div className={`inno-markdown-toolbar-group${className ? ` ${className}` : ""}`}>{children}</div>;
}

export function MarkdownToolbarDivider() {
	return <span className="inno-markdown-toolbar-divider" aria-hidden="true" />;
}

const ToolbarMenuCloseContext = createContext<(() => void) | null>(null);

export function ToolbarMenu({
	open,
	onClose,
	label,
	id,
	children,
	className = "",
}: {
	open: boolean;
	onClose: () => void;
	label: string;
	id?: string;
	children: ReactNode;
	className?: string;
}) {
	const generatedId = useId();
	const menuRef = useRef<HTMLDivElement>(null);
	const returnFocusRef = useRef<HTMLElement | null>(null);
	const wasOpenRef = useRef(false);
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	useEffect(() => {
		if (!open) {
			if (wasOpenRef.current) {
				wasOpenRef.current = false;
				returnFocusRef.current?.focus();
			}
			return;
		}
		if (!wasOpenRef.current) {
			returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
			wasOpenRef.current = true;
		}
		const menu = menuRef.current;
		const firstItem = menu?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)');
		const focusFrame = typeof window !== "undefined" ? window.setTimeout(() => firstItem?.focus(), 0) : undefined;
		const closeOnOutsidePointer = (event: PointerEvent) => {
			const target = event.target as Node | null;
			if (menu?.contains(target) || menu?.parentElement?.contains(target)) return;
			onCloseRef.current();
		};
		const closeOnKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				onCloseRef.current();
				return;
			}
			if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
			const items = Array.from(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
			if (!items.length) return;
			event.preventDefault();
			const current = items.indexOf(document.activeElement as HTMLButtonElement);
			const next = event.key === "ArrowDown"
				? items[(current + 1 + items.length) % items.length]
				: items[(current - 1 + items.length) % items.length];
			next?.focus();
		};
		document.addEventListener("pointerdown", closeOnOutsidePointer);
		document.addEventListener("keydown", closeOnKeyDown);
		return () => {
			if (focusFrame !== undefined) window.clearTimeout(focusFrame);
			document.removeEventListener("pointerdown", closeOnOutsidePointer);
			document.removeEventListener("keydown", closeOnKeyDown);
		};
	}, [open]);

	if (!open) return null;
	return (
		<div
			ref={menuRef}
			id={id ?? generatedId}
			role="menu"
			aria-label={label}
			data-inno-toolbar-menu=""
			className={`inno-markdown-toolbar-menu${className ? ` ${className}` : ""}`}
		>
			<ToolbarMenuCloseContext.Provider value={onClose}>{children}</ToolbarMenuCloseContext.Provider>
		</div>
	);
}

export function ToolbarMenuItem({
	label,
	disabled = false,
	onClick,
	children,
}: {
	label: string;
	disabled?: boolean;
	onClick: () => void | Promise<void>;
	children: ReactNode;
}) {
	const close = useContext(ToolbarMenuCloseContext);
	return (
		<button
			type="button"
			role="menuitem"
			aria-label={label}
			disabled={disabled}
			onClick={() => {
				void onClick();
				close?.();
			}}
			data-inno-toolbar-menu-item=""
			className="inno-markdown-toolbar-menu-item"
		>
			<span aria-hidden="true">{children}</span>
			<span>{label}</span>
		</button>
	);
}

export type MarkdownControlKind = "code" | "table" | "mermaid" | "image";
export type MarkdownControlAction = "copy" | "download" | "fullscreen" | "panZoom";

/** Shared control gates for custom renderers, which do not receive `compact`. */
export function markdownControlEnabled(controls: ControlsConfig, kind: MarkdownControlKind, action?: MarkdownControlAction): boolean {
	if (controls === false) return false;
	if (controls === true || action === undefined) return true;
	const config = controls[kind];
	if (config === false || config === undefined || config === true) return config !== false;
	return (config as Record<string, unknown>)[action] !== false;
}

export function markdownToolbarEnabled(controls: ControlsConfig, kind?: MarkdownControlKind): boolean {
	return kind ? markdownControlEnabled(controls, kind) : controls !== false;
}

/** Convert Streamdown's height setting into a CSS max-height value. */
export function markdownMaxHeight(value: number | string): string | undefined {
	if (value === 0 || value === Infinity || value === "0" || value === "none" || value === "Infinity") return undefined;
	return typeof value === "number" ? `${value}px` : value;
}

type StreamdownIconProps = SVGProps<SVGSVGElement> & { size?: number };

function streamdownIcon(Icon: LucideIcon) {
	return function StreamdownIcon({ size = 14, ...props }: StreamdownIconProps) {
		return <Icon {...props} size={size} strokeWidth={1.8} />;
	};
}

/** Keep Streamdown's built-in image/fallback controls visually consistent. */
export const STREAMDOWN_ICON_OVERRIDES: Partial<IconMap> = {
	CheckIcon: streamdownIcon(Check),
	CopyIcon: streamdownIcon(Copy),
	DownloadIcon: streamdownIcon(Download),
	ExternalLinkIcon: streamdownIcon(ExternalLink),
	Loader2Icon: streamdownIcon(Loader2),
	Maximize2Icon: streamdownIcon(Maximize2),
	RotateCcwIcon: streamdownIcon(RotateCcw),
	XIcon: streamdownIcon(X),
	ZoomInIcon: streamdownIcon(ZoomIn),
	ZoomOutIcon: streamdownIcon(ZoomOut),
};

/** Single blob-download primitive for every Markdown toolbar. */
export function downloadBlob(filename: string, blob: Blob): void {
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
	setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Escape-to-close + body scroll lock shared by the fullscreen overlays. */
export function useFullscreenDialog(open: boolean, onClose: () => void): void {
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	useEffect(() => {
		if (!open) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") onCloseRef.current();
		};
		document.addEventListener("keydown", onKeyDown);
		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => {
			document.removeEventListener("keydown", onKeyDown);
			document.body.style.overflow = previousOverflow;
		};
	}, [open]);
}

export function MarkdownFullscreenDialog({
	open,
	title,
	ariaLabel,
	closeLabel,
	onClose,
	actions,
	children,
}: {
	open: boolean;
	title: string;
	ariaLabel?: string;
	closeLabel: string;
	onClose: () => void;
	actions?: ReactNode;
	children: ReactNode;
}) {
	useFullscreenDialog(open, onClose);
	if (!open || typeof document === "undefined") return null;
	return createPortal(
		<div role="dialog" aria-modal="true" aria-label={ariaLabel ?? title} className="inno-markdown-fullscreen">
			<div className="inno-markdown-fullscreen-header">
				<span className="inno-markdown-fullscreen-title">{title}</span>
				<div className="inno-markdown-fullscreen-actions">
						{actions}
						<ToolbarIconButton label={closeLabel} showLabel onClick={onClose}>
						<X size={14} />
					</ToolbarIconButton>
				</div>
			</div>
			<div className="inno-markdown-fullscreen-body inno-markdown">{children}</div>
		</div>,
		document.body,
	);
}
