import { useCallback, useEffect, useRef, useState } from "react";

export const SIDEBAR_PREVIEW_CLOSE_DELAY = 220;

/** Delayed close shared by the collapsed Chat rail preview and its panel. */
export function useSidebarPreview(
	enabled: boolean,
	keepOpenForFocus: () => boolean,
	closeDelay = SIDEBAR_PREVIEW_CLOSE_DELAY,
) {
	const [previewOpen, setPreviewOpen] = useState(false);
	const closeTimerRef = useRef<number | null>(null);
	const focusGuardRef = useRef(keepOpenForFocus);
	focusGuardRef.current = keepOpenForFocus;

	const cancelClose = useCallback(() => {
		if (closeTimerRef.current === null) return;
		window.clearTimeout(closeTimerRef.current);
		closeTimerRef.current = null;
	}, []);

	const closePreview = useCallback(() => {
		cancelClose();
		setPreviewOpen(false);
	}, [cancelClose]);

	const openPreview = useCallback(() => {
		if (!enabled) return;
		cancelClose();
		setPreviewOpen(true);
	}, [cancelClose, enabled]);

	const scheduleClose = useCallback((force = false) => {
		cancelClose();
		closeTimerRef.current = window.setTimeout(() => {
			closeTimerRef.current = null;
			if (force || !focusGuardRef.current()) setPreviewOpen(false);
		}, closeDelay);
	}, [cancelClose, closeDelay]);
	const scheduleFocusClose = useCallback(() => scheduleClose(), [scheduleClose]);
	const schedulePointerClose = useCallback(() => scheduleClose(true), [scheduleClose]);

	const handleKeyDown = useCallback((event: Pick<KeyboardEvent, "key" | "defaultPrevented" | "preventDefault">) => {
		if (event.key !== "Escape" || event.defaultPrevented || !previewOpen) return;
		event.preventDefault();
		closePreview();
	}, [closePreview, previewOpen]);

	useEffect(() => {
		if (!enabled) closePreview();
	}, [closePreview, enabled]);

	useEffect(() => () => cancelClose(), [cancelClose]);

	return { previewOpen, openPreview, closePreview, cancelClose, scheduleClose: scheduleFocusClose, schedulePointerClose, handleKeyDown };
}
