import type { WorkspaceFileDetail } from "../../types/workspace.js";

/**
 * Imperative surface the file bar uses to drive a preview-pane office
 * editor (pptx/xlsx). The session owns saving edited copies and leaving the
 * editor; each engine exports its current workbook/deck as bytes.
 */
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
