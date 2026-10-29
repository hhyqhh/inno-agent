import type { AttachmentFileKind, ChatMessage } from "../types/chat.js";

export interface OfficeDeliverable {
	path: string;
	workspaceId: string | null;
	kind: AttachmentFileKind;
	type: string;
}

const OFFICE_TYPES: Record<string, { kind: AttachmentFileKind; type: string }> = {
	doc: { kind: "doc", type: "Word" }, docx: { kind: "doc", type: "Word" },
	odt: { kind: "doc", type: "Word" }, rtf: { kind: "doc", type: "Word" },
	ppt: { kind: "ppt", type: "PowerPoint" }, pptx: { kind: "ppt", type: "PowerPoint" },
	odp: { kind: "ppt", type: "PowerPoint" },
	xls: { kind: "xls", type: "Excel" }, xlsx: { kind: "xls", type: "Excel" },
	ods: { kind: "xls", type: "Excel" }, csv: { kind: "xls", type: "Excel" },
};

export function officeFileType(path: string) {
	return OFFICE_TYPES[path.split(".").pop()?.toLowerCase() ?? ""];
}

export function isOfficePreviewAsset(path: string): boolean {
	return path.replaceAll("\\", "/").split("/").includes(".inno-previews");
}

/** Derive final cards from existing turn records, without another persisted registry.
 * Reads/open/inspect results are deliberately excluded: they are inputs, not deliverables.
 */
export function officeDeliverables(messages: ChatMessage[], fallbackWorkspaceId: string | null): OfficeDeliverable[] {
	const files = new Map<string, OfficeDeliverable>();
	const apply = (path: string, change: string, workspaceId: string | null) => {
		const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
		const format = officeFileType(normalized);
		if (!format || isOfficePreviewAsset(normalized) || normalized.startsWith("/") || /^[a-z]:/i.test(normalized)
			|| normalized.split("/").some((part) => part === ".." || part.startsWith(".~lock.") || part.startsWith("~$"))) return;
		const key = JSON.stringify([workspaceId, normalized]);
		if (change === "deleted") files.delete(key);
		else files.set(key, { path: normalized, workspaceId, ...format });
	};
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		// Raw events preserve workspace ownership and chronological deletions.
		const events = message.traceEvents?.filter((record) => record.event.type === "workspace_change");
		if (events?.length) {
			for (const { event } of events) {
				if (event.type !== "workspace_change") continue;
				for (const change of event.changes) apply(change.path, change.change, event.workspaceId ?? fallbackWorkspaceId);
			}
		} else {
			for (const step of message.trace ?? []) {
				for (const change of step.workspaceChanges ?? []) apply(change.path, change.change, fallbackWorkspaceId);
			}
		}
	}
	return [...files.values()];
}
