import type { WorkspaceFileDetail } from "../../types/workspace.js";

/** Engines export drafts; OfficeEditorSession alone confirms and persists them. */
export interface OfficeEditorHandle {
	exportBytes: () => Promise<Uint8Array>;
}

export interface OfficeEditorProps {
	file: WorkspaceFileDetail;
	/** Notifies the host file bar when saving becomes possible. */
	onReadyChange?: (ready: boolean) => void;
	/**
	 * Reports real content changes inside the editor (PPTist deck mutations,
	 * Univer sheet mutations). Plain selections, scrolling and paging do not
	 * fire it, so the file bar's 未保存 hint tracks actual edits only.
	 */
	onInteract?: () => void;
}
