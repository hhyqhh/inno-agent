import { useEffect, useRef, useState } from "react";
import { Separator } from "./Separator.js";

export interface ResizePoint { clientX: number; clientY: number }

interface ResizeHandleProps {
	value: number;
	min: number;
	max: number;
	onValueChange: (value: number) => void;
	onResizeStart?: () => void;
	onResizeEnd?: (point: ResizePoint | null) => void;
	"aria-label": string;
	"aria-controls"?: string;
}

/** Right-edge column splitter with pointer capture, keyboard sizing and cancel. */
export function ResizeHandle(props: ResizeHandleProps) {
	const current = useRef(props);
	current.current = props;
	const start = useRef<{ pointerId: number; clientX: number; value: number; element: HTMLElement } | null>(null);
	const [resizing, setResizing] = useState(false);
	const clamp = (value: number) => Math.max(current.current.min, Math.min(current.current.max, Math.round(value)));

	useEffect(() => {
		if (!resizing) return;
		let frame = 0;
		let latestClientX = 0;
		const applyMove = (clientX: number) => {
			frame = 0;
			if (!start.current) return;
			current.current.onValueChange(clamp(start.current.value + clientX - start.current.clientX));
		};
		const move = (event: PointerEvent) => {
			if (!start.current || event.pointerId !== start.current.pointerId) return;
			event.preventDefault();
			// Pointer events arrive at the input device's rate, faster than frames;
			// one layout update per frame keeps the drag from stacking whole-app
			// renders on every event.
			latestClientX = event.clientX;
			if (frame === 0) frame = requestAnimationFrame(() => applyMove(latestClientX));
		};
		const finish = (cancel: boolean, point: ResizePoint | null) => {
			if (frame !== 0) {
				cancelAnimationFrame(frame);
				frame = 0;
			}
			const initial = start.current;
			if (!initial) return;
			start.current = null;
			if (initial.element.hasPointerCapture?.(initial.pointerId)) initial.element.releasePointerCapture(initial.pointerId);
			if (cancel) current.current.onValueChange(initial.value);
			setResizing(false);
			current.current.onResizeEnd?.(point);
		};
		const up = (event: PointerEvent) => {
			if (event.pointerId === start.current?.pointerId) {
				if (frame !== 0) {
					cancelAnimationFrame(frame);
					frame = 0;
				}
				applyMove(event.clientX);
				finish(false, event);
			}
		};
		const cancel = (event: PointerEvent) => {
			if (event.pointerId === start.current?.pointerId) finish(true, event);
		};
		const blur = () => finish(true, null);
		const key = (event: KeyboardEvent) => {
			if (event.key === "Escape") { event.preventDefault(); finish(true, null); }
		};
		document.body.classList.add("inno-ui-resizing-columns");
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
		window.addEventListener("pointercancel", cancel);
		window.addEventListener("lostpointercapture", cancel);
		window.addEventListener("blur", blur);
		window.addEventListener("keydown", key);
		return () => {
			if (frame !== 0) cancelAnimationFrame(frame);
			document.body.classList.remove("inno-ui-resizing-columns");
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			window.removeEventListener("pointercancel", cancel);
			window.removeEventListener("lostpointercapture", cancel);
			window.removeEventListener("blur", blur);
			window.removeEventListener("keydown", key);
			if (start.current) {
				current.current.onValueChange(start.current.value);
				start.current = null;
				current.current.onResizeEnd?.(null);
			}
		};
	}, [resizing]);

	return (
		<Separator
			decorative={false}
			orientation="vertical"
			tabIndex={0}
			className="inno-ui-resize-handle"
			aria-label={props["aria-label"]}
			aria-controls={props["aria-controls"]}
			aria-valuemin={props.min}
			aria-valuemax={props.max}
			aria-valuenow={props.value}
			data-resizing={resizing || undefined}
			onPointerDown={(event) => {
				if (event.button !== 0 || start.current) return;
				event.preventDefault();
				event.currentTarget.focus();
				start.current = { pointerId: event.pointerId, clientX: event.clientX, value: props.value, element: event.currentTarget };
				event.currentTarget.setPointerCapture?.(event.pointerId);
				props.onResizeStart?.();
				setResizing(true);
			}}
			onKeyDown={(event) => {
				const step = event.shiftKey ? 32 : 8;
				const next = event.key === "ArrowLeft" ? props.value - step
					: event.key === "ArrowRight" ? props.value + step
						: event.key === "Home" ? props.min : event.key === "End" ? props.max : null;
				if (next === null) return;
				event.preventDefault();
				props.onValueChange(clamp(next));
			}}
		/>
	);
}
