import type { WorkspaceFileDetail } from "../../types/workspace.js";

/**
 * Imperative surface the file bar uses to drive a preview-pane office
 * editor (pptx/xlsx): the shared WorkspaceFileBar owns the Save / back-to-
 * preview actions, the editor owns engine state. `save` reports whether the
 * workbook/deck actually made it to the workspace.
 */
export interface OfficeEditorHandle {
	save: () => Promise<boolean>;
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
