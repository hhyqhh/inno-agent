import { createPortal } from "react-dom";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, ChevronUp, Folder, FolderInput, Plus, Search, X, Ban, LoaderCircle } from "lucide-react";
import type { WorkspaceMeta } from "../api/workspaces.js";
import { PopoverSurface } from "./ui/PopoverSurface.js";

export type WorkspaceChoice =
	| { kind: "workspace"; workspaceId: string }
	| { kind: "temp" }
	| { kind: "new"; name: string };

export type WorkspaceSelectionKind = "workspace" | "temp" | "new";

interface WorkspaceSwitcherProps {
	/** All registered workspaces. Temporary and channel-native workspaces are hidden from the picker list. */
	workspaces: WorkspaceMeta[];
	/** The workspace currently represented by the surrounding session or draft. */
	selectedWorkspaceId: string | null;
	/** Draft-only selection when there is no bound workspace yet. */
	selectedKind: WorkspaceSelectionKind;
	newWorkspaceName?: string;
	busy?: boolean;
	disabled?: boolean;
	className?: string;
	onChange: (choice: WorkspaceChoice) => void;
	/** Import a workspace from a .zip archive picked via the menu action. */
	onImport?: (file: File) => void;
}

type WorkspaceMenuPlacement = "above" | "below";

interface WorkspaceMenuPosition {
	left: number;
	top: number;
	maxHeight: number;
	placement: WorkspaceMenuPlacement;
}

const WORKSPACE_MENU_MARGIN = 8;
const WORKSPACE_MENU_MAX_HEIGHT = 390;

/**
 * Compact workspace context selector shared by the welcome view and active
 * conversations. It deliberately owns only the popover UI; session binding
 * and draft creation remain in ChatCenter.
 */
export function WorkspaceSwitcher({
	workspaces,
	selectedWorkspaceId,
	selectedKind,
	newWorkspaceName = "",
	busy = false,
	disabled = false,
	className = "",
	onChange,
	onImport,
}: WorkspaceSwitcherProps) {
	const { t } = useTranslation();
	const rootRef = useRef<HTMLDivElement | null>(null);
	const triggerRef = useRef<HTMLButtonElement | null>(null);
	const menuRef = useRef<HTMLDivElement | null>(null);
	const searchRef = useRef<HTMLInputElement | null>(null);
	const createInputRef = useRef<HTMLInputElement | null>(null);
	const importInputRef = useRef<HTMLInputElement | null>(null);
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [creating, setCreating] = useState(false);
	const [draftName, setDraftName] = useState(newWorkspaceName);
	const [menuPosition, setMenuPosition] = useState<WorkspaceMenuPosition>({
		left: WORKSPACE_MENU_MARGIN,
		top: WORKSPACE_MENU_MARGIN,
		maxHeight: WORKSPACE_MENU_MAX_HEIGHT,
		placement: "above",
	});

	const selectedWorkspace = useMemo(
		() => (selectedWorkspaceId ? workspaces.find((workspace) => workspace.id === selectedWorkspaceId) : undefined),
		[ selectedWorkspaceId, workspaces ],
	);
	const resolvedKind: WorkspaceSelectionKind = selectedWorkspace?.isTemp
		? "temp"
		: selectedWorkspaceId
			? "workspace"
			: selectedKind;
	const visibleWorkspaces = useMemo(() => {
		const normalized = query.trim().toLocaleLowerCase();
		return workspaces
			.filter((workspace) => !workspace.isTemp && !workspace.id.startsWith("channel-"))
			.filter((workspace) => !normalized || `${workspace.name} ${workspace.relPath}`.toLocaleLowerCase().includes(normalized));
	}, [query, workspaces]);

	const triggerLabel = resolvedKind === "temp"
		? t("workspace.tempWorkspaceLabel")
		: resolvedKind === "new"
			? newWorkspaceName.trim() || t("workspace.newWorkspace")
			: selectedWorkspace?.name ?? t("workspace.selectWorkspace");

	useEffect(() => {
		if (!open) return;
		const closeOnPointerDown = (event: PointerEvent) => {
			const target = event.target as Node;
			if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return;
			setOpen(false);
		};
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setOpen(false);
				setCreating(false);
			}
		};
		document.addEventListener("pointerdown", closeOnPointerDown);
		window.addEventListener("keydown", closeOnEscape);
		return () => {
			document.removeEventListener("pointerdown", closeOnPointerDown);
			window.removeEventListener("keydown", closeOnEscape);
		};
	}, [open]);

	const repositionMenu = useCallback(() => {
		if (!open) return;
		const trigger = triggerRef.current;
		const menu = menuRef.current;
		if (!trigger || !menu || typeof window === "undefined") return;

		const triggerRect = trigger.getBoundingClientRect();
		const aboveSpace = Math.max(0, triggerRect.top - WORKSPACE_MENU_MARGIN);
		const belowSpace = Math.max(0, window.innerHeight - triggerRect.bottom - WORKSPACE_MENU_MARGIN);
		const placement: WorkspaceMenuPlacement = aboveSpace >= belowSpace ? "above" : "below";
		const availableSpace = placement === "above" ? aboveSpace : belowSpace;
		const maxHeight = Math.max(1, Math.min(WORKSPACE_MENU_MAX_HEIGHT, availableSpace));

		// Apply the available height before measuring so the first layout already
		// reserves a scrollable list instead of painting past the viewport.
		menu.style.maxHeight = `${maxHeight}px`;
		// getBoundingClientRect() includes the opening transform animation. Reading
		// it here and again after the first scroll produces a small position jump;
		// offset* reports the stable, untransformed layout box instead.
		const width = Math.min(menu.offsetWidth || 300, Math.max(1, window.innerWidth - WORKSPACE_MENU_MARGIN * 2));
		const height = Math.min(menu.offsetHeight || maxHeight, maxHeight);
		const maxLeft = Math.max(WORKSPACE_MENU_MARGIN, window.innerWidth - width - WORKSPACE_MENU_MARGIN);
		const left = Math.max(WORKSPACE_MENU_MARGIN, Math.min(triggerRect.left, maxLeft));
		const preferredTop = placement === "above"
			? triggerRect.top - height - WORKSPACE_MENU_MARGIN
			: triggerRect.bottom + WORKSPACE_MENU_MARGIN;
		const maxTop = Math.max(WORKSPACE_MENU_MARGIN, window.innerHeight - height - WORKSPACE_MENU_MARGIN);
		const top = Math.max(WORKSPACE_MENU_MARGIN, Math.min(preferredTop, maxTop));

		setMenuPosition((previous) => (
			previous.left === left
				&& previous.top === top
				&& previous.maxHeight === maxHeight
				&& previous.placement === placement
				? previous
				: { left, top, maxHeight, placement }
		));
	}, [open]);

	useLayoutEffect(() => {
		if (!open) return;
		repositionMenu();
		const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(repositionMenu);
		for (const target of [triggerRef.current, menuRef.current]) {
			if (target) resizeObserver?.observe(target);
		}
		window.addEventListener("resize", repositionMenu);
		const handleScroll = (event: Event) => {
			// Scrolling the portaled menu only changes its contents, not its fixed
			// anchor. Avoid a synchronous layout read on every wheel/trackpad event.
			if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
			repositionMenu();
		};
		document.addEventListener("scroll", handleScroll, true);
		return () => {
			resizeObserver?.disconnect();
			window.removeEventListener("resize", repositionMenu);
			document.removeEventListener("scroll", handleScroll, true);
		};
	}, [creating, open, repositionMenu, visibleWorkspaces.length]);

	useEffect(() => {
		if (!open) {
			setQuery("");
			setCreating(false);
			return;
		}
		if (creating) createInputRef.current?.focus();
		else searchRef.current?.focus();
	}, [creating, open]);

	const close = () => {
		setOpen(false);
		setCreating(false);
		setQuery("");
	};

	const choose = (choice: WorkspaceChoice) => {
		onChange(choice);
		close();
	};

	const submitNewWorkspace = () => {
		const name = draftName.trim();
		if (!name) return;
		choose({ kind: "new", name });
		setDraftName("");
	};

	const pickImportArchive = () => {
		// Close the popover first: the native file dialog blocks the main
		// thread, and the outside-pointer-down listener would otherwise fire
		// on the dialog itself.
		close();
		importInputRef.current?.click();
	};

	const handleImportFile = (event: ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0];
		// Reset so picking the same archive twice still fires change.
		event.target.value = "";
		if (file && onImport) onImport(file);
	};

	return (
		<div ref={rootRef} className={`inno-workspace-switcher ${className}`}>
			<button
				type="button"
				ref={triggerRef}
				className="inno-workspace-switcher-trigger"
				disabled={disabled || busy}
				aria-haspopup="menu"
				aria-expanded={open}
				title={t("workspace.switch")}
				onClick={() => setOpen((value) => !value)}
			>
				<span className="inno-workspace-switcher-folder" aria-hidden="true">
					<Folder size={15} />
				</span>
				<span className="inno-workspace-switcher-label" title={triggerLabel}>{triggerLabel}</span>
				{busy ? <LoaderCircle size={13} className="inno-workspace-switcher-spinner" aria-hidden="true" /> : open ? <ChevronUp size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
			</button>

			{open && typeof document !== "undefined" ? createPortal(
				<PopoverSurface
					ref={menuRef}
					className="inno-workspace-switcher-menu"
					role="menu"
					aria-label={t("workspace.switch")}
					style={{
						position: "fixed",
						left: menuPosition.left,
						top: menuPosition.top,
						right: "auto",
						bottom: "auto",
						maxHeight: menuPosition.maxHeight,
						zIndex: 100,
						transformOrigin: menuPosition.placement === "above" ? "bottom left" : "top left",
					}}
				>
					{creating ? (
						<div className="inno-workspace-create-form">
							<div className="inno-workspace-menu-heading">{t("workspace.newWorkspace")}</div>
							<div className="inno-workspace-create-row">
								<input
									ref={createInputRef}
									value={draftName}
									placeholder={t("workspace.newWorkspacePlaceholder")}
									className="inno-workspace-search-input"
									onChange={(event) => setDraftName(event.target.value)}
									onKeyDown={(event) => {
										if (event.key === "Enter") {
											event.preventDefault();
											submitNewWorkspace();
										}
										if (event.key === "Escape") {
											setCreating(false);
											setDraftName("");
										}
									}}
								/>
								<button
									type="button"
									className="inno-workspace-create-submit"
									disabled={!draftName.trim()}
									onClick={submitNewWorkspace}
								>
									<Check size={14} />
								</button>
							</div>
							<button
								type="button"
								className="inno-workspace-menu-back"
								onClick={() => {
									setCreating(false);
									setDraftName("");
								}}
							>
								<X size={13} />
								<span>{t("common.cancel")}</span>
							</button>
						</div>
					) : (
						<>
							<div className="inno-workspace-search">
								<Search size={14} aria-hidden="true" />
								<input
									ref={searchRef}
									value={query}
									placeholder={t("workspace.searchPlaceholder")}
									aria-label={t("workspace.searchPlaceholder")}
									onChange={(event) => setQuery(event.target.value)}
								/>
								{query ? (
									<button type="button" className="inno-workspace-search-clear" aria-label={t("common.clearSearch", "清除搜索")} onClick={() => setQuery("")}>
										<X size={13} />
									</button>
								) : null}
							</div>

							<div className="inno-workspace-options" role="group" aria-label={t("workspace.title")}>
								{visibleWorkspaces.length > 0 ? visibleWorkspaces.map((workspace) => {
									const selected = resolvedKind === "workspace" && selectedWorkspaceId === workspace.id;
									return (
										<button
											key={workspace.id}
											type="button"
											role="menuitemradio"
											aria-checked={selected}
											className={`inno-workspace-option ${selected ? "is-selected" : ""}`}
											title={workspace.relPath}
											onClick={() => choose({ kind: "workspace", workspaceId: workspace.id })}
										>
											<span className="inno-workspace-option-icon" aria-hidden="true"><Folder size={15} /></span>
											<span className="inno-workspace-option-copy">
												<span className="inno-workspace-option-name">{workspace.name}</span>
												<span className="inno-workspace-option-path">{workspace.relPath}</span>
											</span>
											{selected ? <Check size={15} className="inno-workspace-option-check" aria-hidden="true" /> : null}
										</button>
									);
								}) : (
									<div className="inno-workspace-empty">{t("workspace.noResults")}</div>
								)}
							</div>

							<div className="inno-workspace-menu-divider" />
							<button type="button" className="inno-workspace-action" role="menuitem" onClick={() => setCreating(true)}>
								<span className="inno-workspace-action-icon" aria-hidden="true"><Plus size={15} /></span>
								<span>{t("workspace.newWorkspace")}</span>
							</button>
							{onImport ? (
								<button type="button" className="inno-workspace-action" role="menuitem" onClick={pickImportArchive}>
									<span className="inno-workspace-action-icon" aria-hidden="true"><FolderInput size={15} /></span>
									<span>{t("workspace.importWorkspace")}</span>
								</button>
							) : null}
							<button
								type="button"
								className={`inno-workspace-action ${resolvedKind === "temp" ? "is-selected" : ""}`}
								role="menuitemradio"
								aria-checked={resolvedKind === "temp"}
								onClick={() => choose({ kind: "temp" })}
							>
								<span className="inno-workspace-action-icon" aria-hidden="true"><Ban size={14} /></span>
								<span>{t("workspace.tempWorkspace")}</span>
								{resolvedKind === "temp" ? <Check size={15} className="inno-workspace-option-check" aria-hidden="true" /> : null}
							</button>
						</>
					)}
				</PopoverSurface>,
				document.body,
			) : null}
			{onImport ? (
				<input
					ref={importInputRef}
					type="file"
					accept=".zip,application/zip,application/x-zip-compressed"
					hidden
					onChange={handleImportFile}
				/>
			) : null}
		</div>
	);
}
