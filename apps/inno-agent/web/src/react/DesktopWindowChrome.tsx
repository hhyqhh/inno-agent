import type { ReactNode } from "react";
import { ArrowLeft, ArrowRight, Maximize2, Minimize2, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, SquarePen } from "lucide-react";
import { IconButton, Tooltip } from "./ui/index.js";
import type { WorkspaceMode } from "../stores/app-store.js";

interface DesktopWindowChromeProps {
	showWorkspaceControl: boolean;
	showSidebarControl: boolean;
	showNewChatControl: boolean;
	showChatHeader: boolean;
	hasOpenConversation?: boolean;
	isDesktopWindow: boolean;
	sidebarCollapsed: boolean;
	newChatLabel: string;
	sidebarExpandLabel: string;
	sidebarCollapseLabel: string;
	workspaceCollapsed: boolean;
	workspaceOpenLabel: string;
	workspaceCollapseLabel: string;
	backLabel: string;
	forwardLabel: string;
	canNavigateBack: boolean;
	canNavigateForward: boolean;
	btwControl?: ReactNode;
	terminalControl?: ReactNode;
	workspaceTabs?: ReactNode;
	workspaceMode?: WorkspaceMode;
	workspaceFullLabel?: string;
	workspaceRestoreLabel?: string;
	onWorkspaceModeChange?: (mode: WorkspaceMode) => void;
	onHeaderHostChange?: (host: HTMLDivElement | null) => void;
	onToggleSidebar: () => void;
	onNewChat: () => void;
	onNavigateBack: () => void;
	onNavigateForward: () => void;
	onToggleWorkspace: () => void;
}

/**
 * Renderer-owned desktop toolbar. macOS keeps its traffic lights in the
 * hidden native title bar; Windows keeps its standard native title bar above
 * this toolbar. Browser layouts keep their local chat header.
 */
export function DesktopWindowChrome({
	showWorkspaceControl,
	showSidebarControl,
	showNewChatControl,
	showChatHeader,
	hasOpenConversation = false,
	isDesktopWindow,
	sidebarCollapsed,
	newChatLabel,
	sidebarExpandLabel,
	sidebarCollapseLabel,
	workspaceCollapsed,
	workspaceOpenLabel,
	workspaceCollapseLabel,
	backLabel,
	forwardLabel,
	canNavigateBack,
	canNavigateForward,
	btwControl,
	terminalControl,
	workspaceTabs,
	workspaceMode,
	workspaceFullLabel,
	workspaceRestoreLabel,
	onWorkspaceModeChange,
	onHeaderHostChange,
	onToggleSidebar,
	onNewChat,
	onNavigateBack,
	onNavigateForward,
	onToggleWorkspace,
}: DesktopWindowChromeProps) {
	const showSidebarToggle = isDesktopWindow ? showSidebarControl : sidebarCollapsed;
	const showNavigationControls = isDesktopWindow;

	return (
		<div className={`inno-window-chrome${showNewChatControl ? " has-new-chat-control" : ""}${hasOpenConversation ? " has-conversation-tabs" : ""}`} aria-label="窗口工具栏">
			{isDesktopWindow && showChatHeader ? (
				<>
					<div className="inno-window-chrome-chat-header" ref={onHeaderHostChange} />
					<div className="inno-window-chrome-divider" aria-hidden="true" />
				</>
			) : null}
			{showNavigationControls || showSidebarToggle ? (
				<div className="inno-window-chrome-bar">
					{showNavigationControls ? (
						<>
							<Tooltip label={backLabel} side="bottom">
								<button type="button" className="inno-window-chrome-button" aria-label={backLabel} disabled={!canNavigateBack} onClick={onNavigateBack}>
									<ArrowLeft size={15} />
								</button>
							</Tooltip>
							<Tooltip label={forwardLabel} side="bottom">
								<button type="button" className="inno-window-chrome-button" aria-label={forwardLabel} disabled={!canNavigateForward} onClick={onNavigateForward}>
									<ArrowRight size={15} />
								</button>
							</Tooltip>
						</>
					) : null}
					{showSidebarToggle ? (
						<Tooltip label={sidebarCollapsed ? sidebarExpandLabel : sidebarCollapseLabel} side="bottom">
							<button
								type="button"
								className="inno-window-chrome-button"
								aria-label={sidebarCollapsed ? sidebarExpandLabel : sidebarCollapseLabel}
								aria-controls="session-sidebar"
								aria-expanded={!sidebarCollapsed}
								onClick={onToggleSidebar}
							>
								{sidebarCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
							</button>
						</Tooltip>
					) : null}
					{showNewChatControl ? (
						<Tooltip label={newChatLabel} side="bottom">
							<button type="button" className="inno-window-chrome-button" aria-label={newChatLabel} onClick={onNewChat}>
								<SquarePen size={15} />
							</button>
						</Tooltip>
					) : null}
				</div>
			) : null}
			{btwControl ? (
				<div className="inno-window-chrome-right-actions">
					{btwControl}
				</div>
			) : null}
			{isDesktopWindow && showWorkspaceControl && workspaceMode ? (
				<>
					{/* A sibling plate can sit below every moving control; painting it
					    on the tab track covered the earlier question/terminal buttons. */}
					<div className="inno-window-chrome-drag-plate" aria-hidden="true" />
					<div className="inno-window-chrome-preview-terminal">{terminalControl}</div>
					{/* The track is a plain box: its left/right insets tween through CSS
					    on the sidebar grid's curve. Motion projection here measured its
					    snapshot at the START of each toggle, so the next toggle projected
					    the full distance in reverse, pinning the visual at the old
					    position while the CSS tween ran underneath — and the inner
					    viewport's clamped scrollLeft clipped the first tab's leading
					    characters at rest.*/}
					<div className="inno-window-chrome-preview-tabs">
						{/* A single moving track keeps the separator and tabs together
						    throughout maximize/restore, including the welcome screen. */}
						<div className="inno-window-chrome-preview-divider" aria-hidden="true" />
						<div className="inno-window-chrome-preview-tab-content" aria-hidden={workspaceCollapsed || undefined} inert={workspaceCollapsed || undefined}>
							{workspaceTabs}
						</div>
					</div>
					{!workspaceCollapsed ? <IconButton
						size="xs"
						className="inno-window-chrome-preview-fullscreen"
						title={workspaceMode === "full" ? workspaceRestoreLabel ?? "Restore preview" : workspaceFullLabel ?? "Maximize preview"}
						aria-label={workspaceMode === "full" ? workspaceRestoreLabel ?? "Restore preview" : workspaceFullLabel ?? "Maximize preview"}
						aria-pressed={workspaceMode === "full"}
						onClick={() => onWorkspaceModeChange?.(workspaceMode === "full" ? "half" : "full")}
					>
						{workspaceMode === "full" ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
					</IconButton> : null}
				</>
			) : null}
			{/* Keep workspace visibility in the upper toolbar so opening and closing
			    stay in the same place in split and full views. */}
			{showWorkspaceControl ? (
				<Tooltip label={workspaceCollapsed ? workspaceOpenLabel : workspaceCollapseLabel} side="bottom">
					<button
						type="button"
						className="inno-window-chrome-button inno-window-chrome-workspace-button"
						aria-label={workspaceCollapsed ? workspaceOpenLabel : workspaceCollapseLabel}
						aria-expanded={!workspaceCollapsed}
						onClick={onToggleWorkspace}
					>
						{workspaceCollapsed ? <PanelRightOpen size={15} /> : <PanelRightClose size={15} />}
					</button>
				</Tooltip>
			) : null}
		</div>
	);
}
