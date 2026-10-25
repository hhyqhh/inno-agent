import { useEffect, useRef, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { FileCode2, FileText, Image, LoaderCircle, Plus, Sparkles, FolderOpen, MessageSquare } from "lucide-react";
import { workspaceStore, WORKSPACE_START_TAB, WORKSPACE_CONVERSATION_TAB, previewTabKey } from "../stores/workspace-store.js";
import { workspacesStore } from "../stores/workspaces-store.js";
import { appStore } from "../stores/app-store.js";
import { sessionsStore } from "../stores/sessions-store.js";
import { chatStore } from "../stores/chat-store.js";
import { getConversationTitle } from "./chat/conversation-title.js";
import { useStoreSnapshot } from "./hooks.js";
import { ContextMenu, IconButton, Tabs, focusWithoutTooltip, getTabTriggerId, type ContextMenuItem } from "./ui/index.js";

export const WORKSPACE_PREVIEW_TABS_ID = "workspace-previews";
export const STREAMING_PREVIEW_TAB = "__generated-preview__";

export function WorkspacePreviewTabs() {
	const { t } = useTranslation();
	const root = useRef<HTMLDivElement>(null);
	const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; path: string } | null>(null);
	const state = useStoreSnapshot(workspaceStore, () => ({ tabs: workspaceStore.previewTabs, active: workspaceStore.activePreviewPath, stream: workspaceStore.streamingPreview, surface: workspaceStore.activeSurface }));
	const mode = useStoreSnapshot(appStore, () => appStore.workspaceMode);
	const workspaces = useStoreSnapshot(workspacesStore, () => workspacesStore.workspaces);
	const session = useStoreSnapshot(sessionsStore, () => ({ id: sessionsStore.currentSessionId, welcome: sessionsStore.isWelcomeView, meta: sessionsStore.sessions.find((item) => item.id === sessionsStore.currentSessionId), opening: sessionsStore.openingSessionId }));
	const messages = useStoreSnapshot(chatStore, () => chatStore.messages);
	const hasConversation = Boolean(session.id) && !session.welcome;
	const conversationTab = mode === "full" && hasConversation;
	const title = getConversationTitle(messages, session.meta?.name, session.meta?.hasTopic === true || session.opening === session.id, t("nav.newChat"));
	const value = conversationTab && state.surface === "conversation" ? WORKSPACE_CONVERSATION_TAB : state.stream ? STREAMING_PREVIEW_TAB : state.active ?? "";
	useEffect(() => {
		if (mode !== "full" || !hasConversation) workspaceStore.setActiveSurface("preview");
	}, [mode, hasConversation]);
	useEffect(() => {
		root.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
	}, [value, state.tabs.length]);
	const close = (path: string) => {
		workspaceStore.closePreview(path);
		if (!workspaceStore.previewTabs.length && !workspaceStore.streamingPreview) {
			// Only closing the final start page collapses the panel. Closing the
			// final file returns to a useful start page, preserving the split view.
			if (path === WORKSPACE_START_TAB) appStore.setWorkspaceMode("collapsed");
			else workspaceStore.openStartPage();
		}
		requestAnimationFrame(() => {
			const next = appStore.workspaceMode === "full" && hasConversation && workspaceStore.activeSurface === "conversation" ? WORKSPACE_CONVERSATION_TAB : workspaceStore.streamingPreview ? STREAMING_PREVIEW_TAB : workspaceStore.activePreviewPath;
			focusWithoutTooltip(next ? document.getElementById(getTabTriggerId(WORKSPACE_PREVIEW_TABS_ID, next))
				: document.querySelector<HTMLElement>(".inno-window-chrome-workspace-button"));
		});
	};
	const openMenu = (event: MouseEvent, path: string) => {
		event.preventDefault();
		event.stopPropagation();
		setCtxMenu({ x: event.clientX, y: event.clientY, path });
	};
	const menuItems = (): ContextMenuItem[] => {
		if (!ctxMenu) return [];
		const items: ContextMenuItem[] = [];
		if (ctxMenu.path === STREAMING_PREVIEW_TAB) {
			items.push({ label: t("files.closePreview", { name: state.stream?.title ?? "" }), onSelect: () => workspaceStore.clearStreamingPreview() });
		} else {
			const tab = state.tabs.find((item) => previewTabKey(item) === ctxMenu.path);
			if (!tab) return [];
			const index = state.tabs.indexOf(tab);
			items.push({ label: t("files.closePreview", { name: tab.path === WORKSPACE_START_TAB ? t("workspaceStart.tab") : tab.name }), onSelect: () => close(previewTabKey(tab)) });
			if (state.tabs.length > 1) items.push({ label: t("files.closeOtherTabs"), onSelect: () => workspaceStore.closeOtherPreviews(previewTabKey(tab)) });
			if (index < state.tabs.length - 1) items.push({ label: t("files.closeTabsToRight"), onSelect: () => workspaceStore.closePreviewsToRight(previewTabKey(tab)) });
		}
		if (state.tabs.length > 0) items.push({ label: t("files.closeAllTabs"), onSelect: () => {
			const onlyStartPage = state.tabs.length === 1 && state.tabs[0].path === WORKSPACE_START_TAB;
			workspaceStore.closeAllPreviews();
			if (!workspaceStore.streamingPreview) {
				if (onlyStartPage) appStore.setWorkspaceMode("collapsed");
				else workspaceStore.openStartPage();
			}
		} });
		return items;
	};
	return (
		<div className="inno-workspace-tabs" ref={root}>
			<Tabs
				className="inno-workspace-tabs-strip"
				id={WORKSPACE_PREVIEW_TABS_ID}
				ariaLabel={t("files.previewTabs")}
				variant="browser"
				animateLayout={hasConversation}
				value={value}
				onValueChange={(path) => {
					if (path === WORKSPACE_CONVERSATION_TAB) { workspaceStore.setActiveSurface("conversation"); return; }
					if (path === STREAMING_PREVIEW_TAB) { workspaceStore.setActiveSurface("preview"); return; }
					if (path === WORKSPACE_START_TAB) { workspaceStore.openStartPage(); return; }
					// Switching loaded tabs keeps their previews stable. Explicit file
					// opens use selectFile to revalidate content after external writes.
					const tab = workspaceStore.previewTabs.find((tab) => previewTabKey(tab) === path);
					if (tab?.file) workspaceStore.activatePreview(path);
					else if (tab) void workspaceStore.selectFile(tab.path, undefined, tab.workspaceId ?? null);
				}}
				items={[
					...(conversationTab ? [{ value: WORKSPACE_CONVERSATION_TAB, ariaLabel: title, title: `${t("nav.chat")} · ${title}`, label: <><MessageSquare size={14} /><span className="truncate">{title}</span></>, panelId: "workspace-conversation-panel", layoutId: "inno-conversation-title", className: "inno-workspace-conversation-tab" }] : []),
					...state.tabs.map((tab) => {
						const isStart = tab.path === WORKSPACE_START_TAB;
						const name = isStart ? t("workspaceStart.tab") : tab.name;
						const Icon = tab.isLoading ? LoaderCircle : /\.(png|jpe?g|gif|webp|svg)$/i.test(tab.name) ? Image : /\.(tsx?|jsx?|py|json|css|sh|yaml|sql)$/i.test(tab.name) ? FileCode2 : FileText;
						const dirty = tab.isEditing && tab.editBuffer !== (tab.file?.content ?? "");
						const key = previewTabKey(tab);
						const workspaceName = workspaces.find((workspace) => workspace.id === tab.workspaceId)?.name ?? t("workspace.tempWorkspaceLabel");
						const duplicateName = state.tabs.some((other) => other !== tab && other.name === tab.name);
						return {
							value: key,
							ariaLabel: duplicateName ? `${name} · ${workspaceName}` : name,
							title: isStart ? name : `${workspaceName} / ${tab.path}`,
							label: <>{isStart ? <FolderOpen size={14} /> : <Icon size={14} className={tab.isLoading ? "animate-spin" : ""} />}<span className="truncate">{name}</span>{dirty ? <span className="inno-workspace-tab-dirty" aria-label={t("files.unsavedChanges")}>•</span> : null}</>,
							close: { label: t("files.closePreview", { name }), onClose: () => close(key) },
							onContextMenu: (event: MouseEvent) => openMenu(event, key),
						};
					}),
					...(state.stream ? [{ value: STREAMING_PREVIEW_TAB, ariaLabel: state.stream.title, label: <><Sparkles size={14} /><span className="truncate">{state.stream.title}</span></>, close: { label: t("files.closePreview", { name: state.stream.title }), onClose: () => workspaceStore.clearStreamingPreview() }, onContextMenu: (event: MouseEvent) => openMenu(event, STREAMING_PREVIEW_TAB) }] : []),
				]}
			/>
			<IconButton size="xs" className="shrink-0" title={t("workspaceStart.open")} aria-label={t("workspaceStart.open")} onClick={() => workspaceStore.openStartPage()}><Plus size={16} /></IconButton>
			{ctxMenu && <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={menuItems()} onClose={() => setCtxMenu(null)} />}
		</div>
	);
}
