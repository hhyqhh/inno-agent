import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { FileCode2, FileText, Image, LoaderCircle, Sparkles } from "lucide-react";
import { workspaceStore } from "../stores/workspace-store.js";
import { useStoreSnapshot } from "./hooks.js";
import { Tabs, getTabTriggerId } from "./ui/index.js";

export const WORKSPACE_PREVIEW_TABS_ID = "workspace-previews";
export const STREAMING_PREVIEW_TAB = "__generated-preview__";

export function WorkspacePreviewTabs() {
	const { t } = useTranslation();
	const root = useRef<HTMLDivElement>(null);
	const state = useStoreSnapshot(workspaceStore, () => ({ tabs: workspaceStore.previewTabs, active: workspaceStore.activePreviewPath, stream: workspaceStore.streamingPreview }));
	const value = state.stream ? STREAMING_PREVIEW_TAB : state.active ?? "";
	useEffect(() => {
		root.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
	}, [value, state.tabs.length]);
	const close = (path: string) => {
		workspaceStore.closePreview(path);
		requestAnimationFrame(() => {
			const next = workspaceStore.streamingPreview ? STREAMING_PREVIEW_TAB : workspaceStore.activePreviewPath;
			if (next) document.getElementById(getTabTriggerId(WORKSPACE_PREVIEW_TABS_ID, next))?.focus({ preventScroll: true });
			else document.querySelector<HTMLElement>(".inno-window-chrome-workspace-button")?.focus({ preventScroll: true });
		});
	};
	return (
		<div className="inno-workspace-tabs" ref={root}>
			<Tabs
				id={WORKSPACE_PREVIEW_TABS_ID}
				ariaLabel={t("files.previewTabs")}
				variant="browser"
				value={value}
				onValueChange={(path) => { if (path !== STREAMING_PREVIEW_TAB) void workspaceStore.selectFile(path); }}
				items={[
					...state.tabs.map((tab) => {
						const Icon = tab.isLoading ? LoaderCircle : /\.(png|jpe?g|gif|webp|svg)$/i.test(tab.name) ? Image : /\.(tsx?|jsx?|py|json|css|sh|yaml|sql)$/i.test(tab.name) ? FileCode2 : FileText;
						const dirty = tab.isEditing && tab.editBuffer !== (tab.file?.content ?? "");
						return {
							value: tab.path,
							ariaLabel: tab.name,
							title: tab.path,
							label: <><Icon size={14} className={tab.isLoading ? "animate-spin" : ""} /><span className="truncate">{tab.name}</span>{dirty ? <span className="inno-workspace-tab-dirty" aria-label={t("files.unsavedChanges")}>•</span> : null}</>,
							close: { label: t("files.closePreview", { name: tab.name }), onClose: () => close(tab.path) },
						};
					}),
					...(state.stream ? [{ value: STREAMING_PREVIEW_TAB, ariaLabel: state.stream.title, label: <><Sparkles size={14} /><span className="truncate">{state.stream.title}</span></>, close: { label: t("files.closePreview", { name: state.stream.title }), onClose: () => workspaceStore.clearStreamingPreview() } }] : []),
				]}
			/>
		</div>
	);
}
