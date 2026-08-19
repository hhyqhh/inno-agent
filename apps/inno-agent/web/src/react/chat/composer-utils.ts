import type { InlineImage } from "../../api/chat.js";

export const PASTE_COLLAPSE_LINES = 20;
export const PASTE_COLLAPSE_CHARS = 2000;
const COMPOSER_MIN_LINES = 2;
const COMPOSER_MAX_LINES = 8;

export interface PendingPasteBlock {
	id: number;
	text: string;
}

export interface PendingUpload {
	fileName: string;
	path: string;
	file: File;
}

export type PreparedInlineImage = InlineImage & { name: string; previewUrl: string };

function parseCssPixels(value: string): number {
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

/** Resize using the browser's actual wrapped-text height and keep the caret stable. */
export function resizeComposerTextarea(el: HTMLTextAreaElement): number {
	const styles = window.getComputedStyle(el);
	const fontSize = parseCssPixels(styles.fontSize) || 14;
	const lineHeight = parseCssPixels(styles.lineHeight) || fontSize * 1.25;
	const verticalPadding = parseCssPixels(styles.paddingTop) + parseCssPixels(styles.paddingBottom);
	const verticalBorder = parseCssPixels(styles.borderTopWidth) + parseCssPixels(styles.borderBottomWidth);
	const minHeight = Math.ceil(lineHeight * COMPOSER_MIN_LINES + verticalPadding + verticalBorder);
	const maxHeight = Math.ceil(lineHeight * COMPOSER_MAX_LINES + verticalPadding + verticalBorder);
	const selectionStart = el.selectionStart;
	const selectionEnd = el.selectionEnd;

	// Reset before measuring so shrinking after delete/cut/undo is symmetrical
	// with growth. scrollHeight is the browser's actual wrapped-text height.
	el.style.height = "auto";
	const contentHeight = el.scrollHeight + verticalBorder;
	const nextHeight = Math.max(minHeight, Math.min(contentHeight, maxHeight));
	el.style.height = `${nextHeight}px`;
	el.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
	el.style.overflowX = "hidden";

	// Re-applying the existing selection lets the browser keep the caret in
	// view after the textarea changes between intrinsic and scrollable height.
	if (document.activeElement === el && selectionStart >= 0 && selectionEnd >= 0) {
		const restoreSelection = () => {
			if (document.activeElement === el) el.setSelectionRange(selectionStart, selectionEnd);
		};
		if (typeof requestAnimationFrame === "function") requestAnimationFrame(restoreSelection);
		else restoreSelection();
	}

	return minHeight;
}

export function isLargeTextPaste(text: string): boolean {
	const lineCount = text.split(/\r\n|\r|\n/).length;
	return lineCount > PASTE_COLLAPSE_LINES || text.length > PASTE_COLLAPSE_CHARS;
}

// Inline chat images are sent to the provider as base64 inside the JSON body.
// Full-resolution photos can exceed reverse-proxy body limits, so large images
// are downscaled before they leave the browser.
const INLINE_IMAGE_MAX_DIMENSION = 1280;
const INLINE_IMAGE_TARGET_BYTES = 380 * 1024;
const INLINE_IMAGE_MAX_BYTES = 500 * 1024;

function rawInlineImage(file: File, dataUrl: string): PreparedInlineImage {
	const commaIdx = dataUrl.indexOf(",");
	const header = dataUrl.slice(0, commaIdx);
	return {
		data: dataUrl.slice(commaIdx + 1),
		mimeType: header.match(/:(.*?);/)?.[1] ?? file.type,
		name: file.name || "image",
		previewUrl: dataUrl,
	};
}

/** Binary size estimate of a base64 data URL payload. */
function dataUrlBytes(dataUrl: string): number {
	return Math.floor((dataUrl.length - dataUrl.indexOf(",") - 1) * 3 / 4);
}

/** Re-encode a decoded image until the payload fits the request budget. */
function downscaleToFit(img: HTMLImageElement): string | undefined {
	const canvas = document.createElement("canvas");
	const ctx = canvas.getContext("2d");
	if (!ctx) return undefined;
	let scale = Math.min(1, INLINE_IMAGE_MAX_DIMENSION / Math.max(img.naturalWidth, img.naturalHeight));
	let quality = 0.8;
	let best: string | undefined;
	for (let attempt = 0; attempt < 5; attempt++) {
		canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
		canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
		ctx.fillStyle = "#ffffff";
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
		const outUrl = canvas.toDataURL("image/jpeg", quality);
		if (!best || outUrl.length < best.length) best = outUrl;
		if (dataUrlBytes(outUrl) <= INLINE_IMAGE_TARGET_BYTES) break;
		if (quality > 0.5) {
			quality -= 0.15;
		} else {
			scale *= 0.75;
			quality = 0.7;
		}
	}
	return best;
}

export async function prepareInlineImage(file: File): Promise<PreparedInlineImage> {
	const dataUrl = await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});
	const passthrough = () => rawInlineImage(file, dataUrl);
	if (file.size <= INLINE_IMAGE_MAX_BYTES) return passthrough();
	try {
		const img = await new Promise<HTMLImageElement>((resolve, reject) => {
			const el = document.createElement("img");
			el.onload = () => resolve(el);
			el.onerror = () => reject(new Error("image decode failed"));
			el.src = dataUrl;
		});
		const outUrl = downscaleToFit(img);
		if (!outUrl || outUrl.length >= dataUrl.length) return passthrough();
		return {
			data: outUrl.slice(outUrl.indexOf(",") + 1),
			mimeType: "image/jpeg",
			name: file.name || "image",
			previewUrl: outUrl,
		};
	} catch {
		return passthrough();
	}
}
