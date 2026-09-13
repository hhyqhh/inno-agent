import type { WorkspaceMeta } from "../../api/workspaces.js";
import { WorkspaceSwitcher, type WorkspaceChoice, type WorkspaceSelectionKind } from "../WorkspaceSwitcher.js";

interface WorkspaceContextProps {
	workspaces: WorkspaceMeta[];
	selectedWorkspaceId: string | null;
	selectedKind: WorkspaceSelectionKind;
	newWorkspaceName?: string;
	busy?: boolean;
	disabled?: boolean;
	onChange: (choice: WorkspaceChoice) => void;
	/** Import a workspace from a .zip archive picked via the menu action. */
	onImport?: (file: File) => void;
}

/** Workspace context controls for the composer's sub-pill row (welcome view). */
export function WorkspaceContext({
	workspaces,
	selectedWorkspaceId,
	selectedKind,
	newWorkspaceName = "",
	busy = false,
	disabled = false,
	onChange,
	onImport,
}: WorkspaceContextProps) {
	return (
		<WorkspaceSwitcher
			workspaces={workspaces}
			selectedWorkspaceId={selectedWorkspaceId}
			selectedKind={selectedKind}
			newWorkspaceName={newWorkspaceName}
			busy={busy}
			disabled={disabled}
			onChange={onChange}
			onImport={onImport}
		/>
	);
}
