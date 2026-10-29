import type { ReactNode } from "react";
import { FolderOpen, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { IconButton, Tooltip } from "./ui/index.js";
import { FileName } from "./FileName.js";

/**
 * Single concise file bar under the preview tab strip. Shared by the plain
 * preview/text-edit toolbar and the DOCX editor so both modes render one
 * identical bar: name + containing-folder hint on the left, mode actions on
 * the right. No filename/size subtitle — the tab strip and the tooltip on the
 * folder icon already carry that context.
 */
export function WorkspaceFileBar({ name, path, onToggleSidebar, sidebarOpen, children }: {
	name: string;
	path?: string;
	onToggleSidebar?: () => void;
	sidebarOpen?: boolean;
	children?: ReactNode;
}) {
	const { t } = useTranslation();
	return (
		<div className="inno-workspace-content-toolbar inno-workspace-filebar flex h-10 shrink-0 items-center justify-between gap-2 border-b border-[var(--inno-border)] bg-[var(--inno-surface)] px-3">
			<div className="flex min-w-0 flex-1 items-center gap-2">
				{onToggleSidebar ? <IconButton
					size="xs"
					className="inno-workspace-pane-toggle shrink-0"
					onClick={onToggleSidebar}
					title={sidebarOpen ? t("common.collapseSidebar", "收起侧栏") : t("common.expandSidebar", "展开侧栏")}
					aria-label={sidebarOpen ? t("common.collapseSidebar", "收起侧栏") : t("common.expandSidebar", "展开侧栏")}
				>
					{sidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
				</IconButton> : null}
				<FileName name={name} className="min-w-0 text-sm font-medium" title={name} />
				{path ? (
					<Tooltip label={path}>
						<span className="inno-workspace-filebar-folder flex shrink-0 items-center text-[var(--inno-text-subtle)]" aria-hidden="true">
							<FolderOpen size={14} />
						</span>
					</Tooltip>
				) : null}
			</div>
			<div className="inno-workspace-filebar-actions flex shrink-0 items-center gap-1.5">{children}</div>
		</div>
	);
}
