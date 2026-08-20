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
}

/** Workspace context row used below the welcome composer. */
export function WorkspaceContext({
	workspaces,
	selectedWorkspaceId,
	selectedKind,
	newWorkspaceName = "",
	busy = false,
	disabled = false,
	onChange,
}: WorkspaceContextProps) {
	return (
		<div className="inno-workspace-context-row">
			<WorkspaceSwitcher
				workspaces={workspaces}
				selectedWorkspaceId={selectedWorkspaceId}
				selectedKind={selectedKind}
				newWorkspaceName={newWorkspaceName}
				busy={busy}
				disabled={disabled}
				onChange={onChange}
			/>
		</div>
	);
}
