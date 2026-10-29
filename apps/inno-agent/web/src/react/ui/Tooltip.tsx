import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cloneElement, useEffect, useRef, useState, type ComponentPropsWithoutRef, type ReactElement, type ReactNode } from "react";

export const TooltipProvider = TooltipPrimitive.Provider;

const silentFocusTargets = new WeakSet<HTMLElement>();

/** Return focus after a close without treating restoration as a tooltip request. */
export function focusWithoutTooltip(target: HTMLElement | null): void {
	if (!target) return;
	silentFocusTargets.add(target);
	try { target.focus({ preventScroll: true }); }
	finally { silentFocusTargets.delete(target); }
}

let tooltipWindowFocused = true;
let suppressTooltipUntilInteraction = false;
let ignoreNextPointerMoveAfterFocus = false;

if (typeof window !== "undefined" && typeof document !== "undefined") {
	window.addEventListener("blur", () => {
		tooltipWindowFocused = false;
		suppressTooltipUntilInteraction = true;
	});
	window.addEventListener("focus", () => {
		tooltipWindowFocused = true;
		suppressTooltipUntilInteraction = true;
		ignoreNextPointerMoveAfterFocus = true;
	});
	document.addEventListener("pointermove", (event) => {
		if (!tooltipWindowFocused || !suppressTooltipUntilInteraction) return;
		if (ignoreNextPointerMoveAfterFocus) {
			ignoreNextPointerMoveAfterFocus = false;
			return;
		}
		if (event.movementX === 0 && event.movementY === 0) return;
		suppressTooltipUntilInteraction = false;
	}, true);
	window.addEventListener("pointerdown", () => {
		if (!tooltipWindowFocused) return;
		suppressTooltipUntilInteraction = false;
		ignoreNextPointerMoveAfterFocus = false;
	}, true);
	window.addEventListener("keydown", () => {
		if (!tooltipWindowFocused) return;
		suppressTooltipUntilInteraction = false;
		ignoreNextPointerMoveAfterFocus = false;
	}, true);
}

type TooltipSide = ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>["side"];
type TooltipAlign = ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>["align"];

export interface TooltipProps {
	/** Short action name shown as the main line. */
	label: ReactNode;
	description?: ReactNode;
	shortcut?: ReactNode;
	children: ReactElement;
	side?: TooltipSide;
	align?: TooltipAlign;
	sideOffset?: number;
	contentClassName?: string;
	/** Keep feedback visible for an active gesture, independently of hover. */
	open?: boolean;
}

/** Shared, accessible tooltip for buttons and other single-element triggers. */
export function Tooltip({
	label,
	description,
	shortcut,
	children,
	side = "top",
	align = "center",
	sideOffset = 6,
	contentClassName = "",
	open: controlledOpen,
}: TooltipProps) {
	const [open, setOpen] = useState(false);
	const [watchPointerMovement, setWatchPointerMovement] = useState(false);
	const suppressTooltipRef = useRef(false);
	const suppressUntilPointerMoveRef = useRef(false);
	const pointerPositionRef = useRef<{ x: number; y: number } | null>(null);
	const triggerBoundsRef = useRef<{ left: number; right: number; top: number; bottom: number } | null>(null);
	const childProps = children.props as {
		onFocus?: (event: React.FocusEvent<HTMLElement>) => void;
		onBlur?: (event: React.FocusEvent<HTMLElement>) => void;
		onClick?: (event: React.MouseEvent<HTMLElement>) => void;
		onKeyDown?: (event: React.KeyboardEvent<HTMLElement>) => void;
		onPointerDown?: (event: React.PointerEvent<HTMLElement>) => void;
		onPointerLeave?: (event: React.PointerEvent<HTMLElement>) => void;
		onPointerMove?: (event: React.PointerEvent<HTMLElement>) => void;
	};
	const dismissTooltip = (pointerInteraction = false, x?: number, y?: number, target?: HTMLElement) => {
		suppressTooltipRef.current = true;
		if (pointerInteraction) {
			suppressUntilPointerMoveRef.current = true;
			if (x !== undefined && y !== undefined) pointerPositionRef.current = { x, y };
			if (target) {
				const { left, right, top, bottom } = target.getBoundingClientRect();
				triggerBoundsRef.current = { left, right, top, bottom };
			}
			setWatchPointerMovement(true);
		}
		setOpen(false);
	};
	const trigger = cloneElement(children, {
		onFocus: (event: React.FocusEvent<HTMLElement>) => {
			childProps.onFocus?.(event);
			// Radix opens on focus. Tab-close restoration is programmatic, so
			// prevent only this focus event, without disabling later hover/Tab hints.
			if (silentFocusTargets.has(event.currentTarget)) { event.preventDefault(); setOpen(false); }
		},
		onBlur: (event: React.FocusEvent<HTMLElement>) => {
			childProps.onBlur?.(event);
			if (!suppressUntilPointerMoveRef.current) suppressTooltipRef.current = false;
		},
		onClick: (event: React.MouseEvent<HTMLElement>) => {
			dismissTooltip(event.detail > 0, event.clientX, event.clientY, event.currentTarget);
			childProps.onClick?.(event);
		},
		onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
			if (event.key === "Enter" || event.key === " " || event.key === "Escape") dismissTooltip();
			childProps.onKeyDown?.(event);
		},
		onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
			dismissTooltip(true, event.clientX, event.clientY, event.currentTarget);
			childProps.onPointerDown?.(event);
		},
		onPointerLeave: (event: React.PointerEvent<HTMLElement>) => {
			childProps.onPointerLeave?.(event);
			setOpen(false);
		},
		onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
			pointerPositionRef.current = { x: event.clientX, y: event.clientY };
			const { left, right, top, bottom } = event.currentTarget.getBoundingClientRect();
			triggerBoundsRef.current = { left, right, top, bottom };
			childProps.onPointerMove?.(event);
		},
	} as never);

	useEffect(() => {
		if (!watchPointerMovement) return;
		const dismissAfterPointerMoves = (event: PointerEvent) => {
			const bounds = triggerBoundsRef.current;
			if (bounds && event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom) {
				pointerPositionRef.current = { x: event.clientX, y: event.clientY };
				return;
			}
			const lastPosition = pointerPositionRef.current;
			if (lastPosition && lastPosition.x === event.clientX && lastPosition.y === event.clientY) return;
			pointerPositionRef.current = { x: event.clientX, y: event.clientY };
			suppressUntilPointerMoveRef.current = false;
			suppressTooltipRef.current = false;
			setWatchPointerMovement(false);
			setOpen(false);
		};
		document.addEventListener("pointermove", dismissAfterPointerMoves, true);
		return () => document.removeEventListener("pointermove", dismissAfterPointerMoves, true);
	}, [watchPointerMovement]);

	useEffect(() => {
		if (!open) return;
		const dismissOnWindowBlur = () => dismissTooltip(true);
		window.addEventListener("blur", dismissOnWindowBlur);
		return () => window.removeEventListener("blur", dismissOnWindowBlur);
	}, [open]);

	return (
		<TooltipPrimitive.Root
			open={controlledOpen ?? open}
			onOpenChange={(nextOpen) => {
				if (nextOpen && (suppressTooltipRef.current || !tooltipWindowFocused || suppressTooltipUntilInteraction)) return;
				setOpen(nextOpen);
			}}
		>
			<TooltipPrimitive.Trigger asChild>{trigger}</TooltipPrimitive.Trigger>
			<TooltipPrimitive.Portal>
				<TooltipPrimitive.Content
					className={`inno-tooltip-content${contentClassName ? ` ${contentClassName}` : ""}`}
					side={side}
					align={align}
					sideOffset={sideOffset}
					collisionPadding={8}
				>
					<div className="inno-tooltip-content__copy">
						<div className="inno-tooltip-content__label">{label}</div>
						{description ? <div className="inno-tooltip-content__description">{description}</div> : null}
					</div>
					{shortcut ? <kbd className="inno-tooltip-content__shortcut">{shortcut}</kbd> : null}
				</TooltipPrimitive.Content>
			</TooltipPrimitive.Portal>
		</TooltipPrimitive.Root>
	);
}
