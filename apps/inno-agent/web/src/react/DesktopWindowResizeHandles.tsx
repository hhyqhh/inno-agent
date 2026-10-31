import { useCallback, useEffect, useRef } from "react";

const EDGES = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;
type ResizeAction = "end" | "cancel";

/** Invisible inner hit targets supplement the OS's thin window border. */
export function DesktopWindowResizeHandles({ disabled = false }: { disabled?: boolean }) {
	const desktop = Boolean(window.innoDesktop);
	const resizeWindow = window.innoDesktop?.resizeWindow;
	const gesture = useRef<{ pointerId: number; element: HTMLElement } | null>(null);
	const frame = useRef(0);
	const finish = useCallback((action: ResizeAction) => {
		const active = gesture.current;
		if (!active) return;
		gesture.current = null;
		if (frame.current) cancelAnimationFrame(frame.current);
		frame.current = 0;
		resizeWindow?.(action);
		if (active.element.hasPointerCapture?.(active.pointerId)) active.element.releasePointerCapture(active.pointerId);
		delete document.body.dataset.windowResizing;
		document.body.style.removeProperty("--inno-window-resize-cursor");
	}, [resizeWindow]);

	useEffect(() => {
		if (!desktop) return;
		let settleFrame = 0;
		let previousWidth = window.innerWidth;
		const resize = () => {
			// Native fitting places the toolbar border immediately, while the
			// right-anchored preview still animates its width and trails behind.
			// Only shrinking needs a fitted preview width. Opening a preview can
			// expand the native window first; suppressing that resize also erased
			// its subsequent opening animation. Manual growth uses the gesture flag.
			const shrinking = window.innerWidth < previousWidth;
			previousWidth = window.innerWidth;
			cancelAnimationFrame(settleFrame);
			if (!shrinking) {
				settleFrame = 0;
				delete document.body.dataset.windowLayoutResizing;
				return;
			}
			document.body.dataset.windowLayoutResizing = "";
			// Cover the last IPC shrink arriving after pointerup, until the
			// fitted React layout has painted.
			settleFrame = requestAnimationFrame(() => {
				settleFrame = requestAnimationFrame(() => {
					settleFrame = 0;
					delete document.body.dataset.windowLayoutResizing;
				});
			});
		};
		window.addEventListener("resize", resize);
		return () => {
			window.removeEventListener("resize", resize);
			cancelAnimationFrame(settleFrame);
			delete document.body.dataset.windowLayoutResizing;
		};
	}, [desktop]);

	useEffect(() => {
		if (!resizeWindow || disabled) return;
		const move = (event: PointerEvent) => {
			if (event.pointerId !== gesture.current?.pointerId) return;
			event.preventDefault();
			// IPC updates are capped at paint rate. The main process reads the
			// screen cursor itself; renderer-local X/Y shift during left/top resize.
			if (!frame.current) frame.current = requestAnimationFrame(() => {
				frame.current = 0;
				if (gesture.current) resizeWindow("update");
			});
		};
		const up = (event: PointerEvent) => {
			if (event.pointerId === gesture.current?.pointerId) finish("end");
		};
		const cancel = (event: PointerEvent) => {
			if (event.pointerId === gesture.current?.pointerId) finish("cancel");
		};
		const blur = () => finish("cancel");
		const key = (event: KeyboardEvent) => { if (event.key === "Escape") finish("cancel"); };
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
		window.addEventListener("pointercancel", cancel);
		window.addEventListener("lostpointercapture", cancel);
		window.addEventListener("blur", blur);
		window.addEventListener("keydown", key);
		return () => {
			finish("cancel");
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			window.removeEventListener("pointercancel", cancel);
			window.removeEventListener("lostpointercapture", cancel);
			window.removeEventListener("blur", blur);
			window.removeEventListener("keydown", key);
		};
	}, [disabled, finish, resizeWindow]);

	if (!resizeWindow || disabled) return null;
	return <div className="inno-window-resize-targets" aria-hidden="true">
		{EDGES.map((edge) => <div key={edge} data-edge={edge} className={`inno-window-resize-target inno-window-resize-target--${edge}`}
			onPointerDown={(event) => {
				if (event.button !== 0 || gesture.current) return;
				event.preventDefault();
				gesture.current = { pointerId: event.pointerId, element: event.currentTarget };
				event.currentTarget.setPointerCapture?.(event.pointerId);
				document.body.style.setProperty("--inno-window-resize-cursor", getComputedStyle(event.currentTarget).cursor);
				document.body.dataset.windowResizing = edge;
				resizeWindow("start", edge);
			}}
		/>)}
	</div>;
}
