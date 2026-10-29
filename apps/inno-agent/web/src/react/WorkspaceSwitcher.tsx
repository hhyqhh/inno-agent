import {
	useUITransition,
	Input,
	SearchableSelect,
	type SearchableSelectAction,
	type SearchableSelectSection,
} from "./ui/index.js";
import { useMemo, useRef, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import { motion } from "motion/react";
import { Ban, Check, ChevronDown, Folder, FolderInput, LoaderCircle, Plus, X } from "lucide-react";
import type { WorkspaceMeta } from "../api/workspaces.js";

export type WorkspaceChoice =
	| { kind: "workspace"; workspaceId: string }
	| { kind: "temp" }
	| { kind: "new"; name: string };

export type WorkspaceSelectionKind = "workspace" | "temp" | "new";

interface WorkspaceSwitcherProps {
	/** All registered workspaces. Channel-native workspaces are always hidden. */
	workspaces: WorkspaceMeta[];
	/** The workspace currently represented by the surrounding session or draft. */
	selectedWorkspaceId: string | null;
	/** Draft-only selection when there is no bound workspace yet. */
	selectedKind: WorkspaceSelectionKind;
	newWorkspaceName?: string;
	busy?: boolean;
	disabled?: boolean;
	/** Active-conversation mode: only choose an existing workspace; no create/import actions. */
	conversationMode?: boolean;
	className?: string;
	onChange: (choice: WorkspaceChoice) => void;
	/** Import a workspace from a .zip archive picked via the menu action. */
	onImport?: (file: File) => void;
}

/**
 * Workspace selection built on the shared searchable-select pattern. Workspace
 * filtering, selected rows, popover placement and keyboard behavior are shared;
 * this component owns only workspace-specific actions and create/import flow.
 */
export function WorkspaceSwitcher({
	workspaces,
	selectedWorkspaceId,
	selectedKind,
	newWorkspaceName = "",
	busy = false,
	disabled = false,
	conversationMode = false,
	className = "",
	onChange,
	onImport,
}: WorkspaceSwitcherProps) {
	const uiTransition = useUITransition();
	const { t } = useTranslation();
	const createInputRef = useRef<HTMLInputElement | null>(null);
	const importInputRef = useRef<HTMLInputElement | null>(null);
	const [open, setOpen] = useState(false);
	const [creating, setCreating] = useState(false);
	const [draftName, setDraftName] = useState(newWorkspaceName);

	const selectedWorkspace = useMemo(
		() => (selectedWorkspaceId ? workspaces.find((workspace) => workspace.id === selectedWorkspaceId) : undefined),
		[selectedWorkspaceId, workspaces],
	);
	const tempWorkspace = useMemo(() => workspaces.find((workspace) => workspace.isTemp), [workspaces]);
	const resolvedKind: WorkspaceSelectionKind = selectedWorkspace?.isTemp
		? "temp"
		: selectedWorkspaceId
			? "workspace"
			: selectedKind;
	const selectedValue = selectedWorkspace?.id ?? (resolvedKind === "temp" ? tempWorkspace?.id ?? null : null);
	const triggerLabel = resolvedKind === "temp"
		? t("workspace.tempWorkspaceLabel")
		: resolvedKind === "new"
			? newWorkspaceName.trim() || t("workspace.newWorkspace")
			: selectedWorkspace?.name ?? t("workspace.selectWorkspace");
	const searchableWorkspaces = useMemo(
		() => workspaces.filter((workspace) => !workspace.id.startsWith("channel-") && (conversationMode || !workspace.isTemp)),
		[conversationMode, workspaces],
	);
	const sections = useMemo<SearchableSelectSection[]>(() => {
		const projectOptions = searchableWorkspaces.map((workspace) => ({
			value: workspace.id,
			label: workspace.name,
			searchText: workspace.relPath,
			icon: workspace.isTemp ? <Ban size={14} /> : <Folder size={14} />,
			className: "inno-workspace-option",
		}));
		return [{ id: "workspaces", options: projectOptions }];
	}, [searchableWorkspaces]);

	const close = () => {
		setOpen(false);
		setCreating(false);
	};

	const choose = (choice: WorkspaceChoice) => {
		if (conversationMode) {
			const choiceWorkspaceId = choice.kind === "workspace"
				? choice.workspaceId
				: choice.kind === "temp"
					? tempWorkspace?.id
					: undefined;
			if (choiceWorkspaceId && selectedWorkspace?.id === choiceWorkspaceId) {
				close();
				return;
			}
		}
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
		// Close before opening the native file dialog, then click within the same
		// user gesture so browsers preserve the file-picker activation.
		close();
		importInputRef.current?.click();
	};

	const handleImportFile = (event: ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0];
		event.target.value = "";
		if (file && onImport) onImport(file);
	};

	const actions: SearchableSelectAction[] = conversationMode ? [] : [
		...(tempWorkspace
			? [{
				id: "temporary-workspace",
				label: t("workspace.tempWorkspace"),
				icon: <Ban size={15} />,
				selected: resolvedKind === "temp",
				onSelect: () => choose({ kind: "temp" }),
			}]
			: []),
		{
			id: "create-workspace",
			label: t("workspace.newWorkspace"),
			icon: <Plus size={15} />,
			onSelect: () => {
				setDraftName(newWorkspaceName);
				setCreating(true);
			},
			closeOnSelect: false,
		},
		...(onImport
			? [{
				id: "import-workspace",
				label: t("workspace.importWorkspace"),
				icon: <FolderInput size={15} />,
				onSelect: pickImportArchive,
			}]
			: []),
	];

	const createContent = creating ? (
		<div className="inno-workspace-create-form">
			<div className="inno-workspace-menu-heading">{t("workspace.newWorkspace")}</div>
			<div className="inno-workspace-create-row">
				<Input
					size="sm"
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
	) : undefined;

	return (
		<div className={`inno-workspace-switcher ${className}`}>
			<SearchableSelect
				trigger={(
					<button
						type="button"
						className="inno-workspace-switcher-trigger inno-composer-subrow-control"
						disabled={disabled || busy}
					>
						<span className="inno-workspace-switcher-folder" aria-hidden="true"><Folder size={15} /></span>
						<span className="inno-workspace-switcher-label">{triggerLabel}</span>
						{busy ? <LoaderCircle size={13} className="inno-workspace-switcher-spinner" aria-hidden="true" /> : (
							<motion.span
								className="inline-flex shrink-0"
								animate={{ rotate: open ? 180 : 0 }}
								transition={uiTransition}
							>
								<ChevronDown size={13} aria-hidden="true" />
							</motion.span>
						)}
					</button>
				)}
				open={open}
				onOpenChange={(nextOpen) => {
					setOpen(nextOpen);
					if (!nextOpen) setCreating(false);
				}}
				sections={sections}
				value={selectedValue}
				onValueChange={(workspaceId) => {
					if (!conversationMode && tempWorkspace?.id === workspaceId) choose({ kind: "temp" });
					else choose({ kind: "workspace", workspaceId });
				}}
				searchPlaceholder={t("workspace.searchPlaceholder")}
				searchClassName="inno-workspace-switcher-search"
				clearSearchLabel={t("common.clearSearch", "清除搜索")}
				emptyMessage={t("workspace.noResults")}
				ariaLabel={t("workspace.title")}
				actions={actions}
				customContent={createContent}
				initialFocusRef={creating ? createInputRef : undefined}
				contentClassName="inno-workspace-switcher-menu"
				maxListHeight={180}
				side="top"
				sideOffset={8}
			/>
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
