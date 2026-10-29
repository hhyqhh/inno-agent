import type { OfficeDeliverable } from "../../utils/office-deliverables.js";
import { rememberFileOpenPreference } from "../../utils/file-open-preference.js";
import { FileTypeIcon } from "../FileTypeIcon.js";
import { WorkspaceOpenWithMenu } from "../WorkspaceOpenWithMenu.js";
import { Button } from "../ui/index.js";

/** Final deliverables stay in the conversation; opening is always a user action. */
export function OfficeDocumentCards({ files, onOpen }: { files: OfficeDeliverable[]; onOpen: (file: OfficeDeliverable) => void }) {
	if (!files.length) return null;
	// The bubble's action row overlaps its bottom by 6px; reserve space so it
	// does not sit against the final file card's border.
	return <div className="mt-3 flex min-w-0 flex-col gap-2 pb-3">
		{files.map((file) => <div key={JSON.stringify([file.workspaceId, file.path])} className="flex min-w-0 items-center gap-3 rounded-xl border border-[var(--inno-border)] bg-[var(--inno-surface)] p-3">
			<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--inno-surface-muted)]"><FileTypeIcon kind={file.kind} size={20} /></div>
			<div className="min-w-0 flex-1">
				<Button variant="ghost" size="xs" className="max-w-full justify-start" title={file.path} onClick={() => { onOpen(file); rememberFileOpenPreference(file.path, { kind: "preview" }); }}><span className="truncate text-sm">{file.path.split("/").pop()}</span></Button>
				<div className="px-2 text-xs text-[var(--inno-text-muted)]">{file.type}</div>
			</div>
			<div className="shrink-0"><WorkspaceOpenWithMenu path={file.path} workspaceId={file.workspaceId} compact onOpenPreview={() => onOpen(file)} /></div>
		</div>)}
	</div>;
}
