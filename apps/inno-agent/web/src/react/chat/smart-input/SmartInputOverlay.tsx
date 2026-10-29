import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Check, ListChecks, Plus, RotateCcw, X, Zap } from "lucide-react";
import type { EngineAttachmentItem, SmartInputEngine } from "./engine.js";
import type { SlashCommandItem } from "../../../api/commands.js";
import type { KwRange } from "./rules.js";
import { KIND_LABEL_KEYS, kindFromName, kindFromRule, nameMatchesRule } from "./kinds.js";
import type { PendingUpload } from "../composer-utils.js";
import { FileName } from "../../FileName.js";
import { FileTypeIcon } from "../../FileTypeIcon.js";
import {
	ContextMenu,
	type ContextMenuItem,
	MenuOption,
	PopoverSurface,
	Tooltip,
} from "../../ui/index.js";
import { useTitleMarquee } from "../../hooks.js";

/**
 * Floating panels for the smart-input composer: status panel (bound files,
 * live upload progress, retry), fill menu (workspace picker + batch
 * multi-select) and the bubble context menu. Portal-rendered and clamped to
 * the viewport; behavior ports the v76 prototype (hover 250ms open, 260ms
 * auto-close, pin-on-interact, >25px real move to unpin).
 */

export interface SmartPanelState {
	kind: "status" | "fill" | "menu" | "agent";
	slotId?: number;
	anchor: { left: number; bottom: number };
	/** Keyword range that opened an Agent/skill picker. */
	agentKeyword?: KwRange;
	/** Context-menu coordinates (kind === "menu"). */
	x?: number;
	y?: number;
}

interface SmartInputOverlayProps {
	engine: SmartInputEngine | null;
	panel: SmartPanelState | null;
	onClose: () => void;
	onOpenPanel: (panel: SmartPanelState) => void;
	workspaceFiles: Array<{ name: string; path: string }>;
	workspaceFilesLoading: boolean;
	attachments: PendingUpload[];
	takeAttachment: (path: string) => EngineAttachmentItem | undefined;
	onWorkspaceHighlight: (paths: string[] | null) => void;
	/** Increments when bound files change without changing the slot count. */
	refreshKey: number;
	onOpenFilePreview: (path: string) => void;
	agentCommands: SlashCommandItem[];
	onSelectAgentCommand: (command: SlashCommandItem) => void;
	onOpenSkillPanel: (skillName: string) => void;
}

const AUTO_CLOSE_MS = 260;
const UNPIN_MOVE_PX = 25;
type SkillTitleMarqueeState = ReturnType<typeof useTitleMarquee<HTMLSpanElement>>;

function SkillNameMarquee({ name, titleState }: { name: string; titleState: SkillTitleMarqueeState }) {
	const {
		titleViewportRef,
		titleMeasureRef,
		titleOverflowing,
		marqueeActive,
		marqueeShift,
		titleMarqueeDuration,
	} = titleState;

	return (
		<Tooltip label={name}>
		<span ref={titleViewportRef} className="inno-smart-agent-skill-title">
			<span
				className={`inno-sidebar-title ${marqueeActive ? "inno-sidebar-title-marquee" : "block overflow-hidden whitespace-nowrap"}${titleOverflowing ? " inno-sidebar-title-fade" : ""} font-medium text-[var(--inno-text)]`}
				style={marqueeActive ? ({
					"--inno-title-shift": `-${marqueeShift}px`,
					"--inno-title-duration": `${titleMarqueeDuration}s`,
				} as CSSProperties) : undefined}
			>
				{name}
				{titleOverflowing ? <span aria-hidden="true" className="inno-sidebar-title-marquee-tail" /> : null}
			</span>
			<span ref={titleMeasureRef} aria-hidden="true" className="inno-sidebar-title pointer-events-none invisible absolute left-0 top-0 -z-10 w-max whitespace-nowrap font-medium">
				{name}
			</span>
		</span>
		</Tooltip>
	);
}

function AgentSkillOption({ command, onSelect }: { command: SlashCommandItem; onSelect: (command: SlashCommandItem) => void }) {
	const [hovered, setHovered] = useState(false);
	const skillName = command.name.startsWith("skill:") ? command.name.slice("skill:".length) : command.name;
	const titleState = useTitleMarquee<HTMLSpanElement>(skillName, hovered);

	return (
		<MenuOption
			className="inno-smart-panel-row inno-smart-panel-pick"
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
			onClick={() => onSelect(command)}
		>
			<Zap size={14} className="shrink-0 text-[var(--inno-accent)]" aria-hidden="true" />
			<SkillNameMarquee name={skillName} titleState={titleState} />
			{command.description ? <Tooltip label={command.description}><span className="inno-smart-agent-description">{command.description}</span></Tooltip> : null}
		</MenuOption>
	);
}

function rectOf(el: HTMLElement): SmartPanelState["anchor"] {
	const rect = el.getBoundingClientRect();
	return { left: rect.left, bottom: rect.bottom };
}

function chipFor(slotId: number): HTMLElement | null {
	const chips = Array.from(document.querySelectorAll<HTMLElement>(`.inno-smart-chip[data-slot-id="${slotId}"]`));
	return chips.find((chip) => {
		const rect = chip.getBoundingClientRect();
		return rect.width > 0 && rect.height > 0;
	}) ?? null;
}

function agentKeywordFor(keyword: KwRange | undefined): HTMLElement | null {
	if (!keyword) return null;
	return document.querySelector<HTMLElement>(
		`.inno-smart-kw-hit[data-smart-kw-start="${keyword.start}"][data-smart-kw-end="${keyword.end}"]`,
	);
}

function panelAnchor(panel: SmartPanelState): HTMLElement | null {
	if (panel.kind === "agent") {
		return panel.slotId !== undefined ? chipFor(panel.slotId) : agentKeywordFor(panel.agentKeyword);
	}
	return panel.slotId !== undefined ? chipFor(panel.slotId) : null;
}

export function SmartInputOverlay({ engine, panel, onClose, onOpenPanel, workspaceFiles, workspaceFilesLoading, attachments, takeAttachment, onWorkspaceHighlight, refreshKey, onOpenFilePreview, agentCommands, onSelectAgentCommand, onOpenSkillPanel }: SmartInputOverlayProps) {
	const { t } = useTranslation();
	const panelRef = useRef<HTMLDivElement | null>(null);
	const closeTimer = useRef<number | null>(null);
	const pinned = useRef(false);
	const pinPos = useRef({ x: 0, y: 0 });
	const menuNextPanel = useRef<SmartPanelState | null>(null);
	const [multiSelect, setMultiSelect] = useState(false);
	const [picked, setPicked] = useState<Map<string, string>>(new Map());

	const slot = panel && panel.kind !== "agent" && panel.slotId !== undefined
		? engine?.slots.find((entry) => entry.id === panel.slotId) ?? null
		: null;
	const boundFileCount = slot?.files.length ?? 0;

	const cancelClose = useCallback(() => {
		if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
		closeTimer.current = null;
	}, []);

	const scheduleClose = useCallback(() => {
		cancelClose();
		closeTimer.current = window.setTimeout(() => {
			if (pinned.current) {
				scheduleClose();
				return;
			}
			const el = panelRef.current;
			if (el && (el.matches(":hover") || document.querySelector(".inno-smart-chip:hover"))) {
				scheduleClose();
				return;
			}
			onClose();
		}, AUTO_CLOSE_MS);
	}, [cancelClose, onClose]);

	const pin = useCallback((event: { clientX: number; clientY: number }) => {
		pinned.current = true;
		pinPos.current = { x: event.clientX, y: event.clientY };
	}, []);

	// Clamp after layout so measurements are real. Re-read the currently visible
	// chip instead of trusting a stale zero-sized anchor from a remounted input.
	const repositionPanel = useCallback(() => {
		if (!panel || panel.kind === "menu" || !panelRef.current) return;
		cancelClose();
		const el = panelRef.current;
		const anchor = panelAnchor(panel);
		const chipRect = anchor?.getBoundingClientRect();
		// No visible chip (engine is mid-sync rebuilding the hit layer): keep the
		// panel where it is instead of snapping to the stale open-time anchor.
		if (!chipRect) return;
		const desiredLeft = chipRect.left;
		const desiredTop = chipRect.bottom + 4;
		const width = el.offsetWidth;
		const height = el.offsetHeight;
		el.style.left = `${Math.max(8, Math.min(desiredLeft, window.innerWidth - width - 8))}px`;
		el.style.top = `${Math.max(8, Math.min(desiredTop, window.innerHeight - height - 8))}px`;
	}, [cancelClose, panel?.agentKeyword, panel?.kind, panel?.slotId]);

	// The attachment row can wrap to another line without changing the panel
	// state. Observe the actual composer and chip geometry so the portal follows
	// the bubble after that layout shift, not only after a file-count change.
	// ResizeObserver already batches callbacks before paint, so measurements
	// here are real — no extra rAF deferral is needed.
	useLayoutEffect(() => {
		if (!panel || panel.kind === "menu" || !panelRef.current) return;
		repositionPanel();

		const chip = panelAnchor(panel);
		const composer = chip?.closest<HTMLElement>(".inno-composer")
			?? document.querySelector<HTMLElement>(".inno-composer");
		const attachments = composer?.querySelector<HTMLElement>(".inno-composer-attachments");
		const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(repositionPanel);
		const observed = new Set<Element>();
		for (const target of [panelRef.current, chip, composer, attachments]) {
			if (!target || observed.has(target)) continue;
			observed.add(target);
			resizeObserver?.observe(target);
		}
		window.addEventListener("resize", repositionPanel);
		return () => {
			resizeObserver?.disconnect();
			window.removeEventListener("resize", repositionPanel);
		};
	}, [boundFileCount, engine, panel, refreshKey, repositionPanel]);

	// Reset transient state when the panel closes.
	useEffect(() => {
		if (panel) return;
		pinned.current = false;
		setMultiSelect(false);
		setPicked(new Map());
		onWorkspaceHighlight(null);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [panel]);

	// Outside click / capture scroll / ESC close.
	useEffect(() => {
		if (!panel || panel.kind === "menu") return;
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Node;
			if (target.isConnected === false) return;
			if (panelRef.current?.contains(target)) return;
			if ((target as HTMLElement).closest?.(".inno-smart-chip, .inno-smart-kw-hit")) return;
			onClose();
		};
		const onScroll = (event: Event) => {
			// Scrolling the file list is an in-panel interaction. Only scrolling
			// the surrounding page should dismiss the floating panel.
			if (panelRef.current?.contains(event.target as Node)) return;
			onClose();
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		const onMouseMove = (event: MouseEvent) => {
			if (!pinned.current || !panelRef.current) return;
			if (Math.hypot(event.clientX - pinPos.current.x, event.clientY - pinPos.current.y) < UNPIN_MOVE_PX) return;
			const target = event.target as Node;
			if (panelRef.current.contains(target) || (target as HTMLElement).closest?.(".inno-smart-chip")) return;
			pinned.current = false;
			scheduleClose();
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("scroll", onScroll, true);
		window.addEventListener("keydown", onKey);
		document.addEventListener("mousemove", onMouseMove);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("keydown", onKey);
			document.removeEventListener("mousemove", onMouseMove);
		};
	}, [panel, onClose, scheduleClose]);

	useEffect(() => () => {
		if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
	}, []);

	if (!panel || !engine) return null;

	const renderAgentPicker = () => {
		const skills = agentCommands.filter((command) => command.source === "skill");
		return (
			<PopoverSurface
				ref={panelRef}
				className="inno-smart-panel inno-smart-panel--agent"
				onMouseEnter={cancelClose}
				onMouseLeave={scheduleClose}
				style={{ left: panel.anchor.left, top: panel.anchor.bottom + 4 }}
			>
				<div className="inno-smart-fill-head">
					<div className="inno-smart-panel-title">
						{t(panel.slotId !== undefined ? "chat.smartInput.switchSkillTitle" : "chat.smartInput.chooseSkillTitle", panel.slotId !== undefined ? "切换技能" : "选择技能")}
					</div>
				</div>
				{skills.length === 0 ? (
					<div className="inno-smart-panel-empty">{t("chat.smartInput.chooseSkillEmpty", "暂无已加载的技能")}</div>
				) : (
					<div className="inno-smart-panel-list inno-smart-agent-list">
						{skills.map((command) => (
							<AgentSkillOption
								key={command.name}
								command={command}
								onSelect={(selected) => {
									onSelectAgentCommand(selected);
									onClose();
								}}
							/>
						))}
					</div>
				)}
			</PopoverSurface>
		);
	};

	if (panel.kind === "agent") return createPortal(renderAgentPicker(), document.body);
	if (!slot) return null;

	const primaryKind = kindFromRule(slot.rule);
	const kindLabel = t(KIND_LABEL_KEYS[primaryKind]);
	const pickFileTitle = primaryKind === "file"
		? t("chat.smartInput.pickGenericFileTitle", "选择「{{kind}}」文件（工作区）", { kind: kindLabel })
		: t("chat.smartInput.pickFileTitle", "选择{{kind}}文件（工作区）", { kind: kindLabel });
	const ruleAccepts = (name: string) => nameMatchesRule(name, slot.rule);
	const acceptedTypeLabel = (() => {
		const normalizeExtension = (value: string): string => {
			const normalized = value.trim().toLowerCase();
			if (!normalized) return "";
			return normalized.startsWith(".") ? normalized : `.${normalized}`;
		};
		const excluded = new Set((slot.rule.excludeExtensions ?? []).map(normalizeExtension).filter(Boolean));
		if (slot.rule.allExtensions) {
			const excludedLabel = Array.from(excluded).join("、");
			return excludedLabel
				? `${t("chat.smartInput.allFileTypes", "所有文件类型")}（${t("chat.smartInput.excludedFileTypes", "排除 {{types}}", { types: excludedLabel })}）`
				: t("chat.smartInput.allFileTypes", "所有文件类型");
		}
		const extensions = Array.from(new Set((slot.rule.extensions ?? []).map(normalizeExtension).filter(Boolean)))
			.filter((extension) => !excluded.has(extension));
		return extensions.length > 0
			? extensions.join("、")
			: t("chat.smartInput.noAcceptedFileTypes", "无");
	})();
	const statusColumnCount = Math.min(2, Math.max(1, slot.files.length));

	const panelFor = (kind: "status" | "fill"): SmartPanelState | null => {
		const chip = chipFor(slot.id);
		return chip ? { kind, slotId: slot.id, anchor: rectOf(chip) } : null;
	};
	const openStatus = () => {
		const next = panelFor("status");
		if (next) onOpenPanel(next);
	};
	const openFill = () => {
		const next = panelFor("fill");
		if (next) onOpenPanel(next);
	};
	const switchPanel = (kind: "status" | "fill") => {
		menuNextPanel.current = panelFor(kind);
	};

	const sourceLabel = (file: SmartInputEngine["slots"][number]["files"][number]) => {
		if (file.source === "workspace") return t("chat.smartInput.sourceWorkspace", "工作区");
		if (file.state === "failed") return t("chat.smartInput.uploadFailed", "失败");
		return t("chat.smartInput.sourceUpload", "本地");
	};

	const boundPaths = new Set(slot.files.map((file) => file.path));
	const attachedCandidates = attachments
		.filter((item) => ruleAccepts(item.fileName) && !boundPaths.has(item.path))
		.map((item) => ({ name: item.fileName, path: item.path, source: "attach" as const }));
	const attachedPaths = new Set(attachedCandidates.map((file) => file.path));
	const fillCandidates = [
		...workspaceFiles
			.filter((file) => ruleAccepts(file.name) && !boundPaths.has(file.path) && !attachedPaths.has(file.path))
			.map((file) => ({ name: file.name, path: file.path, source: "workspace" as const })),
		...attachedCandidates,
	];

	const bindCandidate = (candidate: { name: string; path: string; source: string }) => {
		if (candidate.source === "attach") {
			const item = takeAttachment(candidate.path);
			if (item) engine.bindFileToSlot(slot, item);
		} else {
			engine.bindWorkspaceFile(slot, candidate.path);
		}
	};

	const renderProgress = (file: SlotFile) => {
		if (file.state !== "failed") return null;
		return (
			<Tooltip label={t("chat.smartInput.retryUpload", "重试上传")}>
				<button type="button" className="inno-smart-retry-btn" onClick={(event) => { pin(event); engine.retryUpload(file.uid); }}>
					<RotateCcw size={12} />
				</button>
			</Tooltip>
		);
	};

	const renderStatusPanel = () => (
		<PopoverSurface
			ref={panelRef}
			className={`inno-smart-panel inno-smart-panel--status ${statusColumnCount === 1 ? "is-single-column" : ""}`}
			onMouseEnter={cancelClose}
			onMouseLeave={scheduleClose}
			style={{ left: panel.anchor.left, top: panel.anchor.bottom + 4 }}
		>
			<div className="inno-smart-fill-head">
				<div className="inno-smart-panel-title">
					{t("chat.smartInput.boundFilesTitle", "「{{word}}」绑定的文件（{{count}}）", { word: slot.word, count: slot.files.length })}
				</div>
				{fillCandidates.length > 0 && !workspaceFilesLoading ? (
					<Tooltip label={t("chat.smartInput.addBinding", "继续添加文件")}>
						<button
							type="button"
							className="inno-smart-fill-plus"
							aria-label={t("chat.smartInput.addBinding", "继续添加文件")}
							onClick={(event) => {
								pin(event);
								openFill();
							}}
						>
							<Plus size={12} />
						</button>
					</Tooltip>
				) : null}
			</div>
			<div
				className="inno-smart-panel-list"
				onMouseEnter={() => onWorkspaceHighlight(slot.files.map((file) => file.path))}
				onMouseLeave={() => onWorkspaceHighlight(null)}
				style={{ gridTemplateColumns: `repeat(${statusColumnCount}, minmax(0, 1fr))` }}
			>
				{slot.files.map((file) => (
						<div
							key={file.uid}
							className={`inno-smart-panel-row ${file.state === "workspace" ? "cursor-pointer" : ""}`}
							onMouseEnter={() => onWorkspaceHighlight([file.path])}
							onClick={(event) => {
								if (file.state !== "workspace" || (event.target as HTMLElement).closest("button")) return;
								event.preventDefault();
								onOpenFilePreview(file.path);
							}}
						>
							<FileTypeIcon kind={kindFromName(file.name)} size={14} />
						<FileName name={file.name} className="inno-smart-panel-name" title={file.path} />
						<span className="inno-smart-src-tag">{sourceLabel(file)}</span>
						{renderProgress(file)}
						<Tooltip label={t("chat.smartInput.removeBinding", "移除绑定")}>
							<button
								type="button"
								className="inno-smart-panel-remove"
								onClick={(event) => {
									pin(event);
									const wasLast = slot.files.length <= 1;
									engine.removeBinding(slot, file.uid);
									if (wasLast) {
										onClose();
										openFill();
									}
								}}
							>
								<X size={12} />
							</button>
						</Tooltip>
					</div>
				))}
			</div>
			<div className="inno-smart-panel-caption">{t("chat.smartInput.kindLabel", "类型")}: {acceptedTypeLabel}</div>
		</PopoverSurface>
	);

	const renderFillMenu = () => (
		<PopoverSurface
			ref={panelRef}
			className={`inno-smart-panel inno-smart-panel--fill ${fillCandidates.length === 0 ? "is-empty" : ""}`}
			onMouseEnter={cancelClose}
			onMouseLeave={scheduleClose}
			style={{ left: panel.anchor.left, top: panel.anchor.bottom + 4 }}
		>
			<div className="inno-smart-fill-head">
				<div className="flex min-w-0 items-center gap-1.5">
					{slot.files.length > 0 ? (
						<Tooltip label={t("chat.smartInput.backToBound", "返回绑定列表")}>
							<button
								type="button"
								className="inno-smart-fill-plus"
								aria-label={t("chat.smartInput.backToBound", "返回绑定列表")}
								onClick={(event) => {
									pin(event);
									openStatus();
								}}
							>
								<ArrowLeft size={14} aria-hidden="true" />
							</button>
						</Tooltip>
					) : null}
					<div className="inno-smart-panel-title">
						{pickFileTitle}
					</div>
				</div>
				{fillCandidates.length > 0 ? (
					multiSelect ? (
						<div className="inno-smart-fill-actions">
							<button
								type="button"
								className="inno-smart-fill-btn"
								onClick={() => {
									setMultiSelect(false);
									setPicked(new Map());
								}}
							>
								{t("common.cancel", "取消")}
							</button>
							<button
								type="button"
								className="inno-smart-fill-btn is-primary"
								disabled={picked.size === 0}
								onClick={() => {
									for (const [path, source] of picked) {
										bindCandidate({ name: path.split("/").pop() ?? path, path, source });
									}
									if (picked.size > 0) openStatus();
									onClose();
								}}
							>
								<Check size={12} aria-hidden="true" />
								{picked.size}
							</button>
						</div>
					) : (
						<Tooltip label={t("chat.smartInput.batchAdd", "批量添加")}>
							<button
								type="button"
								className="inno-smart-fill-plus"
								aria-label={t("chat.smartInput.batchAdd", "批量添加")}
								onClick={() => {
									setMultiSelect(true);
									setPicked(new Map());
								}}
							>
								<ListChecks size={14} aria-hidden="true" />
							</button>
						</Tooltip>
					)
				) : null}
			</div>
			{workspaceFilesLoading ? (
				<div className="inno-smart-panel-empty is-loading">{t("chat.smartInput.workspaceLoading", "正在加载工作区文件…")}</div>
			) : fillCandidates.length === 0 ? (
				<div className="inno-smart-panel-empty">{t("chat.smartInput.workspaceNoMatch", "工作区暂无匹配该规则的文件")}</div>
			) : (
				<div
					className={`inno-smart-panel-list inno-smart-panel-grid ${multiSelect ? "is-multi" : ""}`}
					onMouseEnter={() => onWorkspaceHighlight(fillCandidates.filter((c) => c.source === "workspace").map((c) => c.path))}
					onMouseLeave={() => onWorkspaceHighlight(null)}
				>
					{fillCandidates.map((candidate) => {
						const active = picked.has(candidate.path);
						return (
							<MenuOption
								key={`${candidate.source}:${candidate.path}`}
								className={`inno-smart-panel-row inno-smart-panel-pick ${active ? "is-on" : ""}`}
								title={candidate.path}
								aria-pressed={active}
								onMouseEnter={() => onWorkspaceHighlight(candidate.source === "workspace" ? [candidate.path] : null)}
								onClick={(event) => {
									if (multiSelect) {
										pin(event);
										setPicked((current) => {
											const next = new Map(current);
											if (next.has(candidate.path)) next.delete(candidate.path);
											else next.set(candidate.path, candidate.source);
											return next;
										});
										return;
									}
									bindCandidate(candidate);
									onClose();
								}}
							>
								<FileTypeIcon kind={kindFromName(candidate.name)} size={14} />
								<FileName name={candidate.name} className="inno-smart-panel-name" />
								{candidate.source === "attach" ? <span className="inno-smart-src-tag">{t("chat.smartInput.sourceAttach", "附件")}</span> : null}
								{multiSelect && active ? <Check size={12} className="shrink-0 text-[var(--inno-accent)]" /> : null}
							</MenuOption>
						);
					})}
				</div>
			)}
		</PopoverSurface>
	);

	const renderMenu = () => {
		const items: ContextMenuItem[] = [];
		if (slot.bubbleType === "agent") {
			const commandName = (slot.agentCommand ?? slot.word).replace(/^\/+/, "");
			if (commandName.startsWith("skill:") && commandName.slice("skill:".length)) {
				items.push({
					label: t("chat.smartInput.openSkillDescription", "打开技能说明"),
					onSelect: () => onOpenSkillPanel(commandName.slice("skill:".length)),
				});
			}
			items.push({
				label: t("chat.smartInput.deleteAgentBubble", "删除命令气泡"),
				danger: true,
				onSelect: () => engine.removeSlot(slot),
			});
			return (
				<ContextMenu
					x={panel.x ?? 0}
					y={panel.y ?? 0}
					items={items}
					onClose={onClose}
				/>
			);
		}
		if (slot.files.length > 0) {
			items.push({ label: t("chat.smartInput.viewStatus", "查看上传状态"), onSelect: () => switchPanel("status") });
			items.push({ label: t("chat.smartInput.unbindAll", "移除全部绑定（{{count}} 个文件回到附件）", { count: slot.files.length }), onSelect: () => engine.unbindAll(slot) });
		} else {
			items.push({ label: t("chat.smartInput.chooseFile", "选择文件…"), onSelect: () => switchPanel("fill") });
		}
		items.push({ label: t("chat.smartInput.ignoreBubble", "忽略气泡（还原为文字）"), onSelect: () => engine.removeSlot(slot), danger: true });

		return (
			<ContextMenu
				x={panel.x ?? 0}
				y={panel.y ?? 0}
				items={items}
				onClose={() => {
					const next = menuNextPanel.current;
					menuNextPanel.current = null;
					if (next) onOpenPanel(next);
					else onClose();
				}}
			/>
		);
	};

	const node = panel.kind === "status" ? renderStatusPanel() : panel.kind === "fill" ? renderFillMenu() : renderMenu();
	return createPortal(node, document.body);
}

type SlotFile = SmartInputEngine["slots"][number]["files"][number];
