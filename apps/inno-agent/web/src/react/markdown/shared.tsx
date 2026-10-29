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
	type ComponentProps,
	forwardRef,
	type ReactElement,
	type ReactNode,
	type SVGProps,
	useContext,
	useEffect,
	useRef,
} from "react";
import { DropdownMenu, DropdownMenuActionItem, DropdownMenuContent, DropdownMenuTrigger, Tooltip } from "../ui/index.js";
import type { ControlsConfig, IconMap } from "streamdown";

type ToolbarButtonProps = Omit<ComponentProps<"button">, "children" | "onClick" | "type" | "aria-label" | "title" | "aria-pressed" | "aria-haspopup" | "aria-expanded">;

export interface ToolbarIconButtonProps extends ToolbarButtonProps {
	label: string;
	title?: string;
	active?: boolean;
	showLabel?: boolean;
	menu?: boolean;
	expanded?: boolean;
	onClick?: ComponentProps<"button">["onClick"];
	children: ReactNode;
}

/** The single icon-button primitive used by every Markdown toolbar. */
export const ToolbarIconButton = forwardRef<HTMLButtonElement, ToolbarIconButtonProps>(function ToolbarIconButton({
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
}, ref) {
	const tooltipLabel = titleOverride ?? (!showLabel ? label : undefined);
	const button = (
		<button
			{...buttonProps}
			ref={ref}
			type="button"
			aria-label={label}
			aria-pressed={active}
			aria-haspopup={menu ? "menu" : undefined}
			aria-expanded={menu ? expanded : undefined}
			title={buttonProps.disabled ? tooltipLabel : undefined}
			onClick={onClick}
			data-inno-toolbar-button=""
			className={`inno-markdown-toolbar-button${active ? " is-active" : ""}${showLabel ? " has-label" : ""}${className ? ` ${className}` : ""}`}
		>
			{children}
			{showLabel ? <span className="inno-markdown-toolbar-button-label">{label}</span> : null}
		</button>
	);
	return tooltipLabel && !buttonProps.disabled ? <Tooltip label={tooltipLabel}>{button}</Tooltip> : button;
});

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

export function ToolbarMenu({
	trigger,
	open,
	onOpenChange,
	label,
	id,
	children,
	className = "",
}: {
	trigger: ReactElement;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	label: string;
	id?: string;
	children: ReactNode;
	className?: string;
}) {
	return (
		<DropdownMenu open={open} onOpenChange={onOpenChange}>
			<DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
			<DropdownMenuContent id={id} aria-label={label} align="end" side="bottom" className={`inno-markdown-toolbar-menu${className ? ` ${className}` : ""}`}>
				{children}
			</DropdownMenuContent>
		</DropdownMenu>
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
	return (
		<DropdownMenuActionItem
			disabled={disabled}
			onSelect={() => void onClick()}
			data-inno-toolbar-menu-item=""
			className="inno-markdown-toolbar-menu-item"
			icon={children}
			label={label}
		/>
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
	const hasMacWindowControls = Boolean(
		window.innoDesktop && /Mac/i.test(window.navigator.platform),
	);
	return createPortal(
		<div
			role="dialog"
			aria-modal="true"
			aria-label={ariaLabel ?? title}
			className={`inno-markdown-fullscreen${hasMacWindowControls ? " is-macos-window" : ""}`}
		>
			{/* A horizontal inset still puts tools in the native traffic-light row.
			    Reserve the existing window-chrome height for every fullscreen viewer. */}
			{hasMacWindowControls ? <div className="inno-markdown-fullscreen-titlebar" aria-hidden="true" /> : null}
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
