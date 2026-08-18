import { EventEmitter } from "./event-emitter.js";
import {
	listWikiPages,
	getWikiPage,
	updateWikiPage,
	updateWikiPageTags,
	deleteWikiPage,
	getWikiGraph,
	listWikiTags,
	regenerateSource,
} from "../api/wiki.js";
import type {
	WikiPageSummary,
	WikiPageType,
	WikiGraphNode,
	WikiGraphEdge,
	WikiGraphCommunities,
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
	communities: WikiGraphCommunities | null = null;
	currentPage: { path: string; content: string } | null = null;
	isLoadingPages = false;
	isLoadingGraph = false;
	isLoadingPage = false;
	isEditing = false;
	isDeletingPage = false;
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
			this.communities = data.communities ?? null;
		} catch {
			this.nodes = [];
			this.edges = [];
			this.communities = null;
		} finally {
			this.isLoadingGraph = false;
			this.emit("change", undefined);
		}
	}

	async selectPage(path: string, options: { switchView?: boolean } = {}): Promise<void> {
		this.isLoadingPage = true;
		this.isEditing = false;
		this.selectedNodeId = path;
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
		this.emit("change", undefined);
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
		this.emit("change", undefined);
		try {
			await deleteWikiPage(path);
			if (this.currentPage?.path === path) {
				this.currentPage = null;
				this.isEditing = false;
			}
			this.selectedNodeId = null;
			await Promise.all([this.loadPages(), this.loadGraph(), this.loadTags()]);
		} catch (err) {
			console.error("Failed to delete wiki page:", err);
			throw err;
		} finally {
			this.isDeletingPage = false;
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
	}

	async regenerateSource(sourceId: string): Promise<void> {
		const currentPath = this.currentPage?.path ?? null;
		this.isRegeneratingSource = true;
		this.regeneratingSourceId = sourceId;
		this.emit("change", undefined);
		try {
			const result = await regenerateSource(sourceId);
			await Promise.all([this.loadPages(), this.loadGraph(), this.loadTags()]);
			const nextPath = result.wikiPagePath || currentPath;
			if (nextPath) await this.selectPage(nextPath, { switchView: false });
		} finally {
			this.isRegeneratingSource = false;
			this.regeneratingSourceId = null;
			this.emit("change", undefined);
		}
	}

	searchByTag(tag: string): void {
		this.searchQuery = tag;
		this.emit("change", undefined);
	}

	setFilterType(type: WikiPageType | "all") {
		this.filterType = type;
		this.emit("change", undefined);
	}

	setSearchQuery(query: string) {
		this.searchQuery = query;
		this.emit("change", undefined);
	}
}

export const notebookStore = new NotebookStoreImpl();
