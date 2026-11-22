import type { WorkspaceFileDetail } from "../../types/workspace.js";

/** Engines export drafts; OfficeEditorSession alone persists them. */
export interface OfficeEditorHandle {
	exportBytes: () => Promise<Uint8Array>;
	/** Exact imported bytes; preview timestamps may belong to an older file. */
	getSourceBytes: () => Uint8Array;
}

export async function hashOfficeBytes(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
	return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
}

export interface OfficeEditorProps {
	file: WorkspaceFileDetail;
	/** Notifies the host file bar when saving becomes possible. */
	onReadyChange?: (ready: boolean) => void;
    onSaveRequest?: () => void;
	/**
	 * Reports real content changes inside the editor (PPTist deck mutations,
	 * Univer sheet mutations). Plain selections, scrolling and paging do not
	 * fire it, so the file bar's 未保存 hint tracks actual edits only.
	 */
	onInteract?: () => void;
}
