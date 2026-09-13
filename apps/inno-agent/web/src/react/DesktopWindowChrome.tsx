import type { ReactNode } from "react";
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";

interface DesktopWindowChromeProps {
	showSidebarControl: boolean;
	showWorkspaceControl: boolean;
	sidebarCollapsed: boolean;
	workspaceCollapsed: boolean;
	btwControl?: ReactNode;
	onToggleSidebar: () => void;
	onToggleWorkspace: () => void;
}

/**
 * Renderer-owned macOS window chrome. Electron keeps the traffic lights in
 * the hidden title-bar area; the overlay is limited to the renderer control
 * so the page headers below remain reliable drag surfaces and click targets.
 */
export function DesktopWindowChrome({
	showSidebarControl,
	showWorkspaceControl,
	sidebarCollapsed,
	workspaceCollapsed,
	btwControl,
	onToggleSidebar,
	onToggleWorkspace,
}: DesktopWindowChromeProps) {
	return (
		<div className="inno-window-chrome" aria-label="窗口工具栏">
			{showSidebarControl ? (
				<div className="inno-window-chrome-bar">
					<button
						type="button"
						className="inno-window-chrome-button"
						title={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
						aria-label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
						onClick={onToggleSidebar}
					>
						{sidebarCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
					</button>
				</div>
			) : null}
			{btwControl ? (
				<div className="inno-window-chrome-right-actions">
					{btwControl}
				</div>
			) : null}
			{showWorkspaceControl ? (
				<button
					type="button"
					className="inno-window-chrome-button inno-window-chrome-workspace-button"
					title={workspaceCollapsed ? "打开工作区" : "收起工作区"}
					aria-label={workspaceCollapsed ? "打开工作区" : "收起工作区"}
					aria-pressed={!workspaceCollapsed}
					onClick={onToggleWorkspace}
				>
					{workspaceCollapsed ? <PanelRightOpen size={15} /> : <PanelRightClose size={15} />}
				</button>
			) : null}
		</div>
	);
}
