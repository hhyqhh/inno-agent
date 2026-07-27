import { EventEmitter } from "./event-emitter.js";
import {
	listWikiPages,
	getWikiPage,
	updateWikiPage,
	updateWikiPageTags,
	deleteWikiPage,
	getWikiGraph,
	getWikiGraphNode,
	listWikiTags,
	regenerateSource,
} from "../api/wiki.js";
import type {
	WikiPageSummary,
	WikiPageType,
	WikiGraphNode,
	WikiGraphEdge,
	WikiGraphNodeDetail,
	WikiTagSummary,
} from "../types/wiki.js";

export type NotebookView = "graph" | "page";

interface NotebookStoreEvents {
	change: void;
}

class NotebookStoreImpl extends EventEmitter<NotebookStoreEvents> {
	pages: WikiPageSummary[] = [];
	nodes: WikiGraphNode[] = [];
	edges: WikiGraphEdge[] = [];
	tags: WikiTagSummary[] = [];
	selectedNodeDetail: WikiGraphNodeDetail | null = null;
	currentPage: { path: string; content: string } | null = null;
	isLoadingPages = false;
	isLoadingGraph = false;
	isLoadingNodeDetail = false;
	isLoadingPage = false;
	isEditing = false;
	isDeletingPage = false;
	deletingPagePath: string | null = null;
	isRegeneratingSource = false;
	regeneratingSourceId: string | null = null;
	editBuffer = "";
	filterType: WikiPageType | "all" = "all";
	searchQuery = "";
	selectedNodeId: string | null = null;
	view: NotebookView = "page";

	get filteredPages(): WikiPageSummary[] {
		let result = this.pages;
		if (this.filterType !== "all") {
			result = result.filter((p) => p.frontmatter?.type === this.filterType);
		}
		if (this.searchQuery) {
			const q = this.searchQuery.toLowerCase();
			result = result.filter(
				(p) =>
					(p.frontmatter?.title ?? "").toLowerCase().includes(q) ||
					(p.frontmatter?.tags ?? []).some((t) => t.toLowerCase().includes(q)) ||
					p.bodyPreview.toLowerCase().includes(q),
			);
		}
		return result;
	}

	get tagSummaries(): WikiTagSummary[] {
		let pages = this.pages;
		if (this.filterType !== "all") {
			pages = pages.filter((page) => page.frontmatter?.type === this.filterType);
		}
		const byKey = new Map<string, WikiTagSummary>();
		for (const page of pages) {
			for (const tag of page.frontmatter?.tags ?? []) {
				const displayName = tag.trim();
				if (!displayName) continue;
				const key = displayName.toLowerCase();
				const current = byKey.get(key);
				if (current) {
					current.usageCount += 1;
					current.displayName = displayName;
				} else {
					byKey.set(key, {
						id: key,
						canonicalKey: key,
						displayName,
						usageCount: 1,
						updatedAt: page.frontmatter?.updated ?? "",
					});
				}
			}
		}
		return [...byKey.values()].sort((a, b) => b.usageCount - a.usageCount || a.displayName.localeCompare(b.displayName, "zh-CN"));
	}

	get highlightSet(): Set<string> {
		if (!this.searchQuery) return new Set();
		const q = this.searchQuery.toLowerCase();
		return new Set(
			this.nodes
				.filter(
					(n) =>
						n.title.toLowerCase().includes(q) ||
						n.tags.some((t) => t.toLowerCase().includes(q)),
				)
				.map((n) => n.id),
		);
	}

	async loadAll(): Promise<void> {
		await Promise.all([this.loadPages(), this.loadGraph(), this.loadTags()]);
	}

	async loadPages(): Promise<void> {
		this.isLoadingPages = true;
		this.emit("change", undefined);
		try {
			this.pages = await listWikiPages();
		} catch {
			this.pages = [];
		} finally {
			this.isLoadingPages = false;
			this.emit("change", undefined);
		}
	}

	async loadGraph(): Promise<void> {
		this.isLoadingGraph = true;
		this.emit("change", undefined);
		try {
			const data = await getWikiGraph();
			this.nodes = data.nodes;
			this.edges = data.edges;
		} catch {
			this.nodes = [];
			this.edges = [];
		} finally {
			this.isLoadingGraph = false;
			this.emit("change", undefined);
		}
	}

	async selectPage(path: string, options: { switchView?: boolean } = {}): Promise<void> {
		this.isLoadingPage = true;
		this.isEditing = false;
		this.selectedNodeId = path;
		this.selectedNodeDetail = null;
		if (options.switchView !== false) {
			this.view = "page";
		}
		this.emit("change", undefined);
		try {
			const detail = await getWikiPage(path);
			this.currentPage = detail;
			this.editBuffer = detail.content;
		} catch {
			this.currentPage = null;
		} finally {
			this.isLoadingPage = false;
			this.emit("change", undefined);
		}
	}

	selectNode(id: string | null) {
		this.selectedNodeId = id;
		this.selectedNodeDetail = null;
		this.emit("change", undefined);
		if (id) {
			void this.loadNodeDetail(id);
		}
	}

	async loadNodeDetail(id: string): Promise<void> {
		this.isLoadingNodeDetail = true;
		this.emit("change", undefined);
		try {
			this.selectedNodeDetail = await getWikiGraphNode(id);
		} catch {
			this.selectedNodeDetail = null;
		} finally {
			this.isLoadingNodeDetail = false;
			this.emit("change", undefined);
		}
	}

	setView(view: NotebookView) {
		this.view = view;
		this.emit("change", undefined);
	}

	startEditing() {
		if (this.currentPage) {
			this.isEditing = true;
			this.editBuffer = this.currentPage.content;
			this.emit("change", undefined);
		}
	}

	updateEditBuffer(content: string) {
		this.editBuffer = content;
		this.emit("change", undefined);
	}

	cancelEditing() {
		this.isEditing = false;
		if (this.currentPage) {
			this.editBuffer = this.currentPage.content;
		}
		this.emit("change", undefined);
	}

	async savePage(): Promise<void> {
		if (!this.currentPage) return;
		this.isLoadingPage = true;
		this.emit("change", undefined);
		try {
			await updateWikiPage(this.currentPage.path, this.editBuffer);
			this.currentPage = { ...this.currentPage, content: this.editBuffer };
			this.isEditing = false;
			await Promise.all([this.loadPages(), this.loadGraph(), this.loadTags()]);
		} catch (err) {
			console.error("Failed to save wiki page:", err);
		} finally {
			this.isLoadingPage = false;
			this.emit("change", undefined);
		}
	}

	async deletePage(path: string): Promise<void> {
		this.isDeletingPage = true;
		this.deletingPagePath = path;
		this.emit("change", undefined);
		try {
			await deleteWikiPage(path);
			if (this.currentPage?.path === path) {
				this.currentPage = null;
				this.isEditing = false;
			}
			this.selectedNodeId = null;
			this.selectedNodeDetail = null;
			await Promise.all([this.loadPages(), this.loadGraph(), this.loadTags()]);
		} catch (err) {
			console.error("Failed to delete wiki page:", err);
			throw err;
		} finally {
			this.isDeletingPage = false;
			this.deletingPagePath = null;
			this.emit("change", undefined);
		}
	}

	async loadTags(): Promise<void> {
		try {
			this.tags = await listWikiTags();
		} catch {
			this.tags = [];
		} finally {
			this.emit("change", undefined);
		}
	}

	async regenerateSource(sourceId: string): Promise<void> {
		const currentPath = this.currentPage?.path ?? null;
		this.isRegeneratingSource = true;
		this.regeneratingSourceId = sourceId;
		this.emit("change", undefined);
		try {
			const result = await regenerateSource(sourceId);
			await Promise.all([this.loadPages(), this.loadGraph(), this.loadTags()]);
			await this.selectPage(result.wikiPagePath || currentPath || "", { switchView: false });
		} catch (err) {
			console.error("Failed to regenerate source:", err);
			throw err;
		} finally {
			this.isRegeneratingSource = false;
			this.regeneratingSourceId = null;
			this.emit("change", undefined);
		}
	}

	setFilterType(type: WikiPageType | "all") {
		this.filterType = type;
		this.emit("change", undefined);
	}

	searchByTag(tag: string): void {
		this.searchQuery = tag;
		this.emit("change", undefined);
	}

	async updateCurrentPageTags(tags: string[]): Promise<void> {
		if (!this.currentPage) return;
		await this.updatePageTags(this.currentPage.path, tags);
	}

	async updatePageTags(path: string, tags: string[]): Promise<void> {
		await updateWikiPageTags(path, tags);
		if (this.currentPage?.path === path) {
			await this.selectPage(path, { switchView: false });
		}
		await Promise.all([this.loadPages(), this.loadGraph(), this.loadTags()]);
		if (this.selectedNodeId) {
			await this.loadNodeDetail(this.selectedNodeId);
		}
	}

	setSearchQuery(query: string) {
		this.searchQuery = query;
		this.emit("change", undefined);
	}
}

export const notebookStore = new NotebookStoreImpl();
