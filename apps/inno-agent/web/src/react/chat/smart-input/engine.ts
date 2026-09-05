import type { SmartInputRule } from "../../../types/settings.js";
import type { AttachmentBinding, AttachmentRef } from "../../../types/chat.js";
import type { SlashCommandItem } from "../../../api/commands.js";
import { KIND_COLORS, activeRules, kindFromName, kindFromRule, nameMatchesRule, sameRuleFormat } from "./kinds.js";
import {
	analyzeKeywords,
	agentRule,
	buildOutgoing as buildOutgoingPure,
	normalizeAgentCommand,
	slotChar,
	TOKEN_RE,
	tokenRegexFor,
	type KwRange,
	type OutgoingFile,
} from "./rules.js";
import {
	buildClipboardPayload,
	clipboardFilesFor,
	parseClipboardPayload,
	SMART_BUBBLE_CLIPBOARD_TYPE,
	type SmartBubbleClipboardPayload,
} from "./clipboard.js";
import {
	autoScrollDelta,
	dropMatchState as dropMatchStatePure,
	offsetAtPointInAtoms,
	parseAttachmentTransfer,
	buildDragFilePanel,
	type DropMatchState,
	type FlowAtom,
} from "./drag-utils.js";
import { getOversizedFiles } from "../../../utils/upload-limits.js";

/**
 * SmartInputEngine — imperative port of the v76 prototype's three-layer
 * composer (mirror / textarea / hit layer). React owns the layer elements;
 * this class owns tokens, slots, rendering and the atomic-caret behavior.
 *
 * Layers:
 *   mirror  (bottom) — renders the visible text + red keyword underlines and
 *                      transparent token spans that size the in-text bubbles
 *   textarea (mid)   — transparent text, visible caret; the single source of
 *                      truth for the value
 *   hit     (top)    — absolutely positioned keyword hit-zones and bubble
 *                      chips; bubbles stay aligned to their inline token in
 *                      the mirror and can be reordered within the text flow
 */

export interface BoundFile {
	uid: number;
	name: string;
	/** Upload target / workspace path. */
	path: string;
	source: "workspace" | "upload";
	state: OutgoingFile["state"];
	pct: number;
	/** Present for staged OS files. */
	file?: File;
}

export interface Slot {
	id: number;
	word: string;
	rule: SmartInputRule;
	files: BoundFile[];
	/** File bubbles are the legacy/default kind; Agent bubbles carry commands. */
	bubbleType?: "file" | "agent";
	/** Command without the leading slash, e.g. `recall` or `skill:lesson-plan`. */
	agentCommand?: string;
	/** Last badge count — only re-pop when the number changes. */
	_bc?: number;
	/** Spawned this sync — play the materialize animation once. */
	_spawn?: boolean;
	/** Measured token width from buildToken — avoids a DOM probe per render. */
	_w?: number;
	/** `insertAgentCommandAsBubble` added a command-argument separator space. */
	_agentSpacer?: boolean;
}

export interface EngineAttachmentItem {
	name: string;
	path: string;
	source: "workspace" | "local";
	file?: File;
}

export interface EngineSnapshot {
	slotCount: number;
	boundFileCount: number;
}

export interface EngineCallbacks {
	onChange: () => void;
	onSlotsSnapshot: (snapshot: EngineSnapshot) => void;
	onOpenStatusPanel: (slot: Slot, anchor: HTMLElement) => void;
	onOpenFillMenu: (slot: Slot, anchor: HTMLElement) => void;
	onOpenAgentPicker?: (keyword: KwRange, anchor: HTMLElement) => void;
	onAgentBubbleClick?: (slot: Slot, anchor: HTMLElement) => void;
	onBubbleContextMenu: (event: MouseEvent, slot: Slot, anchor: HTMLElement) => void;
	onBubbleClose?: (slot: Slot, anchor: HTMLElement) => void;
	/** Filled-chip hover — drives the 250ms hover-open of the status panel. */
	onChipHover?: (slot: Slot, anchor: HTMLElement, entering: boolean) => void;
	onUploadLimitExceeded?: (count: number) => void;
	onWorkspaceHighlight: (paths: string[] | null) => void;
}

export interface EngineData {
	getSettings: () => { enabled: boolean; allowDrag: boolean; allowRightClick: boolean; allowAgentCommands: boolean };
	getRules: () => SmartInputRule[];
	takeAttachment: (path: string) => EngineAttachmentItem | undefined;
	returnAttachment: (item: EngineAttachmentItem) => void;
}

export interface EngineLabels {
	[key: string]: string;
}

export interface SmartInputEngineOptions {
	textarea: HTMLTextAreaElement;
	mirror: HTMLElement;
	hitLayer: HTMLElement;
	labels: () => EngineLabels;
	/** Localized human-readable label for a command bubble. */
	agentCommandLabel?: (command: string) => string;
	data: EngineData;
	callbacks: EngineCallbacks;
}

interface TokRect {
	start: number;
	end: number;
	x0: number;
	x1: number;
}

const DWELL_MS = 1000;
const BUBBLE_SEAM_PX = 3;
const DROP_STATUS_FALLBACK_MS = 3000;

export class SmartInputEngine {
	private readonly ta: HTMLTextAreaElement;
	private readonly mirror: HTMLElement;
	private readonly hit: HTMLElement;
	private readonly opts: SmartInputEngineOptions;

	slots: Slot[] = [];
	private nextSlotId = 1;
	private nextFileId = 1;
	private tokRects: TokRect[] = [];
	private renderedKeywords: KwRange[] = [];
	private renderedSlots: Array<{ start: number; end: number; slotId: number }> = [];
	/** Bumped on every mirror rebuild; invalidates drag hit-test caches. */
	private mirrorVersion = 0;
	private flowAtomsCache: { version: number; value: string; atoms: FlowAtom[] } | null = null;
	private lastSelection: { start: number; end: number } | null = null;
	private selectionRenderScheduled = false;
	private syncFrame: number | null = null;
	private detached = false;
	private dwellFollower: HTMLElement | null = null;
	private dwellRaf = 0;
	private dwellStart = 0;
	private dragFollower: HTMLElement | null = null;
	private dragFollowerStatus: HTMLElement | null = null;
	private dropStatusSlotId: number | null = null;
	private dropStatusTimer: number | null = null;
	private dragPos = { x: 0, y: 0 };
	private bubblePointerDrag: {
		slot: Slot;
		pointerId: number;
		startX: number;
		startY: number;
		clientX: number;
		clientY: number;
		moved: boolean;
	} | null = null;
	private bubbleAutoScrollRaf: number | null = null;
	private suppressedBubbleClickSlotId: number | null = null;
	/** Set while an in-page file drag is live (workspace handle / attachment chip). */
	dragMeta: {
		raw: string;
		files: EngineAttachmentItem[];
		consumed?: boolean;
	} | null = null;

	constructor(options: SmartInputEngineOptions) {
		this.opts = options;
		this.ta = options.textarea;
		this.mirror = options.mirror;
		this.hit = options.hitLayer;
	}

	// ── lifecycle ───────────────────────────────────────────────────────────

	attach(): void {
		const ta = this.ta;
		ta.addEventListener("input", this.handleInput);
		ta.addEventListener("beforeinput", this.handleBeforeInput);
		ta.addEventListener("copy", this.handleCopy);
		ta.addEventListener("paste", this.handlePaste);
		ta.addEventListener("keydown", this.handleKeyDown);
		ta.addEventListener("click", this.snapCaretOut);
		ta.addEventListener("select", this.snapCaretOut);
		ta.addEventListener("select", this.handleSelectionChange);
		ta.addEventListener("mousedown", this.handleMouseDown);
		ta.addEventListener("scroll", this.handleScroll);
		document.addEventListener("selectionchange", this.handleDocumentSelectionChange);
		window.addEventListener("resize", this.sync);
		this.sync();
	}

	/**
	 * Flush a pending mirror update immediately after a paste or a programmatic
	 * textarea edit. The visible textarea is transparent while smart input is
	 * enabled, so waiting for a scheduled mirror update would briefly expose an
	 * empty mirror during rapid paste operations.
	 */
	syncNow(): void {
		if (this.detached) return;
		this.cancelPendingSync();
		this.sync();
	}

	private cancelPendingSync(): void {
		if (this.syncFrame !== null) {
			cancelAnimationFrame(this.syncFrame);
			this.syncFrame = null;
		}
	}

	private scheduleFrameSync(): void {
		if (this.syncFrame !== null) return;
		if (typeof requestAnimationFrame !== "function") {
			this.sync();
			return;
		}
		this.syncFrame = requestAnimationFrame(() => {
			this.syncFrame = null;
			this.sync();
		});
	}

	/**
	 * Rehydrate slots when the composer DOM remounts (welcome ↔ conversation
	 * switch). Tokens in the surviving draft value keep their PUA slot ids, so
	 * the new engine instance adopts the old slot list as-is.
	 */
	adoptSlots(slots: Slot[]): void {
		this.slots = slots;
		this.nextSlotId = slots.reduce((max, slot) => Math.max(max, slot.id + 1), 1);
		this.nextFileId = slots.reduce(
			(max, slot) => slot.files.reduce((inner, file) => Math.max(inner, file.uid + 1), max),
			1,
		);
	}

	detach(): void {
		this.detached = true;
		this.teardown();
		// Settings only affect future input: restore any in-draft bubbles back
		// to their plain words so no PUA glyphs leak into the raw value. Bound
		// files leave the disabled bubble and return to the attachment row.
		this.restoreAllTokens();
		for (const slot of this.slots) this.returnFilesToAttachments(slot);
		this.slots = [];
		this.opts.callbacks.onWorkspaceHighlight(null);
		this.emitSnapshot();
	}

	/**
	 * Tear down for a composer DOM remount (welcome ↔ conversation switch):
	 * listeners and layers go away, but the draft value and slot list survive
	 * so the next engine instance picks up exactly where this one left off.
	 */
	detachForRemount(): void {
		this.detached = true;
		this.teardown();
	}

	private teardown(): void {
		this.cancelPendingSync();
		this.stopDwellFollower();
		this.stopDropStatusFollower();
		this.cancelBubblePointerDrag();
		this.ta.removeEventListener("input", this.handleInput);
		this.ta.removeEventListener("beforeinput", this.handleBeforeInput);
		this.ta.removeEventListener("copy", this.handleCopy);
		this.ta.removeEventListener("paste", this.handlePaste);
		this.ta.removeEventListener("keydown", this.handleKeyDown);
		this.ta.removeEventListener("click", this.snapCaretOut);
		this.ta.removeEventListener("select", this.snapCaretOut);
		this.ta.removeEventListener("select", this.handleSelectionChange);
		this.ta.removeEventListener("mousedown", this.handleMouseDown);
		this.ta.removeEventListener("scroll", this.handleScroll);
		document.removeEventListener("selectionchange", this.handleDocumentSelectionChange);
		window.removeEventListener("resize", this.sync);
		this.mirror.innerHTML = "";
		this.hit.innerHTML = "";
		this.renderedKeywords = [];
		this.renderedSlots = [];
		this.opts.callbacks.onWorkspaceHighlight(null);
	}

	private emitSnapshot(): void {
		this.opts.callbacks.onSlotsSnapshot({
			slotCount: this.slots.length,
			boundFileCount: this.slots.reduce((sum, slot) => sum + slot.files.length, 0),
		});
		this.opts.callbacks.onChange();
	}

	// ── input / IME ─────────────────────────────────────────────────────────

	private handleInput = (event: Event): void => {
		this.cancelPendingSync();
		// IME composition: sync the mirror immediately so composition text
		// renders through the mirror and tokens never flash as raw glyphs.
		const inputEvent = event as InputEvent;
		if (inputEvent.isComposing) {
			this.sync();
			return;
		}
		// Pasting can fire repeatedly before the typing debounce expires. Flush
		// these edits synchronously so the transparent textarea never shows a
		// stale/empty mirror between two paste events.
		if (inputEvent.inputType === "insertFromPaste" || inputEvent.inputType === "insertFromDrop") {
			this.sync();
			return;
		}
		// Regular typing and deletion both sync once per animation frame. This
		// keeps fast English input visible without rebuilding the mirror for every
		// native event in a key-repeat burst.
		this.scheduleFrameSync();
	};

	private handleCopy = (event: ClipboardEvent): void => {
		const selectionStart = this.ta.selectionStart ?? 0;
		const selectionEnd = this.ta.selectionEnd ?? selectionStart;
		if (selectionStart === selectionEnd || !event.clipboardData) return;
		const payload = this.buildClipboardPayload(selectionStart, selectionEnd);
		if (!payload) return;

		// Keep ordinary text useful when pasted outside Inno Agent. The app-specific
		// payload below is what restores the bubble and its bound files inside the
		// composer; the fallback exposes the names instead of leaking PUA markers.
		const fileNames = Array.from(new Set(payload.bubbles.flatMap((bubble) => bubble.files.map((file) => file.name))));
		const fallbackText = fileNames.length > 0 ? `${payload.text}\n${fileNames.join("\n")}` : payload.text;
		event.clipboardData.setData("text/plain", fallbackText);
		event.clipboardData.setData(SMART_BUBBLE_CLIPBOARD_TYPE, JSON.stringify(payload));
		event.preventDefault();
	};

	private handlePaste = (event: ClipboardEvent): void => {
		const raw = event.clipboardData?.getData(SMART_BUBBLE_CLIPBOARD_TYPE);
		if (!raw) return;
		const payload = this.parseClipboardPayload(raw);
		if (!payload || payload.bubbles.length === 0) return;
		event.preventDefault();
		// A copied file should behave like a file dropped onto the composer: put
		// it back in the loose attachment row above the textarea. Only restore the
		// bubble when the clipboard payload contains no files.
		if (!this.returnClipboardFilesToAttachments(payload)) this.insertClipboardPayload(payload);
	};

	private returnClipboardFilesToAttachments(payload: SmartBubbleClipboardPayload): boolean {
		const copiedFiles = payload.bubbles.flatMap((bubble) => bubble.files);
		if (copiedFiles.length === 0) return false;

		const cachedFiles = clipboardFilesFor(payload.clipboardId);
		const seen = new Set<string>();
		const attachments = copiedFiles.flatMap((file): EngineAttachmentItem[] => {
			const key = `${file.source}\u0000${file.path}\u0000${file.name}`;
			if (seen.has(key)) return [];
			seen.add(key);
			if (file.source === "workspace") {
				return [{ name: file.name, path: file.path, source: "workspace" }];
			}
			const localFile = file.cacheKey ? cachedFiles?.get(file.cacheKey) : undefined;
			return localFile
				? [{ name: file.name, path: file.path, source: "local", file: localFile }]
				: [];
		});
		if (attachments.length === 0) return false;

		for (const attachment of attachments) this.opts.data.returnAttachment(attachment);
		return true;
	}

	private buildClipboardPayload(selectionStart: number, selectionEnd: number): SmartBubbleClipboardPayload | null {
		return buildClipboardPayload(this.ta.value, selectionStart, selectionEnd, this.tokenRanges(), this.slots);
	}

	private parseClipboardPayload(raw: string): SmartBubbleClipboardPayload | null {
		return parseClipboardPayload(raw, (rule, word) => this.clipboardRule(rule, word), {
			allowAgentBubbles: this.opts.data.getSettings().allowAgentCommands,
		});
	}

	private clipboardRule(raw: unknown, word: string): SmartInputRule {
		const value = raw && typeof raw === "object" ? raw as Partial<SmartInputRule> : {};
		const rules = this.activeRules();
		const current = rules.find((rule) => rule.id === value.id)
			?? rules.find((rule) => rule.keyword === word);
		if (current) return current;
		return {
			id: typeof value.id === "string" && value.id ? value.id : `clipboard-${word}`,
			isPreset: value.isPreset === true,
			keyword: word,
			extensions: Array.isArray(value.extensions) ? value.extensions.filter((item): item is string => typeof item === "string") : [],
			allExtensions: value.allExtensions === true,
			excludeExtensions: Array.isArray(value.excludeExtensions) ? value.excludeExtensions.filter((item): item is string => typeof item === "string") : [],
			enabled: true,
		};
	}

	private insertClipboardPayload(payload: SmartBubbleClipboardPayload): void {
		const value = this.ta.value;
		let selectionStart = this.ta.selectionStart ?? value.length;
		let selectionEnd = this.ta.selectionEnd ?? selectionStart;
		const touched = this.tokenRanges().filter(([start, end]) => selectionStart < end && selectionEnd > start);
		if (touched.length > 0) {
			selectionStart = Math.min(selectionStart, ...touched.map(([start]) => start));
			selectionEnd = Math.max(selectionEnd, ...touched.map(([, end]) => end));
			const removedIds = new Set(touched.map(([, , id]) => id));
			for (const slot of this.slots) {
				if (removedIds.has(slot.id)) this.returnFilesToAttachments(slot);
			}
			this.slots = this.slots.filter((slot) => !removedIds.has(slot.id));
		}

		const cachedFiles = clipboardFilesFor(payload.clipboardId);
		let inserted = "";
		let cursor = 0;
		for (const bubble of payload.bubbles) {
			inserted += payload.text.slice(cursor, bubble.start);
			const slot: Slot = {
				id: this.nextSlotId++,
				word: bubble.word,
				rule: bubble.rule,
				files: [],
				...(bubble.bubbleType === "agent"
					? { bubbleType: "agent" as const, agentCommand: bubble.agentCommand }
					: {}),
			};
			for (const file of bubble.files) {
				const isWorkspace = file.source === "workspace";
				const localFile = !isWorkspace && file.cacheKey ? cachedFiles?.get(file.cacheKey) : undefined;
				slot.files.push({
					uid: this.nextFileId++,
					name: file.name,
					path: file.path,
					source: isWorkspace ? "workspace" : "upload",
					state: isWorkspace ? "workspace" : localFile ? "local" : "failed",
					pct: isWorkspace ? 100 : 0,
					file: localFile,
				});
			}
			this.slots.push(slot);
			inserted += this.buildToken(slot).token;
			cursor = bubble.end;
		}
		inserted += payload.text.slice(cursor);
		this.ta.value = value.slice(0, selectionStart) + inserted + value.slice(selectionEnd);
		const caret = selectionStart + inserted.length;
		this.ta.focus();
		this.ta.setSelectionRange(caret, caret);
		this.sync();
	}

	private handleScroll = (): void => {
		this.applyScrollOffset();
	};

	/**
	 * The textarea is transparent while smart input is enabled. Its native
	 * selection therefore cannot paint the text the user actually sees: that
	 * text lives in the mirror below it. Repaint the mirror whenever the native
	 * selection changes so mouse selection and Ctrl/Cmd+A look identical to a
	 * normal textarea.
	 */
	private handleSelectionChange = (): void => {
		if (this.detached) return;
		this.renderSelectionState(true);
	};

	private handleDocumentSelectionChange = (): void => {
		if (this.detached || document.activeElement !== this.ta) return;
		this.renderSelectionState();
	};

	private renderSelectionState(immediate = false): void {
		// selectionchange fires dozens of times per second while dragging a
		// mouse selection; coalesce into one rebuild per frame and skip when
		// the selection did not actually move.
		const start = this.ta.selectionStart ?? 0;
		const end = this.ta.selectionEnd ?? start;
		if (this.lastSelection && start === this.lastSelection.start && end === this.lastSelection.end) return;
		this.lastSelection = { start, end };
		if (immediate) {
			this.selectionRenderScheduled = false;
			this.renderMirror(this.ta.value, this.renderedKeywords, this.renderedSlots);
			this.syncChipSelection();
			return;
		}
		if (this.selectionRenderScheduled) return;
		this.selectionRenderScheduled = true;
		const run = (): void => {
			this.selectionRenderScheduled = false;
			if (this.detached) return;
			this.renderMirror(this.ta.value, this.renderedKeywords, this.renderedSlots);
			this.syncChipSelection();
		};
		if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(run);
		else run();
	}

	private applyScrollOffset(): void {
		const transform = `translateY(${-this.ta.scrollTop}px)`;
		// The mirror and the hit layer share the same coordinate system. Moving
		// only the mirror makes text scroll while bubbles stay pinned to the old
		// line; keep both layers on the same scroll offset.
		this.mirror.style.transform = transform;
		this.hit.style.transform = transform;
	}

	private restoreScrollTop(scrollTop: number): void {
		const restore = () => {
			this.ta.scrollTop = scrollTop;
			this.applyScrollOffset();
		};
		restore();
		// Focusing and restoring the caret can trigger a browser-native scroll on
		// the next frame. Restore once more after that happens so converting an
		// earlier keyword does not jump a long draft to its last line.
		if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(restore);
	}

	// ── analyze + render ────────────────────────────────────────────────────

	private activeRules(): SmartInputRule[] {
		return activeRules(this.opts.data.getRules());
	}

	private agentKeywords(): string[] {
		return this.opts.data.getSettings().allowAgentCommands ? ["技能", "skill"] : [];
	}

	/**
	 * Native editing can still split a token before keydown reaches us (for
	 * example, deleting a selected range or using word-delete). Never let the
	 * implementation marker leak into the visible textarea: restore a known
	 * broken token to its plain keyword, and discard an orphan marker.
	 */
	private repairBrokenTokens(): string {
		const original = this.ta.value;
		if (!original) return original;
		// Fast path: plain typing with no slots and no marker/brace/orphan
		// syntax cannot need repair, and the scans below run on every sync.
		if (this.slots.length === 0 && !/[\uE000-\uF8FF{}]/.test(original)) return original;

		const fragmentFor = (markerIndex: number): { start: number; end: number } => {
			let start = markerIndex;
			let end = markerIndex + 1;
			if (start > 0 && original[start - 1] === "{") start -= 1;
			if (original[end] === "}") end += 1;
			while (original[end] === "\u00A0") end += 1;
			return { start, end };
		};

		const replacements: Array<{ start: number; end: number; text: string }> = [];
		const protectedRanges: Array<{ start: number; end: number }> = [];
		const covered = (index: number): boolean =>
			replacements.some((replacement) => index >= replacement.start && index < replacement.end) ||
			protectedRanges.some((range) => index >= range.start && index < range.end);

		for (const slot of this.slots) {
			const tokenMatch = tokenRegexFor(slot.id).exec(original);
			if (tokenMatch) {
				const markerIndex = original.indexOf(slotChar(slot.id), tokenMatch.index);
				if (markerIndex !== -1) protectedRanges.push(fragmentFor(markerIndex));
				continue;
			}
			const markerIndex = original.indexOf(slotChar(slot.id));
			if (markerIndex === -1) continue;
			const fragment = fragmentFor(markerIndex);
			replacements.push({ ...fragment, text: slot.word });
		}

		// A stale slot can survive a remount or a selection edit. It has no word
		// to restore, so remove its marker and any adjacent token syntax instead
		// of rendering a private-use glyph to the user.
		const markerRe = /[\uE000-\uF8FF]/g;
		let marker: RegExpExecArray | null;
		while ((marker = markerRe.exec(original))) {
			if (!covered(marker.index)) {
				const fragment = fragmentFor(marker.index);
				replacements.push({ ...fragment, text: "" });
			}
		}
		// If the private-use marker itself was deleted, the native control can
		// leave only `{`/`}` plus the internal NBSP padding. Those NBSPs are not
		// user text, so this narrow cleanup is safe and removes the last visible
		// piece of a broken token without touching ordinary braces or spaces.
		const orphanSyntaxRe = /(?:\{\}|\{|\})\u00A0+/g;
		let orphanSyntax: RegExpExecArray | null;
		while ((orphanSyntax = orphanSyntaxRe.exec(original))) {
			if (!covered(orphanSyntax.index)) {
				replacements.push({ start: orphanSyntax.index, end: orphanSyntax.index + orphanSyntax[0].length, text: "" });
			}
		}
		if (replacements.length === 0) return original;

		const selectionStart = this.ta.selectionStart ?? original.length;
		const selectionEnd = this.ta.selectionEnd ?? selectionStart;
		let nextStart = selectionStart;
		let nextEnd = selectionEnd;
		let value = original;
		for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
			value = value.slice(0, replacement.start) + replacement.text + value.slice(replacement.end);
			const delta = replacement.text.length - (replacement.end - replacement.start);
			const mapPosition = (position: number): number => {
				if (position < replacement.start) return position;
				if (position > replacement.end) return position + delta;
				if (position === replacement.start) return position;
				return replacement.start + replacement.text.length;
			};
			nextStart = mapPosition(nextStart);
			nextEnd = mapPosition(nextEnd);
		}

		this.ta.value = value;
		this.ta.setSelectionRange(
			Math.max(0, Math.min(value.length, nextStart)),
			Math.max(0, Math.min(value.length, nextEnd)),
		);
		return value;
	}

	sync = (): void => {
		if (this.detached) return;
		const value = this.repairBrokenTokens();

		// Slots whose token vanished (edited away) die; their files flow back
		// to the attachment row.
		const alive = new Set<number>();
		TOKEN_RE.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = TOKEN_RE.exec(value))) {
			alive.add(match[1].codePointAt(0)! - 0xE000);
		}
		this.slots = this.slots.filter((slot) => {
			if (alive.has(slot.id)) return true;
			this.returnFilesToAttachments(slot);
			return false;
		});

		if (!this.opts.data.getSettings().enabled) {
			this.renderedKeywords = [];
			this.renderedSlots = [];
			this.renderMirror(value, [], []);
			this.hit.innerHTML = "";
			this.emitSnapshot();
			return;
		}

		const { kws, slots } = analyzeKeywords(value, this.activeRules(), alive, this.agentKeywords());
		this.renderedKeywords = kws;
		this.renderedSlots = slots;
		this.renderMirror(value, kws, slots);
		this.renderHitLayer(kws, slots);
		this.emitSnapshot();
	};

	private escape(text: string): string {
		return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	}

	private selectionBounds(value: string): { start: number; end: number } | null {
		const anchor = this.ta.selectionStart ?? 0;
		const focus = this.ta.selectionEnd ?? anchor;
		const start = Math.max(0, Math.min(value.length, Math.min(anchor, focus)));
		const end = Math.max(0, Math.min(value.length, Math.max(anchor, focus)));
		return start < end ? { start, end } : null;
	}

	private selectionOverlaps(start: number, end: number): boolean {
		const selection = this.selectionBounds(this.ta.value);
		return selection !== null && selection.start < end && selection.end > start;
	}

	private renderMirror(value: string, kws: KwRange[], slots: Array<{ start: number; end: number; slotId: number }>): void {
		const selection = this.selectionBounds(value);
		const appendRange = (start: number, end: number, className?: string, attributes = ""): string => {
			if (end <= start) return "";
			const cuts = [start, end];
			if (selection && selection.start > start && selection.start < end) cuts.push(selection.start);
			if (selection && selection.end > start && selection.end < end) cuts.push(selection.end);
			cuts.sort((a, b) => a - b);
			let output = "";
			for (let index = 0; index < cuts.length - 1; index += 1) {
				const partStart = cuts[index]!;
				const partEnd = cuts[index + 1]!;
				const text = this.escape(value.slice(partStart, partEnd));
				const styled = className ? `<span class="${className}"${attributes}>${text}</span>` : text;
				const selected = selection !== null && partStart >= selection.start && partEnd <= selection.end;
				output += selected ? `<span class="inno-smart-selection">${styled}</span>` : styled;
			}
			return output;
		};

		let html = "";
		let pos = 0;
		const ranges: Array<{ start: number; end: number; kind: "kw" | "slot"; kw?: KwRange; slotId?: number }> = [
			...kws.map((kw) => ({ start: kw.start, end: kw.end, kind: "kw" as const, kw })),
			...slots.map((slot) => ({ start: slot.start, end: slot.end, kind: "slot" as const, slotId: slot.slotId })),
		].sort((a, b) => a.start - b.start);
		for (const range of ranges) {
			html += appendRange(pos, range.start);
			if (range.kind === "kw") {
				html += appendRange(
					range.start,
					range.end,
					`inno-smart-kw${range.kw?.hi ? " is-hi" : ""}`,
					` data-smart-kw-start="${range.start}" data-smart-kw-end="${range.end}"`,
				);
			} else {
				const slot = this.slots.find((entry) => entry.id === range.slotId);
				// _w is measured once at buildToken; probing here would force a
				// synchronous reflow for every slot on every keystroke.
				const width = slot?._w ?? 48;
				const selected = selection !== null && selection.start < range.end && selection.end > range.start;
				html += `<span class="inno-smart-slot-tok${selected ? " is-selected" : ""}" data-slot-id="${range.slotId ?? ""}" style="width:${width}px">${this.escape(value.slice(range.start, range.end))}</span>`;
			}
			pos = range.end;
		}
		html += appendRange(pos, value.length) + "\n";
		this.mirror.innerHTML = html;
		this.mirrorVersion += 1;
		this.applyScrollOffset();
	}

	private renderHitLayer(kws: KwRange[], slots: Array<{ start: number; end: number; slotId: number }>): void {
		this.hit.innerHTML = "";
		const kwSpans = Array.from(this.mirror.querySelectorAll<HTMLElement>("span.inno-smart-kw"));
		const slotSpans = Array.from(this.mirror.querySelectorAll<HTMLElement>("span.inno-smart-slot-tok"));

		let ki = 0;
		for (const kw of kws) {
			const span = kwSpans[ki++];
			if (span) this.hit.appendChild(this.makeKwHit(span, kw));
		}
		this.tokRects = [];
		let si = 0;
		for (const slotRange of slots) {
			const span = slotSpans[si++];
			const slot = this.slots.find((entry) => entry.id === slotRange.slotId);
			if (!span || !slot) continue;
			this.hit.appendChild(this.makeSlotChip(span, slot, this.selectionOverlaps(slotRange.start, slotRange.end)));
			this.tokRects.push({
				start: slotRange.start,
				end: slotRange.end,
				x0: span.offsetLeft,
				x1: span.offsetLeft + span.getBoundingClientRect().width,
			});
		}
	}

	private syncChipSelection(): void {
		if (this.renderedSlots.length === 0) return;
		const ranges = new Map(this.renderedSlots.map((entry) => [entry.slotId, entry]));
		const selection = this.selectionBounds(this.ta.value);
		for (const chip of this.hit.querySelectorAll<HTMLElement>(".inno-smart-chip[data-slot-id]")) {
			const range = ranges.get(Number(chip.dataset.slotId));
			const selected = range && selection !== null && selection.start < range.end && selection.end > range.start;
			chip.classList.toggle("is-selected", Boolean(selected));
		}
	}

	// ── token construction (DOM-probe measurement) ──────────────────────────

	private probeWidth(text: string, chip: boolean): number {
		const probe = document.createElement("span");
		probe.className = chip ? "inno-smart-chip-probe" : "inno-smart-ta-probe";
		probe.textContent = text;
		this.hit.appendChild(probe);
		const width = probe.getBoundingClientRect().width;
		probe.remove();
		return width;
	}

	private tokenLayout(slot: Slot): { token: string; width: number } {
		const core = `{${slotChar(slot.id)}}`;
		// NBSPs are internal caret padding only. TOKEN_RE deliberately excludes
		// ordinary spaces, so a user-entered space after the bubble stays outside
		// the token and cannot stretch it.
		const chipText = slot.bubbleType === "agent" ? this.agentDisplayName(slot) : slot.word;
		// Agent chips also contain a small command icon. Reserve its width so the
		// human-readable skill/command label is never clipped by the token span.
		const iconWidth = slot.bubbleType === "agent" ? 16 : 0;
		const chipWidth = Math.max(36, this.probeWidth(chipText, true) + iconWidth);
		const targetWidth = chipWidth + BUBBLE_SEAM_PX * 2;
		const coreWidth = this.probeWidth(core, false);
		const spaceWidth = this.probeWidth("\u00A0", false) || 4.6;
		const padding = Math.max(0, Math.ceil((targetWidth - coreWidth) / spaceWidth));
		const token = core + "\u00A0".repeat(padding);
		// The textarea caret follows this real text width, not the CSS width of
		// the mirror span. Use the measured token width for both sides so the
		// caret seam is symmetric even when NBSP width rounds differently.
		return { token, width: this.probeWidth(token, false) };
	}

	buildToken(slot: Slot): { token: string; re: RegExp } {
		const layout = this.tokenLayout(slot);
		slot._w = layout.width;
		return { token: layout.token, re: tokenRegexFor(slot.id) };
	}

	// ── keyword hit zone ────────────────────────────────────────────────────

	private makeKwHit(span: HTMLElement, kw: KwRange): HTMLElement {
		const button = document.createElement("button");
		const spanSelector = `span.inno-smart-kw[data-smart-kw-start="${kw.start}"][data-smart-kw-end="${kw.end}"]`;
		const currentSpans = (): HTMLElement[] => Array.from(this.mirror.querySelectorAll<HTMLElement>(spanSelector));
		const setHot = (hot: boolean): void => {
			for (const current of currentSpans()) current.classList.toggle("is-hot", hot);
		};
		button.type = "button";
		button.className = `inno-smart-kw-hit${kw.kind === "agent" ? " is-agent" : ""}`;
		button.dataset.smartKwStart = String(kw.start);
		button.dataset.smartKwEnd = String(kw.end);
		const spanRect = span.getBoundingClientRect();
		button.style.left = `${span.offsetLeft}px`;
		button.style.top = `${span.offsetTop}px`;
		button.style.width = `${spanRect.width}px`;
		button.style.height = `${spanRect.height}px`;
		button.title = kw.kind === "agent"
			? (this.opts.labels().agentKwHitTitle ?? this.opts.labels().kwHitTitle)
			: this.opts.labels().kwHitTitle;
		button.addEventListener("mouseenter", () => setHot(true));
		button.addEventListener("mouseleave", () => setHot(false));
		if (kw.kind === "agent") {
			button.addEventListener("click", () => this.opts.callbacks.onOpenAgentPicker?.(kw, button));
			return button;
		}
		button.addEventListener("click", () => {
			const slot = this.toBubble(kw);
			if (!slot) return;
			// `toBubble` synchronously rebuilds the hit layer, so the original
			// keyword button is detached by the time the conversion completes.
			// Anchor the workspace-file picker to the newly-created live bubble.
			const chip = this.hit.querySelector<HTMLElement>(`.inno-smart-chip[data-slot-id="${slot.id}"]`);
			if (chip) this.opts.callbacks.onOpenFillMenu(slot, chip);
		});
		// Drag-dwell: hover 1s while dragging a compatible file → auto-convert
		// and bind the in-hand file.
		let dwellTimer: number | null = null;
		// Negative pseudo-id so keyword status never collides with slot ids.
		const keywordStatusId = -(kw.start + 1);
		const clearDwell = () => {
			if (dwellTimer !== null) window.clearTimeout(dwellTimer);
			dwellTimer = null;
			this.stopDwellFollower();
			this.stopDropStatusFollower(keywordStatusId);
			setHot(false);
		};
		const matchesDrag = (): boolean => {
			const meta = this.dragMeta;
			if (!meta || meta.consumed) return false;
			return meta.files.some((file) => this.ruleAccepts(kw.rule, file.name));
		};
		const autoConvert = (): Slot | null => {
			const meta = this.dragMeta;
			if (!meta || !matchesDrag()) return null;
			if (this.ta.value.slice(kw.start, kw.end) !== kw.word) return null;
			const items = [...meta.files];
			const slot = this.toBubble(kw);
			if (slot) {
				slot._spawn = true;
				const result = this.bindAttachmentFiles(slot, items);
				if (result.accepted > 0) {
					const state = this.dropMatchState(slot, items);
					const labels = this.opts.labels();
					this.showDropStatus(slot, state, labels.dropReleaseToFinish);
				}
				meta.consumed = true;
				// The physical drag can continue after the keyword has converted.
				// Tell the outer composer not to treat the eventual mouse-up as a
				// second drop into the loose attachment row.
				document.body.classList.add("inno-smart-drag-consumed");
				document.body.classList.remove("inno-smart-dragging");
				this.hit.querySelectorAll(".inno-smart-chip.is-drag-match").forEach((el) => el.classList.remove("is-drag-match"));
				return slot;
			}
			return null;
		};
		button.addEventListener("dragover", (event) => {
			if (!this.opts.data.getSettings().allowDrag || !this.dragMeta) return;
			if (!matchesDrag()) {
				// Plain keyword (not yet a bubble): still surface match feedback.
				// A ppt over "pdf" shows 不匹配, a mixed batch shows 部分匹配.
				const meta = this.dragMeta;
				if (meta && !meta.consumed && this.ta.value.slice(kw.start, kw.end) === kw.word) {
					const state = dropMatchStatePure(meta.files, (name) => this.ruleAccepts(kw.rule, name));
					if (state !== "match") this.showDropStatus({ id: keywordStatusId, word: kw.word }, state);
				}
				return;
			}
			event.preventDefault();
			event.dataTransfer!.dropEffect = "copy";
			if (dwellTimer !== null) return;
			setHot(true);
			this.startDwellFollower(KIND_COLORS[this.kindOfRule(kw.rule)]);
			dwellTimer = window.setTimeout(() => {
				clearDwell();
				autoConvert();
			}, DWELL_MS);
		});
		button.addEventListener("dragleave", clearDwell);
		button.addEventListener("drop", (event) => {
			event.preventDefault();
			event.stopPropagation();
			if (!this.opts.data.getSettings().allowDrag || !this.dragMeta) return;
			if (!matchesDrag()) return;
			clearDwell();
			autoConvert();
		});
		return button;
	}

	private startDwellFollower(color: string): void {
		this.stopDwellFollower();
		// The dwell ring replaces the file-type badge in the first file row,
		// so it never crowds the file name text.
		const panel = this.ensureDragFollower();
		const ring = document.createElement("div");
		ring.className = "inno-smart-dwell-follower is-inline";
		ring.style.setProperty("--smart-ct", color);
		const firstFileRow = panel.querySelector<HTMLElement>(".inno-drag-follower-file");
		const ext = firstFileRow?.querySelector<HTMLElement>(".inno-drag-follower-ext") ?? null;
		if (ext) {
			ext.classList.add("is-hidden-by-dwell");
			ext.before(ring);
		} else if (firstFileRow) firstFileRow.prepend(ring);
		else panel.appendChild(ring);
		this.dwellFollower = ring;
		this.dwellStart = performance.now();
		const tick = () => {
			if (!this.dwellFollower) return;
			this.dwellFollower.style.setProperty("--dwell-p", `${Math.min(100, (performance.now() - this.dwellStart) / 10)}%`);
			this.dwellRaf = requestAnimationFrame(tick);
		};
		tick();
	}

	private stopDropStatusFollower(slotId?: number): void {
		if (slotId !== undefined && this.dropStatusSlotId !== slotId) return;
		if (this.dropStatusTimer !== null) {
			window.clearTimeout(this.dropStatusTimer);
			this.dropStatusTimer = null;
		}
		this.dragFollowerStatus?.remove();
		this.dragFollowerStatus = null;
		this.dragFollower?.classList.remove("has-status");
		this.dropStatusSlotId = null;
	}

	private removeDragFollower(): void {
		this.stopDropStatusFollower();
		this.dragFollower?.remove();
		this.dragFollower = null;
	}

	private updateDropStatusPosition(): void {
		const follower = this.dragFollower;
		if (!follower) return;
		// The panel hugs the cursor's right side, vertically centered on the
		// pointer (clear of the OS copy badge).
		const left = Math.max(8, Math.min(this.dragPos.x + 16, window.innerWidth - follower.offsetWidth - 8));
		const top = Math.max(8, Math.min(
			this.dragPos.y - follower.offsetHeight / 2,
			window.innerHeight - follower.offsetHeight - 8,
		));
		follower.style.left = `${left}px`;
		follower.style.top = `${top}px`;
	}

	/**
	 * Single live panel that follows the pointer during a drag: the dragged
	 * files (same shell as the attachment drag ghost) plus, while hovering a
	 * bubble, a status row. Replaces the old separate drop-status panel.
	 */
	private ensureDragFollower(): HTMLElement {
		if (this.dragFollower) return this.dragFollower;
		const items = this.dragMeta && !this.dragMeta.consumed ? this.dragMeta.files : [];
		const follower = buildDragFilePanel(items);
		document.body.appendChild(follower);
		this.dragFollower = follower;
		this.updateDropStatusPosition();
		return follower;
	}

	private buildDropStatusIcon(state: DropMatchState, target: { id: number }): HTMLElement {
		const icon = document.createElement("span");
		icon.className = `inno-drag-follower-icon is-${state}`;
		if (state === "partial") {
			const svgNamespace = "http://www.w3.org/2000/svg";
			const svg = document.createElementNS(svgNamespace, "svg");
			svg.setAttribute("viewBox", "0 0 16 16");
			svg.setAttribute("aria-hidden", "true");

			const defs = document.createElementNS(svgNamespace, "defs");
			const leftClip = document.createElementNS(svgNamespace, "clipPath");
			const leftClipId = `inno-smart-drop-left-${target.id}`;
			leftClip.setAttribute("id", leftClipId);
			const leftRect = document.createElementNS(svgNamespace, "rect");
			leftRect.setAttribute("width", "8");
			leftRect.setAttribute("height", "16");
			leftClip.appendChild(leftRect);
			defs.appendChild(leftClip);

			const rightClip = document.createElementNS(svgNamespace, "clipPath");
			const rightClipId = `inno-smart-drop-right-${target.id}`;
			rightClip.setAttribute("id", rightClipId);
			const rightRect = document.createElementNS(svgNamespace, "rect");
			rightRect.setAttribute("x", "8");
			rightRect.setAttribute("width", "8");
			rightRect.setAttribute("height", "16");
			rightClip.appendChild(rightRect);
			defs.appendChild(rightClip);
			svg.appendChild(defs);

			const checkGroup = document.createElementNS(svgNamespace, "g");
			checkGroup.classList.add("is-positive");
			checkGroup.setAttribute("clip-path", `url(#${leftClipId})`);
			const checkPath = document.createElementNS(svgNamespace, "path");
			checkPath.setAttribute("d", "M2.25 8.25 6.1 12 13.75 4.25");
			checkPath.setAttribute("fill", "none");
			checkPath.setAttribute("stroke", "currentColor");
			checkPath.setAttribute("stroke-width", "2.2");
			checkPath.setAttribute("stroke-linecap", "round");
			checkPath.setAttribute("stroke-linejoin", "round");
			checkGroup.appendChild(checkPath);
			svg.appendChild(checkGroup);

			const crossGroup = document.createElementNS(svgNamespace, "g");
			crossGroup.classList.add("is-negative");
			crossGroup.setAttribute("clip-path", `url(#${rightClipId})`);
			const crossPath = document.createElementNS(svgNamespace, "path");
			crossPath.setAttribute("d", "M8.25 4.25 13.75 11.75 M13.75 4.25 8.25 11.75");
			crossPath.setAttribute("fill", "none");
			crossPath.setAttribute("stroke", "currentColor");
			crossPath.setAttribute("stroke-width", "2.2");
			crossPath.setAttribute("stroke-linecap", "round");
			crossPath.setAttribute("stroke-linejoin", "round");
			crossGroup.appendChild(crossPath);
			svg.appendChild(crossGroup);
			icon.appendChild(svg);
		} else {
			icon.textContent = state === "match" ? "✓" : "×";
		}
		return icon;
	}

	private showDropStatus(target: { id: number; word: string }, state: DropMatchState, statusLabelOverride?: string): void {
		const follower = this.ensureDragFollower();
		const current = this.dragFollowerStatus;
		if (current?.dataset.slotId === String(target.id) && current.dataset.state === state) {
			const label = current.querySelector<HTMLElement>(".inno-drag-follower-label");
			if (label) label.textContent = statusLabelOverride ?? label.textContent;
			this.updateDropStatusPosition();
			return;
		}

		const labels = this.opts.labels();
		const statusLabel = statusLabelOverride ?? (state === "match"
			? labels.dropMatch
			: state === "partial" ? labels.dropPartial : labels.dropMismatch);
		current?.remove();

		const status = document.createElement("div");
		status.className = `inno-drag-follower-status is-${state}`;
		status.dataset.slotId = String(target.id);
		status.dataset.state = state;
		status.appendChild(this.buildDropStatusIcon(state, { id: target.id }));

		const name = document.createElement("span");
		name.className = "inno-drag-follower-word";
		name.textContent = target.word;
		status.appendChild(name);

		const label = document.createElement("span");
		label.className = "inno-drag-follower-label";
		label.textContent = statusLabel;
		status.appendChild(label);

		follower.appendChild(status);
		follower.classList.add("has-status");
		this.dragFollowerStatus = status;
		this.dropStatusSlotId = target.id;
		this.updateDropStatusPosition();
		if (statusLabelOverride) {
			// Auto-conversion removes the source attachment chip while the native
			// drag is still live, so its dragend event can be lost. Keep a bounded
			// cleanup path even when the browser never reports the terminal event.
			this.dropStatusTimer = window.setTimeout(() => {
				if (this.dropStatusSlotId === target.id) this.cancelBubbleDrag();
			}, DROP_STATUS_FALLBACK_MS);
		}
	}

	stopDwellFollower(): void {
		cancelAnimationFrame(this.dwellRaf);
		if (this.dwellFollower) {
			this.dwellFollower.remove();
			this.dwellFollower = null;
		}
		// Bring the file-type badge back once the ring is gone.
		this.dragFollower?.querySelector(".inno-drag-follower-ext.is-hidden-by-dwell")?.classList.remove("is-hidden-by-dwell");
	}

	trackDragPosition(x: number, y: number): void {
		this.dragPos = { x, y };
		if (this.dragMeta && !this.dragMeta.consumed) this.ensureDragFollower();
		this.updateDropStatusPosition();
	}

	// ── slot chips ──────────────────────────────────────────────────────────

	private kindOfRule(rule: SmartInputRule): keyof typeof KIND_COLORS {
		return kindFromRule(rule);
	}

	private canMergeSlots(source: Slot, target: Slot): boolean {
		return source.id !== target.id
			&& (source.bubbleType ?? "file") === "file"
			&& (target.bubbleType ?? "file") === "file"
			&& sameRuleFormat(source.rule, target.rule);
	}

	private ruleAccepts(rule: SmartInputRule, name: string): boolean {
		return nameMatchesRule(name, rule);
	}

	private transferAttachmentItems(dataTransfer: DataTransfer | null | undefined): EngineAttachmentItem[] {
		return parseAttachmentTransfer(dataTransfer);
	}

	private dropMatchState(slot: Slot, files: EngineAttachmentItem[]): DropMatchState {
		return dropMatchStatePure(files, (name) => this.ruleAccepts(slot.rule, name));
	}

	/**
	 * Resolve the keyword used by the attachment-row context menu. Preset
	 * rules are more specific than a user rule that accepts every format, so
	 * they must win even when the user rule appears first in the settings list.
	 */
	private ruleForAttachment(name: string): SmartInputRule | undefined {
		const matches = this.activeRules().filter((rule) => this.ruleAccepts(rule, name));
		return matches.find((rule) => rule.isPreset === true) ?? matches[0];
	}

	private beginBubblePointerDrag(slot: Slot, event: PointerEvent): void {
		// `allowDrag` controls dragging files onto bubbles. Reordering a bubble
		// is an inline editing operation and must remain available independently.
		if ((event.pointerType === "mouse" && event.button !== 0) || event.button > 0) return;
		const target = event.target as HTMLElement | null;
		if (target?.closest?.(".inno-smart-badge, .inno-smart-chip-x")) return;
		this.suppressedBubbleClickSlotId = null;
		this.clearBubblePointerDrag();
		this.bubblePointerDrag = {
			slot,
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			clientX: event.clientX,
			clientY: event.clientY,
			moved: false,
		};
		// Capture at the window rather than retargeting the pointer to the whole
		// document. This keeps the eventual click targeted at the chip while the
		// drag still receives moves after leaving the chip's own bounds.
		window.addEventListener("pointermove", this.handleBubblePointerMove, true);
		window.addEventListener("pointerup", this.finishBubblePointerDrag, true);
		window.addEventListener("pointercancel", this.cancelBubblePointerDrag, true);
	}

	private handleBubblePointerMove = (event: PointerEvent): void => {
		const drag = this.bubblePointerDrag;
		if (!drag || drag.pointerId !== event.pointerId) return;
		drag.clientX = event.clientX;
		drag.clientY = event.clientY;
		if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 4) return;
		if (!drag.moved) {
			drag.moved = true;
			document.body.classList.add("inno-smart-bubble-dragging");
		}
		event.preventDefault();
		this.autoScrollBubbleDrag();
		if (!this.bubbleAtPoint(event.clientX, event.clientY, drag.slot.id)) {
			this.moveBubbleToPoint(drag.slot, event.clientX, event.clientY);
		}
		this.updateBubbleMergeHint(drag.slot, event.clientX, event.clientY);
		this.scheduleBubbleAutoScroll();
	};

	private autoScrollBubbleDrag(): boolean {
		const drag = this.bubblePointerDrag;
		if (!drag || !drag.moved) return false;
		const rect = this.ta.getBoundingClientRect();
		const maxScroll = Math.max(0, this.ta.scrollHeight - this.ta.clientHeight);
		const delta = autoScrollDelta(drag.clientY, rect, maxScroll);
		if (delta === 0) return false;
		const nextScroll = Math.max(0, Math.min(maxScroll, this.ta.scrollTop + delta));
		if (nextScroll === this.ta.scrollTop) return false;
		this.ta.scrollTop = nextScroll;
		this.applyScrollOffset();
		return true;
	}

	private scheduleBubbleAutoScroll(): void {
		if (this.bubbleAutoScrollRaf !== null || typeof window.requestAnimationFrame !== "function") return;
		this.bubbleAutoScrollRaf = window.requestAnimationFrame(() => {
			this.bubbleAutoScrollRaf = null;
			const drag = this.bubblePointerDrag;
			if (!drag || !drag.moved) return;
			if (!this.autoScrollBubbleDrag()) return;
			if (!this.bubbleAtPoint(drag.clientX, drag.clientY, drag.slot.id)) {
				this.moveBubbleToPoint(drag.slot, drag.clientX, drag.clientY);
			}
			this.updateBubbleMergeHint(drag.slot, drag.clientX, drag.clientY);
			this.scheduleBubbleAutoScroll();
		});
	}

	private finishBubblePointerDrag = (event: PointerEvent): void => {
		const drag = this.bubblePointerDrag;
		if (!drag || drag.pointerId !== event.pointerId) return;
		if (!drag.moved) {
			this.clearBubblePointerDrag();
			return;
		}
		event.preventDefault();
		const targetChip = this.bubbleAtPoint(event.clientX, event.clientY, drag.slot.id);
		const targetSlot = targetChip
			? this.slots.find((slot) => slot.id === Number(targetChip.dataset.slotId))
			: undefined;
		this.clearBubblePointerDrag();
		if (targetSlot && this.canMergeSlots(drag.slot, targetSlot)) {
			this.mergeSlots(drag.slot, targetSlot);
			return;
		}
		this.suppressedBubbleClickSlotId = drag.slot.id;
		window.setTimeout(() => {
			if (this.suppressedBubbleClickSlotId === drag.slot.id) this.suppressedBubbleClickSlotId = null;
		}, 0);
	};

	private cancelBubblePointerDrag = (): void => {
		this.clearBubblePointerDrag();
	};

	private clearBubblePointerDrag(): void {
		if (this.bubbleAutoScrollRaf !== null) {
			window.cancelAnimationFrame(this.bubbleAutoScrollRaf);
			this.bubbleAutoScrollRaf = null;
		}
		window.removeEventListener("pointermove", this.handleBubblePointerMove, true);
		window.removeEventListener("pointerup", this.finishBubblePointerDrag, true);
		window.removeEventListener("pointercancel", this.cancelBubblePointerDrag, true);
		this.bubblePointerDrag = null;
		document.body.classList.remove("inno-smart-bubble-dragging");
		this.hit.querySelectorAll(".inno-smart-chip.is-merge-ok").forEach((el) => el.classList.remove("is-merge-ok"));
	}

	private updateBubbleMergeHint(source: Slot, clientX: number, clientY: number): void {
		this.hit.querySelectorAll(".inno-smart-chip.is-merge-ok").forEach((el) => el.classList.remove("is-merge-ok"));
		const targetChip = this.bubbleAtPoint(clientX, clientY, source.id);
		const target = targetChip
			? this.slots.find((slot) => slot.id === Number(targetChip.dataset.slotId))
			: undefined;
		if (target && this.canMergeSlots(source, target)) targetChip?.classList.add("is-merge-ok");
	}

	private bubbleAtPoint(clientX: number, clientY: number, excludeSlotId?: number): HTMLElement | null {
		for (const chip of Array.from(this.hit.querySelectorAll<HTMLElement>(".inno-smart-chip"))) {
			if (excludeSlotId !== undefined && Number(chip.dataset.slotId) === excludeSlotId) continue;
			const rect = chip.getBoundingClientRect();
			if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) return chip;
		}
		return null;
	}

	private consumeSuppressedBubbleClick(slotId: number, event: MouseEvent): boolean {
		if (this.suppressedBubbleClickSlotId !== slotId) return false;
		this.suppressedBubbleClickSlotId = null;
		event.preventDefault();
		event.stopPropagation();
		return true;
	}

	private textOffsetAtPoint(clientX: number, clientY: number): number | null {
		const doc = this.mirror.ownerDocument;
		const atomOffset = offsetAtPointInAtoms(this.textFlowAtoms(), clientX, clientY);
		if (atomOffset !== null) return atomOffset;

		const docWithCaret = doc as Document & {
			caretRangeFromPoint?: (x: number, y: number) => Range | null;
			caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
		};
		const range = docWithCaret.caretRangeFromPoint?.(clientX, clientY) ?? (() => {
			const position = docWithCaret.caretPositionFromPoint?.(clientX, clientY);
			if (!position) return null;
			const next = doc.createRange();
			try {
				next.setStart(position.offsetNode, position.offset);
				next.collapse(true);
				return next;
			} catch {
				return null;
			}
		})();
		if (range) {
			const container = range.startContainer;
			if (container === this.mirror || this.mirror.contains(container)) {
				const before = doc.createRange();
				try {
					before.selectNodeContents(this.mirror);
					const limit = container.nodeType === Node.TEXT_NODE
						? container.textContent?.length ?? 0
						: container.childNodes.length;
					before.setEnd(container, Math.max(0, Math.min(range.startOffset, limit)));
					return Math.max(0, Math.min(this.ta.value.length, before.toString().length));
				} catch {
					// Fall through to the coarse viewport fallback below.
				}
			}
		}

		const rect = this.mirror.getBoundingClientRect();
		if (clientY <= rect.top && clientX <= rect.left) return 0;
		if (clientY >= rect.bottom || clientX >= rect.right) return this.ta.value.length;
		return null;
	}

	/**
	 * Build the visible text-flow atoms used for drag insertion. The textarea
	 * sits above the mirror and therefore makes caretRangeFromPoint unreliable:
	 * browsers return no caret when the pointer is over the transparent control.
	 * Measuring the mirror's actual text ranges keeps the drop point aligned with
	 * wrapping, CJK text, and inline bubble spans.
	 */
	private textFlowAtoms(): FlowAtom[] {
		const value = this.ta.value;
		// Drag hit-testing runs on every pointermove; per-character Range work
		// is only valid until the mirror layout or the value changes.
		if (this.flowAtomsCache && this.flowAtomsCache.version === this.mirrorVersion && this.flowAtomsCache.value === value) {
			return this.flowAtomsCache.atoms;
		}
		const atoms: FlowAtom[] = [];
		const valueLength = value.length;
		const tokenRanges = new Map<number, [number, number]>();
		for (const [start, end, id] of this.tokenRanges()) tokenRanges.set(id, [start, end]);

		for (const span of Array.from(this.mirror.querySelectorAll<HTMLElement>('.inno-smart-slot-tok'))) {
			const id = Number(span.dataset.slotId);
			const range = tokenRanges.get(id);
			if (!range) continue;
			const rect = span.getBoundingClientRect();
			if (rect.width <= 0 || rect.height <= 0) continue;
			atoms.push({ start: range[0], end: range[1], left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
		}

		let textOffset = 0;
		const visitTextNodes = (parent: Node): void => {
			for (const node of Array.from(parent.childNodes)) {
				if (node.nodeType === Node.TEXT_NODE) {
					const text = node.textContent ?? "";
					const owner = node.parentElement;
					const insideToken = Boolean(owner?.closest('.inno-smart-slot-tok'));
					if (!insideToken) {
						for (let index = 0; index < text.length && textOffset + index < valueLength; index += 1) {
							const range = this.mirror.ownerDocument.createRange();
							try {
								range.setStart(node, index);
								range.setEnd(node, index + 1);
								const rect = Array.from(range.getClientRects?.() ?? []).find((candidate) => candidate.width > 0 && candidate.height > 0);
								if (rect) atoms.push({
									start: textOffset + index,
									end: textOffset + index + 1,
									left: rect.left,
									right: rect.right,
									top: rect.top,
									bottom: rect.bottom,
								});
							} finally {
								range.detach?.();
							}
						}
					}
					textOffset += text.length;
				} else {
					visitTextNodes(node);
				}
			}
		};
		visitTextNodes(this.mirror);
		this.flowAtomsCache = { version: this.mirrorVersion, value, atoms };
		return atoms;
	}

	private moveBubbleToPoint(slot: Slot, clientX: number, clientY: number): boolean {
		const match = tokenRegexFor(slot.id).exec(this.ta.value);
		if (!match) return false;
		const rawOffset = this.textOffsetAtPoint(clientX, clientY);
		if (rawOffset === null) return false;
		const start = match.index;
		const end = start + match[0].length;
		if (rawOffset >= start && rawOffset <= end) return false;
		for (const [tokenStart, tokenEnd, tokenId] of this.tokenRanges()) {
			if (tokenId !== slot.id && rawOffset > tokenStart && rawOffset < tokenEnd) return false;
		}

		const token = match[0];
		const without = this.ta.value.slice(0, start) + this.ta.value.slice(end);
		let insertion = rawOffset;
		if (insertion > end) insertion -= token.length;
		insertion = Math.max(0, Math.min(without.length, insertion));
		const nextValue = without.slice(0, insertion) + token + without.slice(insertion);
		if (nextValue === this.ta.value) return false;
		this.ta.value = nextValue;
		this.sync();
		return true;
	}

	private makeSlotChip(span: HTMLElement, slot: Slot, selected: boolean): HTMLElement {
		const chip = document.createElement("div");
		const isAgent = slot.bubbleType === "agent";
		const displayWord = isAgent ? this.agentDisplayName(slot) : slot.word;
		const agentHint = isAgent ? this.agentBubbleHint(slot.agentCommand ?? slot.word) : "";
		const count = slot.files.length;
		chip.className = `inno-smart-chip ${isAgent ? "is-agent is-filled inno-smart-agent-surface" : count ? "is-filled" : "is-empty"}`;
		if (selected) chip.classList.add("is-selected");
		if (slot._spawn) {
			chip.classList.add("is-spawn");
			slot._spawn = false;
		}
		chip.dataset.slotId = String(slot.id);
		if (count > 0) {
			const fileNames = slot.files.map((file) => file.name).filter(Boolean);
			if (fileNames.length > 0) {
				chip.title = fileNames.join("\n");
				chip.setAttribute("aria-label", `${slot.word}: ${fileNames.join(", ")}`);
			}
		}
		const mergeLabel = this.opts.labels().mergeBubbleHint;
		if (mergeLabel) chip.dataset.mergeLabel = mergeLabel;
		chip.style.setProperty("--smart-bc", isAgent ? "#8b5cf6" : KIND_COLORS[this.kindOfRule(slot.rule)]);
		// The token span reserves the exact inline width. The visible chip follows
		// that span on every sync, so its position always comes from text layout.
		const spanRect = span.getBoundingClientRect();
		const bubbleWidth = Math.max(0, spanRect.width - BUBBLE_SEAM_PX * 2);
		chip.style.left = `${span.offsetLeft + BUBBLE_SEAM_PX}px`;
		chip.style.top = `${span.offsetTop + (span.offsetHeight - 20) / 2}px`;
		chip.style.width = `${bubbleWidth}px`;
		chip.innerHTML = isAgent
			? `${this.agentIconMarkup(slot.agentCommand ?? slot.word)}<span class="inno-smart-chip-word">${this.escape(displayWord)}</span>`
			: `<span class="inno-smart-chip-word">${this.escape(slot.word)}</span>`;
		if (isAgent) {
			if (agentHint) {
				chip.title = agentHint;
			}
			chip.setAttribute("aria-label", agentHint ? `${displayWord}：${agentHint}` : displayWord);
		}

		// Pointer dragging chooses a new caret position in the mirror. The token
		// is moved in the textarea value, then the normal mirror layout rebuilds it.
		chip.addEventListener("pointerdown", (event) => this.beginBubblePointerDrag(slot, event));

		const remove = document.createElement("button");
		remove.type = "button";
		remove.className = "inno-smart-chip-x";
		remove.textContent = "×";
		remove.title = this.opts.labels().removeBubble;
		const cancelBubbleHover = (event: Event) => {
			event.stopPropagation();
			this.opts.callbacks.onBubbleClose?.(slot, chip);
		};
		remove.addEventListener("pointerenter", () => this.opts.callbacks.onBubbleClose?.(slot, chip));
		remove.addEventListener("pointerdown", cancelBubbleHover);
		remove.addEventListener("click", (event) => {
			event.stopPropagation();
			this.removeSlot(slot);
		});
		chip.appendChild(remove);
		chip.addEventListener("contextmenu", (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.opts.callbacks.onBubbleContextMenu(event, slot, chip);
		});

		if (isAgent) {
			chip.addEventListener("click", (event) => {
				if (this.consumeSuppressedBubbleClick(slot.id, event)) return;
				this.opts.callbacks.onAgentBubbleClick?.(slot, chip);
			});
			return chip;
		}

		if (count > 0) {
			const badge = document.createElement("span");
			badge.className = "inno-smart-badge";
			badge.textContent = String(count);
			if (slot._bc !== count) {
				badge.classList.add("is-pop");
				slot._bc = count;
			}
			chip.appendChild(badge);
			chip.addEventListener("click", (event) => {
				if (this.consumeSuppressedBubbleClick(slot.id, event)) return;
				this.opts.callbacks.onOpenStatusPanel(slot, chip);
			});
			// Hover 250ms auto-opens the status panel (prototype parity).
			chip.addEventListener("mouseenter", () => this.opts.callbacks.onChipHover?.(slot, chip, true));
			chip.addEventListener("mouseleave", () => this.opts.callbacks.onChipHover?.(slot, chip, false));
		} else {
			chip.title = this.opts.labels().emptyBubbleTitle;
			chip.addEventListener("click", (event) => {
				if (this.consumeSuppressedBubbleClick(slot.id, event)) return;
				this.opts.callbacks.onOpenFillMenu(slot, chip);
			});
		}
		// Drop-to-bind (+drop-ok/drop-bad feedback).
		let dropOkTimer: number | null = null;
		const clearDropHint = () => {
			if (dropOkTimer !== null) window.clearTimeout(dropOkTimer);
			dropOkTimer = null;
			chip.classList.remove("is-drop-ok", "is-drop-partial", "is-merge-ok");
			this.stopDropStatusFollower(slot.id);
		};
		chip.addEventListener("dragover", (event) => {
			if (!this.opts.data.getSettings().allowDrag) return;
			const meta = this.dragMeta;
			const nativeFiles = Array.from(event.dataTransfer?.files ?? []).map((file): EngineAttachmentItem => ({
				name: file.name,
				path: file.name,
				source: "local",
				file,
			}));
			const transferItems = this.transferAttachmentItems(event.dataTransfer);
			const files = meta && !meta.consumed
				? meta.files
				: meta?.consumed ? nativeFiles : transferItems.length > 0 ? transferItems : nativeFiles;
			if (files.length === 0) return;
			event.preventDefault();
			event.stopPropagation();
			// Drag sources declare `copy`; using the same effect keeps the browser
			// drop-enabled instead of showing a forbidden cursor and suppressing drop.
			event.dataTransfer!.dropEffect = "copy";
			const state = this.dropMatchState(slot, files);
			this.showDropStatus(slot, state);
			if (dropOkTimer !== null) window.clearTimeout(dropOkTimer);
			chip.classList.remove("is-drop-ok", "is-drop-partial");
			if (state === "match") chip.classList.add("is-drop-ok");
			if (state === "partial") chip.classList.add("is-drop-partial");
		});
		chip.addEventListener("dragleave", (event) => {
			if (chip.contains(event.relatedTarget as Node)) return;
			dropOkTimer = window.setTimeout(clearDropHint, 80);
		});
		chip.addEventListener("drop", (event) => {
			const meta = this.dragMeta;
			event.preventDefault();
			event.stopPropagation();
			clearDropHint();
			if (!this.opts.data.getSettings().allowDrag) {
				return;
			}
			// A keyword can become this chip after the drag-dwell conversion. The
			// files are already bound at that point; the actual drop only completes
			// the interaction and must not show another notification.
			if (meta?.consumed) {
				return;
			}
			// A native file drag can contain several files. Prefer that payload
			// over the in-page drag metadata so dropping a multi-selection binds
			// the whole batch instead of only its first file.
			const osFiles = Array.from(event.dataTransfer?.files ?? []);
			if (osFiles.length > 0) {
				this.bindLocalFiles(slot, osFiles);
				return;
			}
			if (meta && !meta.consumed) {
				this.bindAttachmentFiles(slot, meta.files);
				meta.consumed = true;
				return;
			}
			const transferItems = this.transferAttachmentItems(event.dataTransfer);
			if (transferItems.length > 0) {
				this.bindAttachmentFiles(slot, transferItems);
				return;
			}
		});
		return chip;
	}

	// ── slot operations ─────────────────────────────────────────────────────

	private agentDisplayName(slot: Slot): string {
		const command = normalizeAgentCommand(slot.agentCommand ?? slot.word);
		const localized = this.opts.agentCommandLabel?.(command)?.trim();
		if (localized) return localized.replace(/^\/+/, "");
		return command.startsWith("skill:") ? command.slice("skill:".length) : command;
	}

	private agentBubbleHint(commandValue: string): string {
		const command = normalizeAgentCommand(commandValue);
		const labels = this.opts.labels();
		if (command === "recall") return labels.agentCommandRecallHint ?? "";
		if (command === "remember") return labels.agentCommandRememberHint ?? "";
		if (command === "wiki") return labels.agentCommandWikiHint ?? "";
		return "";
	}

	private agentIconMarkup(commandValue: string): string {
		const command = normalizeAgentCommand(commandValue);
		const paths = command.startsWith("skill:")
			? '<path d="m13 2-10 12h9l-1 8 10-12h-9z" />'
			: command === "recall"
				? '<path d="M3 12a9 9 0 1 0 3-7.7" /><path d="M3 4v5h5" />'
				: command === "remember"
					? '<path d="M6 3h12v18l-6-3-6 3V5a2 2 0 0 1 2-2Z" /><path d="M12 8v6M9 11h6" />'
					: command === "wiki"
						? '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" />'
						: '<circle cx="12" cy="12" r="8" />';
		return `<svg class="inno-smart-agent-mark" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
	}

	private createAgentSlot(command: SlashCommandItem | string): Slot {
		const agentCommand = normalizeAgentCommand(command);
		return {
			id: this.nextSlotId++,
			word: `/${agentCommand}`,
			rule: agentRule(agentCommand),
			files: [],
			bubbleType: "agent",
			agentCommand,
		};
	}

	/** Convert a `技能`/`skill` keyword after the user picks a live skill. */
	convertAgentKeywordToBubble(kw: KwRange, command: SlashCommandItem | string): Slot | null {
		if (kw.kind !== "agent" || !this.opts.data.getSettings().allowAgentCommands) return null;
		const previousScrollTop = this.ta.scrollTop;
		if (this.ta.value.slice(kw.start, kw.end) !== kw.word) return null;
		const slot = this.createAgentSlot(command);
		slot._agentSpacer = false;
		this.slots.push(slot);
		const { token } = this.buildToken(slot);
		this.ta.value = this.ta.value.slice(0, kw.start) + token + this.ta.value.slice(kw.end);
		this.ta.setSelectionRange(kw.start + token.length, kw.start + token.length);
		this.ta.focus({ preventScroll: true });
		this.sync();
		this.restoreScrollTop(previousScrollTop);
		return slot;
	}

	/** Replace the current slash-palette draft with one Agent command bubble. */
	insertAgentCommandAsBubble(command: SlashCommandItem | string, start = 0, end = this.ta.value.length): Slot | null {
		if (!this.opts.data.getSettings().enabled || !this.opts.data.getSettings().allowAgentCommands) return null;
		const value = this.ta.value;
		const boundedStart = Math.max(0, Math.min(value.length, start));
		const boundedEnd = Math.max(boundedStart, Math.min(value.length, end));
		const suffixSpace = boundedEnd === value.length && !value.endsWith(" ") ? " " : "";
		const slot = this.createAgentSlot(command);
		slot._agentSpacer = suffixSpace.length > 0;
		this.slots.push(slot);
		const { token } = this.buildToken(slot);
		const inserted = token + suffixSpace;
		this.ta.value = value.slice(0, boundedStart) + inserted + value.slice(boundedEnd);
		const caret = boundedStart + inserted.length;
		this.ta.focus({ preventScroll: true });
		this.ta.setSelectionRange(caret, caret);
		this.sync();
		return slot;
	}

	/** Replace an existing skill bubble while keeping its atomic slot identity. */
	replaceAgentBubbleCommand(slotOrId: Slot | number, command: SlashCommandItem | string): Slot | null {
		if (!this.opts.data.getSettings().enabled || !this.opts.data.getSettings().allowAgentCommands) return null;
		const slot = typeof slotOrId === "number"
			? this.slots.find((entry) => entry.id === slotOrId)
			: slotOrId;
		if (!slot || slot.bubbleType !== "agent") return null;
		const agentCommand = normalizeAgentCommand(command);
		if (!agentCommand) return null;
		const match = tokenRegexFor(slot.id).exec(this.ta.value);
		if (!match) return null;
		const start = match.index;
		const oldEnd = start + match[0].length;
		const value = this.ta.value;
		const selectionStart = this.ta.selectionStart ?? oldEnd;
		const selectionEnd = this.ta.selectionEnd ?? selectionStart;
		slot.agentCommand = agentCommand;
		slot.word = `/${agentCommand}`;
		slot.rule = agentRule(agentCommand);
		const { token } = this.buildToken(slot);
		this.ta.value = value.slice(0, start) + token + value.slice(oldEnd);
		const mapPosition = (position: number): number => {
			if (position <= start) return position;
			if (position >= oldEnd) return position - (oldEnd - start) + token.length;
			return start + token.length;
		};
		this.ta.focus({ preventScroll: true });
		this.ta.setSelectionRange(mapPosition(selectionStart), mapPosition(selectionEnd));
		this.sync();
		return slot;
	}

	toBubble(kw: KwRange): Slot | null {
		if (!this.opts.data.getSettings().enabled || kw.kind === "agent") return null;
		const previousScrollTop = this.ta.scrollTop;
		const slot: Slot = { id: this.nextSlotId++, word: kw.word, rule: kw.rule, files: [] };
		this.slots.push(slot);
		const { token } = this.buildToken(slot);
		this.ta.value = this.ta.value.slice(0, kw.start) + token + this.ta.value.slice(kw.end);
		this.ta.setSelectionRange(kw.start + token.length, kw.start + token.length);
		this.ta.focus({ preventScroll: true });
		this.sync();
		this.restoreScrollTop(previousScrollTop);
		return slot;
	}

	removeSlot(slot: Slot): void {
		const { re } = this.buildToken(slot);
		const value = this.ta.value;
		const match = re.exec(value);
		if (match) {
			const start = match.index;
			const end = start + match[0].length;
			// Agent command bubbles are disposable command tokens. Unlike file
			// keyword bubbles, deleting one must not restore `技能`, `skill`, or
			// the original slash command text.
			const replacement = slot.bubbleType === "agent" ? "" : slot.word;
			const removalEnd = slot.bubbleType === "agent" && slot._agentSpacer && value[end] === " " ? end + 1 : end;
			const nextValue = value.slice(0, start) + replacement + value.slice(removalEnd);
			const mapPosition = (position: number): number => {
				if (position <= start) return position;
				if (position >= removalEnd) return position - (removalEnd - start) + replacement.length;
				return start + replacement.length;
			};
			const selectionStart = this.ta.selectionStart ?? removalEnd;
			const selectionEnd = this.ta.selectionEnd ?? selectionStart;
			this.ta.value = nextValue;
			this.ta.focus();
			this.ta.setSelectionRange(mapPosition(selectionStart), mapPosition(selectionEnd));
		}
		this.returnFilesToAttachments(slot);
		this.slots = this.slots.filter((entry) => entry.id !== slot.id);
		this.ta.focus();
		this.sync();
	}

	/**
	 * Fuse one bubble into another. The target keeps its position and keyword;
	 * all unique source files move with it, and the source token is removed from
	 * the draft. This is intentionally explicit (dragging onto a target), so
	 * merely typing two same-format keywords never changes the user's text.
	 */
	mergeSlots(source: Slot, target: Slot): boolean {
		if (!this.canMergeSlots(source, target)) return false;
		const sourceMatch = tokenRegexFor(source.id).exec(this.ta.value);
		const targetMatch = tokenRegexFor(target.id).exec(this.ta.value);
		if (!sourceMatch || !targetMatch) return false;

		const existing = new Set(target.files.map((file) => `${file.name}\u0000${file.path}`));
		for (const file of source.files) {
			const key = `${file.name}\u0000${file.path}`;
			if (!existing.has(key)) {
				target.files.push(file);
				existing.add(key);
			}
		}
		source.files = [];

		const start = sourceMatch.index;
		const end = start + sourceMatch[0].length;
		const value = this.ta.value;
		const selectionStart = this.ta.selectionStart ?? end;
		const selectionEnd = this.ta.selectionEnd ?? selectionStart;
		const mapPosition = (position: number): number => {
			if (position <= start) return position;
			if (position >= end) return position - (end - start);
			return start;
		};
		this.ta.value = value.slice(0, start) + value.slice(end);
		this.slots = this.slots.filter((slot) => slot.id !== source.id);
		this.ta.focus();
		this.ta.setSelectionRange(
			Math.max(0, Math.min(this.ta.value.length, mapPosition(selectionStart))),
			Math.max(0, Math.min(this.ta.value.length, mapPosition(selectionEnd))),
		);
		this.sync();
		return true;
	}

	private returnFilesToAttachments(slot: Slot): void {
		for (const file of slot.files) {
			this.opts.data.returnAttachment(
				file.source === "workspace"
					? { name: file.name, path: file.path, source: "workspace" }
					: { name: file.name, path: file.path, source: "local", file: file.file },
			);
		}
	}

	unbindAll(slot: Slot): void {
		this.returnFilesToAttachments(slot);
		slot.files = [];
		this.sync();
	}

	/** Bind one file (workspace row item or staged OS file) to a slot. */
	bindFileToSlot(slot: Slot, item: EngineAttachmentItem): void {
		if (slot.files.some((file) => file.path === item.path && file.name === item.name)) {
			return;
		}
		if (!this.ruleAccepts(slot.rule, item.name)) {
			this.markDropBad(slot);
			return;
		}
		// A staged attachment dragged onto a bubble has moved from the loose
		// attachment row into the bubble binding. Workspace-row files are not in
		// that row, so takeAttachment simply returns undefined for them.
		const staged = this.opts.data.takeAttachment(item.path) ?? item;
		slot.files.push({
			uid: this.nextFileId++,
			name: staged.name,
			path: staged.path,
			source: staged.source === "workspace" ? "workspace" : "upload",
			state: staged.source === "workspace" ? "workspace" : "local",
			pct: staged.source === "workspace" ? 100 : 0,
			file: staged.file,
		});
		this.sync();
	}

	/** Bind an existing workspace file by path (fill menu / linkage pick). */
	bindWorkspaceFile(slot: Slot, path: string): void {
		const name = path.split("/").pop() ?? path;
		this.bindFileToSlot(slot, { name, path, source: "workspace" });
	}

	/**
	 * Bind every file from one native drop. Files that do not match the bubble
	 * rule stay visible in the loose attachment row so a mixed-format drop never
	 * loses the rejected files.
	 */
	bindLocalFiles(slot: Slot, files: File[]): void {
		const oversized = getOversizedFiles(files);
		if (oversized.length > 0) this.opts.callbacks.onUploadLimitExceeded?.(oversized.length);
		this.bindAttachmentFiles(slot, files.filter((file) => !oversized.includes(file)).map((file) => this.localAttachmentItem(file)));
	}

	/** Bind a mixed in-page batch, returning mismatches to the loose row. */
	private bindAttachmentFiles(slot: Slot, items: EngineAttachmentItem[]): { accepted: number; rejected: number } {
		let accepted = 0;
		let rejected = 0;
		for (const item of items) {
			if (!this.ruleAccepts(slot.rule, item.name)) {
				this.markDropBad(slot);
				this.opts.data.returnAttachment(item);
				rejected++;
				continue;
			}
			this.bindFileToSlot(slot, item);
			accepted++;
		}
		return { accepted, rejected };
	}

	private localAttachmentItem(file: File): EngineAttachmentItem {
		return {
			name: file.name,
			path: file.name.replace(/[\\/?%*:|"<>]/g, "_").trim() || `upload-${Date.now()}`,
			source: "local",
			file,
		};
	}

	private markDropBad(slot: Slot): void {
		const chip = this.hit.querySelector<HTMLElement>(`.inno-smart-chip[data-slot-id="${slot.id}"]`);
		if (!chip) return;
		chip.classList.add("is-drop-bad");
		window.setTimeout(() => chip.classList.remove("is-drop-bad"), 600);
	}

	removeBinding(slot: Slot, uid: number): void {
		const file = slot.files.find((entry) => entry.uid === uid);
		slot.files = slot.files.filter((entry) => entry.uid !== uid);
		if (file) {
			this.opts.data.returnAttachment(
				file.source === "workspace"
					? { name: file.name, path: file.path, source: "workspace" }
					: { name: file.name, path: file.path, source: "local", file: file.file },
			);
		}
		this.sync();
	}

	/**
	 * Insert an attachment as a pre-bound bubble at the caret. The bubble's
	 * word comes from a matching preset when one exists; otherwise it uses the
	 * first enabled user rule whose extensions accept the file.
	 */
	insertAttachmentAsBubble(item: EngineAttachmentItem): void {
		const rule = this.ruleForAttachment(item.name);
		if (!rule) {
			return;
		}
		const word = rule.keyword;
		const slot: Slot = { id: this.nextSlotId++, word, rule, files: [] };
		this.slots.push(slot);
		slot.files.push({
			uid: this.nextFileId++,
			name: item.name,
			path: item.path,
			source: item.source === "workspace" ? "workspace" : "upload",
			state: item.source === "workspace" ? "workspace" : "local",
			pct: item.source === "workspace" ? 100 : 0,
			file: item.file,
		});
		const caret = this.ta.selectionStart ?? this.ta.value.length;
		const { token } = this.buildToken(slot);
		this.ta.value = this.ta.value.slice(0, caret) + token + this.ta.value.slice(caret);
		this.ta.focus();
		this.ta.setSelectionRange(caret + token.length, caret + token.length);
		this.sync();
	}

	/**
	 * Rehydrate persisted file bindings after a user message enters edit mode.
	 * The session stores the visible text and attachment metadata separately;
	 * this puts the metadata back into atomic bubbles at the recorded word
	 * occurrences so the next send produces the same structured payload.
	 * Bindings whose word no longer exists are returned for the loose row.
	 */
	restoreBindings(bindings: AttachmentBinding[]): AttachmentRef[] {
		if (bindings.length === 0) return [];

		// Editing normally starts from a plain value, but clear any in-progress
		// bubbles as a safety net when the user edits while a draft is present.
		if (this.slots.length > 0) {
			this.restoreAllTokens();
			for (const slot of this.slots) this.returnFilesToAttachments(slot);
			this.slots = [];
		}

		const value = this.ta.value;
		const findOccurrence = (needle: string, occurrence: number): number => {
			if (!needle) return -1;
			const target = Math.max(0, Math.floor(occurrence));
			let from = 0;
			for (let index = 0; index <= target; index++) {
				const found = value.indexOf(needle, from);
				if (found === -1) return -1;
				if (index === target) return found;
				from = found + needle.length;
			}
			return -1;
		};

		const placements: Array<{ start: number; end: number; binding: AttachmentBinding }> = [];
		const unplaced: AttachmentRef[] = [];
		for (const binding of bindings) {
			const start = findOccurrence(binding.word, binding.wordIndex);
			if (start === -1 || binding.files.length === 0) {
				unplaced.push(...binding.files);
				continue;
			}
			placements.push({ start, end: start + binding.word.length, binding });
		}
		placements.sort((a, b) => a.start - b.start || a.end - b.end);

		const ruleFor = (word: string): SmartInputRule => this.opts.data.getRules().find((rule) => rule.keyword === word) ?? ({
			id: `restored-${word}`,
			isPreset: false,
			keyword: word,
			extensions: [],
			allExtensions: true,
			excludeExtensions: [],
			enabled: true,
		} satisfies SmartInputRule);
		const fileName = (path: string): string => path.split("/").pop() ?? path;

		let nextValue = "";
		let cursor = 0;
		for (const placement of placements) {
			if (placement.start < cursor) {
				unplaced.push(...placement.binding.files);
				continue;
			}
			nextValue += value.slice(cursor, placement.start);
			const slot: Slot = {
				id: this.nextSlotId++,
				word: placement.binding.word,
				rule: ruleFor(placement.binding.word),
				files: [],
			};
			for (const file of placement.binding.files) {
				slot.files.push({
					uid: this.nextFileId++,
					name: fileName(file.path),
					path: file.path,
					source: "workspace",
					state: "workspace",
					pct: 100,
				});
			}
			this.slots.push(slot);
			nextValue += this.buildToken(slot).token;
			cursor = placement.end;
		}
		nextValue += value.slice(cursor);
		this.ta.value = nextValue;
		this.ta.focus({ preventScroll: true });
		this.ta.setSelectionRange(nextValue.length, nextValue.length);
		this.sync();
		return unplaced;
	}

	// ── token atomicity ─────────────────────────────────────────────────────

	private tokenRanges(): Array<[number, number, number]> {
		const out: Array<[number, number, number]> = [];
		TOKEN_RE.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = TOKEN_RE.exec(this.ta.value))) {
			out.push([match.index, match.index + match[0].length, match[1].codePointAt(0)! - 0xE000]);
		}
		return out;
	}

	private deleteTokenSelection(selectionStart: number, selectionEnd: number, touched: Array<[number, number, number]>): void {
		const intervals = [
			[selectionStart, selectionEnd] as [number, number],
			...touched.map(([start, end]) => [start, end] as [number, number]),
		].sort((a, b) => a[0] - b[0]);
		const merged: Array<[number, number]> = [];
		for (const [start, end] of intervals) {
			const previous = merged[merged.length - 1];
			if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
			else merged.push([start, end]);
		}

		const value = this.ta.value;
		let nextValue = "";
		let cursor = 0;
		for (const [start, end] of merged) {
			nextValue += value.slice(cursor, start);
			cursor = end;
		}
		nextValue += value.slice(cursor);
		const removedIds = new Set(touched.map(([, , id]) => id));
		for (const slot of this.slots) {
			if (removedIds.has(slot.id)) this.returnFilesToAttachments(slot);
		}
		this.slots = this.slots.filter((slot) => !removedIds.has(slot.id));
		this.ta.value = nextValue;
		this.ta.focus();
		const caret = merged[0]?.[0] ?? selectionStart;
		this.ta.setSelectionRange(Math.min(caret, nextValue.length), Math.min(caret, nextValue.length));
		this.sync();
	}

	private handleBeforeInput = (event: InputEvent): void => {
		if (event.isComposing || !event.inputType.startsWith("delete")) return;
		const selectionStart = this.ta.selectionStart ?? 0;
		const selectionEnd = this.ta.selectionEnd ?? selectionStart;
		const touched = this.tokenRanges().filter(([start, end]) => {
			if (selectionStart !== selectionEnd) return selectionStart < end && selectionEnd > start;
			if (event.inputType.toLowerCase().includes("forward")) return selectionStart >= start && selectionStart < end;
			return selectionStart > start && selectionStart <= end;
		});
		if (touched.length === 0) return;

		event.preventDefault();
		if (selectionStart === selectionEnd && touched.length === 1) {
			this.removeSlotById(touched[0][2]);
			return;
		}
		this.deleteTokenSelection(selectionStart, selectionEnd, touched);
	};

	private handleKeyDown = (event: KeyboardEvent): void => {
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		if (event.isComposing || event.keyCode === 229) return;
		const selectionStart = this.ta.selectionStart ?? 0;
		const selectionEnd = this.ta.selectionEnd ?? selectionStart;
		const ranges = this.tokenRanges();
		if (selectionStart !== selectionEnd) {
			if (event.key === "Backspace" || event.key === "Delete") {
				const touched = ranges.filter(([start, end]) => selectionStart < end && selectionEnd > start);
				if (touched.length > 0) {
					event.preventDefault();
					this.deleteTokenSelection(selectionStart, selectionEnd, touched);
				}
			}
			return;
		}
		const pos = selectionStart;
		if (event.key === "ArrowLeft") {
			for (const [start, end] of ranges) {
				if (pos === end || (pos > start && pos < end)) {
					event.preventDefault();
					this.ta.setSelectionRange(start, start);
					return;
				}
			}
		} else if (event.key === "ArrowRight") {
			for (const [start, end] of ranges) {
				if (pos === start || (pos > start && pos < end)) {
					event.preventDefault();
					this.ta.setSelectionRange(end, end);
					return;
				}
			}
		} else if (event.key === "Backspace") {
			for (const [start, end, id] of ranges) {
				if (pos > start && pos <= end) {
					event.preventDefault();
					this.removeSlotById(id);
					return;
				}
			}
		} else if (event.key === "Delete") {
			for (const [start, end, id] of ranges) {
				if (pos === start || (pos > start && pos < end)) {
					event.preventDefault();
					this.removeSlotById(id);
					return;
				}
			}
		}
	};

	removeSlotById(id: number): void {
		const slot = this.slots.find((entry) => entry.id === id);
		if (slot) this.removeSlot(slot);
	}

	private snapCaretOut = (): void => {
		if (this.ta.selectionStart !== this.ta.selectionEnd) return;
		const pos = this.ta.selectionStart;
		for (const [start, end] of this.tokenRanges()) {
			if (pos > start && pos < end) {
				const target = pos <= (start + end) / 2 ? start : end;
				this.ta.setSelectionRange(target, target);
				return;
			}
		}
	};

	private handleMouseDown = (event: MouseEvent): void => {
		const mirrorRect = this.mirror.getBoundingClientRect();
		const x = event.clientX - mirrorRect.left;
		for (const rect of this.tokRects) {
			let target: number | null = null;
			if (x < rect.x0 && rect.x0 - x <= BUBBLE_SEAM_PX) target = rect.start;
			else if (x > rect.x1 && x - rect.x1 <= BUBBLE_SEAM_PX) target = rect.end;
			if (target !== null) {
				requestAnimationFrame(() => this.ta.setSelectionRange(target, target));
				return;
			}
		}
	};

	cancelBubbleDrag(): void {
		this.dragMeta = null;
		this.stopDwellFollower();
		this.removeDragFollower();
		document.body.classList.remove("inno-smart-dragging", "inno-smart-drag-consumed");
		this.hit.querySelectorAll(".inno-smart-chip.is-drag-match, .inno-smart-chip.is-merge-ok").forEach((el) => el.classList.remove("is-drag-match", "is-merge-ok"));
	}

	markDragStart(items: EngineAttachmentItem | EngineAttachmentItem[], raw: string): void {
		const files = Array.isArray(items) ? items : [items];
		if (files.length === 0) return;
		this.removeDragFollower();
		this.dragMeta = { raw, files };
		document.body.classList.remove("inno-smart-drag-consumed");
		document.body.classList.add("inno-smart-dragging");
		for (const chip of Array.from(this.hit.querySelectorAll<HTMLElement>(".inno-smart-chip"))) {
			const slot = this.slots.find((entry) => entry.id === Number(chip.dataset.slotId));
			// Agent bubbles are command selectors, not file-drop targets. Their
			// synthetic all-format rule would otherwise make them look like a
			// matching file bubble and trigger the drag breathing animation.
			if (slot?.bubbleType !== "agent" && slot && files.some((file) => this.ruleAccepts(slot.rule, file.name))) {
				chip.classList.add("is-drag-match");
			}
		}
	}

	// ── outgoing pipeline ───────────────────────────────────────────────────

	/** Slots as the pure builder expects them. */
	private outgoingSlots(): Map<number, { word: string; files: OutgoingFile[] }> {
		const map = new Map<number, { word: string; files: OutgoingFile[] }>();
		for (const slot of this.slots) {
			map.set(slot.id, {
				word: slot.word,
				files: slot.files.map((file) => ({
					uid: file.uid,
					name: file.name,
					path: file.path,
					state: file.state,
					file: file.file,
				})),
			});
		}
		return map;
	}

	buildOutgoing() {
		return buildOutgoingPure(this.ta.value, this.outgoingSlots());
	}

	setUploadProgress(uid: number, pct: number): void {
		for (const slot of this.slots) {
			const file = slot.files.find((entry) => entry.uid === uid);
			if (file) {
				file.state = "uploading";
				file.pct = pct;
				this.notifyPanelRefresh();
				return;
			}
		}
	}

	completeUpload(uid: number, uploadedPath: string): void {
		for (const slot of this.slots) {
			const file = slot.files.find((entry) => entry.uid === uid);
			if (file) {
				file.state = "workspace";
				file.pct = 100;
				file.path = uploadedPath;
				this.sync();
				return;
			}
		}
	}

	failUpload(uid: number): void {
		for (const slot of this.slots) {
			const file = slot.files.find((entry) => entry.uid === uid);
			if (file) {
				file.state = "failed";
				file.pct = 0;
				this.notifyPanelRefresh();
				return;
			}
		}
	}

	retryUpload(uid: number): void {
		for (const slot of this.slots) {
			const file = slot.files.find((entry) => entry.uid === uid);
			if (file && file.state === "failed" && file.file) {
				file.state = "local";
				file.pct = 0;
				this.sync();
				return;
			}
		}
	}

	private notifyPanelRefresh(): void {
		// Cheap re-render trigger — panels read slot.files fresh each render,
		// so a plain change event keeps progress rings live without a
		// full hit-layer rebuild.
		this.opts.callbacks.onChange();
	}

	/**
	 * Post-send cleanup: sent content is gone; files that could not ship
	 * (failed/staged uploads) flow back to the attachment row so the user can
	 * retry them with the next message.
	 */
	postSendCleanup(): void {
		for (const slot of this.slots) {
			for (const file of slot.files) {
				if (file.state === "workspace") continue;
				this.opts.data.returnAttachment(
					file.source === "workspace"
						? { name: file.name, path: file.path, source: "workspace" }
						: { name: file.name, path: file.path, source: "local", file: file.file },
				);
			}
		}
		this.slots = [];
		this.sync();
	}

	restoreAllTokens(): void {
		let value = this.ta.value;
		for (const slot of this.slots) {
			value = value.replace(tokenRegexFor(slot.id), slot.word);
		}
		this.ta.value = value;
	}

	/** Final bindings after uploads resolved (call once per send). */
	finalizeBindings(
		ready: Array<{ word: string; wordIndex: number; files: Array<{ uid: number; name: string; path: string }> }>,
		uploaded: Array<{ word: string; wordIndex: number; uid: number; path: string }>,
	): AttachmentBinding[] {
		const byKey = new Map<string, AttachmentBinding>();
		const keyOf = (word: string, wordIndex: number) => `${word}#${wordIndex}`;
		for (const binding of ready) {
			byKey.set(keyOf(binding.word, binding.wordIndex), {
				word: binding.word,
				wordIndex: binding.wordIndex,
				files: binding.files.map((file) => ({ path: file.path, kind: kindFromName(file.path), source: "workspace" as const })),
			});
		}
		for (const upload of uploaded) {
			const key = keyOf(upload.word, upload.wordIndex);
			const existing = byKey.get(key);
			const ref = { path: upload.path, kind: kindFromName(upload.path), source: "upload" as const };
			if (existing) existing.files.push(ref);
			else byKey.set(key, { word: upload.word, wordIndex: upload.wordIndex, files: [ref] });
		}
		return Array.from(byKey.values());
	}
}
