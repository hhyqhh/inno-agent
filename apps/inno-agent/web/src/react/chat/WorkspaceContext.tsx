import { useTranslation } from "react-i18next";
import type { WorkspaceMeta } from "../../api/workspaces.js";
import { WorkspaceSwitcher, type WorkspaceChoice, type WorkspaceSelectionKind } from "../WorkspaceSwitcher.js";

interface WorkspaceContextProps {
	context: "welcome" | "session";
	workspaces: WorkspaceMeta[];
	selectedWorkspaceId: string | null;
	selectedKind: WorkspaceSelectionKind;
	newWorkspaceName?: string;
	busy?: boolean;
	disabled?: boolean;
	showHint?: boolean;
	onChange: (choice: WorkspaceChoice) => void;
}

/** Shared workspace context row used below both composer variants. */
export function WorkspaceContext({
	context,
	workspaces,
	selectedWorkspaceId,
	selectedKind,
	newWorkspaceName = "",
	busy = false,
	disabled = false,
	showHint = false,
	onChange,
}: WorkspaceContextProps) {
	const { t } = useTranslation();
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
			{context === "welcome" && showHint ? (
				<span className="inno-workspace-context-hint">{t("chat.newChatHere")}</span>
			) : null}
		</div>
	);
}
