/** Position a portaled menu inside the visible viewport, including a keyboard. */
export function positionModelMenu(
	trigger: { top: number; bottom: number; right: number },
	viewport: { width: number; height: number; left: number; top: number },
	content: { width: number; height: number },
) {
	const gap = 8;
	const maxWidth = Math.min(220, Math.max(0, viewport.width - 24));
	const maxHeight = Math.min(360, Math.max(0, viewport.height - 24));
	const width = Math.min(content.width || 220, maxWidth);
	const height = Math.min(content.height, maxHeight);
	const minLeft = viewport.left + gap;
	const minTop = viewport.top + gap;
	const maxLeft = Math.max(minLeft, viewport.left + viewport.width - width - gap);
	const maxTop = Math.max(minTop, viewport.top + viewport.height - height - gap);
	const above = trigger.top - height - gap;
	const below = trigger.bottom + gap;
	const preferredTop = above >= minTop || below > maxTop ? above : below;
	return {
		left: Math.max(minLeft, Math.min(trigger.right - width, maxLeft)),
		top: Math.max(minTop, Math.min(preferredTop, maxTop)),
		maxHeight,
		maxWidth,
	};
}
