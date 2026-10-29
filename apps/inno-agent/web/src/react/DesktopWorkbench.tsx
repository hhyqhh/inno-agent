import { useState, type CSSProperties, type ReactNode } from "react";
import type { WorkspaceMode } from "../stores/app-store.js";
import { getEffectiveWorkspaceWidth } from "../stores/app-layout.js";
import { WORKSPACE_CONVERSATION_TAB } from "../stores/workspace-store.js";
import { getTabTriggerId } from "./ui/index.js";
import { WORKSPACE_PREVIEW_TABS_ID } from "./WorkspacePreviewTabs.js";

interface DesktopWorkbenchProps {
	mode: WorkspaceMode;
	workspaceWidth: number;
	chatContent: ReactNode;
	workspaceContent?: ReactNode;
	conversationActive?: boolean;
}

export function DesktopWorkbench({ mode, workspaceWidth, chatContent, workspaceContent, conversationActive = false }: DesktopWorkbenchProps) {
	const [chatMode, setChatMode] = useState<Exclude<WorkspaceMode, "full">>(mode === "full" ? "half" : mode);
	if (mode !== "full" && mode !== chatMode) setChatMode(mode);
	const full = mode === "full";
	const [chatExpanded, setChatExpanded] = useState(full && conversationActive);
	if (full && conversationActive && !chatExpanded) setChatExpanded(true);
	if (!full && chatExpanded) setChatExpanded(false);
	// The old flex layout squeezed/reflowed every chat frame while maximizing.
	// Retain the split width so the preview covers intact content, like sidebar clipping.
	const reservedWidth = chatMode === "collapsed" || (full && chatExpanded) ? 0 : Math.max(0, getEffectiveWorkspaceWidth(workspaceWidth, chatMode) - 3);
	const showConversation = full && conversationActive;
	const chatHidden = full && !showConversation;
	return (
		<div className={`inno-desktop-workbench${showConversation ? " is-conversation-active" : ""}`} style={{ "--inno-chat-reserved-width": `${reservedWidth}px` } as CSSProperties}>
			<main id="workspace-conversation-panel" role={showConversation ? "tabpanel" : undefined} aria-labelledby={showConversation ? getTabTriggerId(WORKSPACE_PREVIEW_TABS_ID, WORKSPACE_CONVERSATION_TAB) : undefined} className="inno-desktop-chat-content" aria-hidden={chatHidden || undefined} inert={chatHidden}>
				{chatContent}
			</main>
			{workspaceContent}
		</div>
	);
}
