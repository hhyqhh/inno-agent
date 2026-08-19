import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, Folder, Plus, Search, X, Ban, LoaderCircle } from "lucide-react";
import type { WorkspaceMeta } from "../api/workspaces.js";

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
}

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
}: WorkspaceSwitcherProps) {
	const { t } = useTranslation();
	const rootRef = useRef<HTMLDivElement | null>(null);
	const searchRef = useRef<HTMLInputElement | null>(null);
	const createInputRef = useRef<HTMLInputElement | null>(null);
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [creating, setCreating] = useState(false);
	const [draftName, setDraftName] = useState(newWorkspaceName);

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
			if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
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

	return (
		<div ref={rootRef} className={`inno-workspace-switcher ${className}`}>
			<button
				type="button"
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
				{busy ? <LoaderCircle size={13} className="inno-workspace-switcher-spinner" aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
			</button>

			{open ? (
				<div className="inno-workspace-switcher-menu" role="menu" aria-label={t("workspace.switch")}>
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
				</div>
			) : null}
		</div>
	);
}
