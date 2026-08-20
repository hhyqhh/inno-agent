import { EventEmitter } from "./event-emitter.js";
import {
	listWikiPages,
	getWikiPage,
	updateWikiPage,
	deleteWikiPage,
	getWikiGraph,
	refreshPageEvidence as requestEvidenceRefresh,
	removeStalePageEvidence as requestStaleEvidenceRemoval,
} from "../api/wiki.js";
import type {
	WikiPageSummary,
	WikiPageType,
	WikiGraphNode,
	WikiGraphEdge,
	WikiGraphCommunities,
	WikiPageDetail,
} from "../types/wiki.js";

export type NotebookView = "graph" | "page";

interface NotebookStoreEvents {
	change: void;
}

export class NotebookStoreImpl extends EventEmitter<NotebookStoreEvents> {
	private evidenceMutationToken = 0;
	private pageRequestToken = 0;
	pages: WikiPageSummary[] = [];
	nodes: WikiGraphNode[] = [];
	edges: WikiGraphEdge[] = [];
	communities: WikiGraphCommunities | null = null;
	currentPage: WikiPageDetail | null = null;
	isLoadingPages = false;
	isLoadingGraph = false;
	isLoadingPage = false;
	isEditing = false;
	isDeletingPage = false;
	pageLoadError: string | null = null;
	saveError: string | null = null;
	mutationError: string | null = null;
	isRefreshingEvidence = false;
	isRemovingStaleEvidence = false;
	editBuffer = "";
	filterType: WikiPageType | "all" = "all";
	searchQuery = "";
	selectedNodeId: string | null = null;
	view: NotebookView = "page";

	get mutationPending(): boolean {
		return this.isRefreshingEvidence || this.isRemovingStaleEvidence;
	}

	get mutationKind(): "refresh" | "remove-stale" | null {
		if (this.isRefreshingEvidence) return "refresh";
		if (this.isRemovingStaleEvidence) return "remove-stale";
		return null;
	}

	private retireEvidenceMutation(): void {
		this.evidenceMutationToken += 1;
		this.isRefreshingEvidence = false;
		this.isRemovingStaleEvidence = false;
	}

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
		await Promise.all([this.loadPages(), this.loadGraph()]);
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

	async selectPage(path: string, options: { switchView?: boolean; preserveCurrentOnError?: boolean } = {}): Promise<WikiPageDetail | undefined> {
		const requestToken = ++this.pageRequestToken;
		const previousPage = this.currentPage;
		const previousEditBuffer = this.editBuffer;
		const previousIsEditing = this.isEditing;
		const previousSelectedNodeId = this.selectedNodeId;
		this.retireEvidenceMutation();
		this.isLoadingPage = true;
		this.isEditing = false;
		this.pageLoadError = null;
		this.saveError = null;
		this.mutationError = null;
		this.selectedNodeId = path;
		if (options.switchView !== false) {
			this.view = "page";
		}
		this.emit("change", undefined);
		try {
			const detail = await getWikiPage(path);
			if (requestToken !== this.pageRequestToken) return;
			this.currentPage = detail;
			this.editBuffer = detail.content;
			return detail;
		} catch (error) {
			if (requestToken !== this.pageRequestToken) return;
			if (options.preserveCurrentOnError) {
				this.currentPage = previousPage;
				this.editBuffer = previousEditBuffer;
				this.isEditing = previousIsEditing;
				this.selectedNodeId = previousSelectedNodeId;
			} else {
				this.currentPage = null;
			}
			this.pageLoadError = displayError(error, "Failed to load wiki page");
		} finally {
			if (requestToken !== this.pageRequestToken) return;
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
		if (this.currentPage && !this.mutationPending) {
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
		this.saveError = null;
		this.emit("change", undefined);
		try {
			const detail = await updateWikiPage(this.currentPage.path, this.editBuffer);
			this.currentPage = detail;
			this.editBuffer = detail.content;
			this.isEditing = false;
			await Promise.all([this.loadPages(), this.loadGraph()]);
		} catch (err) {
			console.error("Failed to save wiki page:", err);
			this.saveError = displayError(err);
		} finally {
			this.isLoadingPage = false;
			this.emit("change", undefined);
		}
	}

	private async runEvidenceMutation(
		kind: "refresh" | "remove-stale",
	): Promise<WikiPageDetail | undefined> {
		const page = this.currentPage;
		if (!page) {
			this.mutationError = "Select a wiki page before updating evidence.";
			this.emit("change", undefined);
			return undefined;
		}
		if (!page.pageRevision || !page.fileRevision) {
			this.mutationError = "Page revisions are unavailable; reload the page before updating evidence.";
			this.emit("change", undefined);
			return undefined;
		}
		if (this.isEditing) {
			this.mutationError = "Finish editing before updating evidence references.";
			this.emit("change", undefined);
			return undefined;
		}
		if (this.mutationPending) return undefined;

		const request = {
			path: page.path,
			expectedPageRevision: page.pageRevision,
			expectedFileRevision: page.fileRevision,
		};
		const originalPath = page.path;
		const originalPageRevision = page.pageRevision;
		const originalFileRevision = page.fileRevision;
		const mutationToken = ++this.evidenceMutationToken;
		this.mutationError = null;
		if (kind === "refresh") this.isRefreshingEvidence = true;
		else this.isRemovingStaleEvidence = true;
		this.emit("change", undefined);

		try {
			const detail = kind === "refresh"
				? await requestEvidenceRefresh(request)
				: await requestStaleEvidenceRemoval(request);
			// A response for a page that has since been switched away must not
			// replace the newly selected page.
			if (
				this.evidenceMutationToken === mutationToken
				&& this.currentPage?.path === originalPath
				&& this.currentPage.pageRevision === originalPageRevision
				&& this.currentPage.fileRevision === originalFileRevision
			) {
				this.currentPage = detail;
				this.editBuffer = detail.content;
			}
			return detail;
		} catch (error) {
			if (
				this.evidenceMutationToken === mutationToken
				&& this.currentPage?.path === originalPath
				&& this.currentPage.pageRevision === originalPageRevision
				&& this.currentPage.fileRevision === originalFileRevision
			) {
				this.mutationError = displayError(error, "Failed to update evidence references");
			}
			return undefined;
		} finally {
			if (this.evidenceMutationToken === mutationToken) {
				if (kind === "refresh") this.isRefreshingEvidence = false;
				else this.isRemovingStaleEvidence = false;
				this.emit("change", undefined);
			}
		}
	}

	async refreshEvidence(): Promise<WikiPageDetail | undefined> {
		return this.runEvidenceMutation("refresh");
	}

	async removeStaleEvidence(): Promise<WikiPageDetail | undefined> {
		return this.runEvidenceMutation("remove-stale");
	}

	/** Explicit aliases make the action names unambiguous to callers. */
	async refreshPageEvidence(): Promise<WikiPageDetail | undefined> {
		return this.refreshEvidence();
	}

	async removeStalePageEvidence(): Promise<WikiPageDetail | undefined> {
		return this.removeStaleEvidence();
	}

	async deletePage(path: string): Promise<void> {
		this.retireEvidenceMutation();
		this.mutationError = null;
		this.isDeletingPage = true;
		this.emit("change", undefined);
		try {
			await deleteWikiPage(path);
			if (this.currentPage?.path === path) {
				this.currentPage = null;
				this.isEditing = false;
			}
			this.selectedNodeId = null;
			await Promise.all([this.loadPages(), this.loadGraph()]);
		} catch (err) {
			console.error("Failed to delete wiki page:", err);
			throw err;
		} finally {
			this.isDeletingPage = false;
			this.emit("change", undefined);
		}
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

function displayError(error: unknown, fallback = "Failed to save wiki page"): string {
	if (error instanceof Error && error.message.trim().length > 0) return error.message;
	if (typeof error === "string" && error.trim().length > 0) return error;
	return fallback;
}

export const notebookStore = new NotebookStoreImpl();
