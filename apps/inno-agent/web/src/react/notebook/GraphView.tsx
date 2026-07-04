import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Scan, Shuffle, RefreshCw } from "lucide-react";
import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
// @ts-expect-error - cytoscape-cola has no public types
import cola from "cytoscape-cola";
import type { WikiGraphEdge, WikiGraphNode } from "../../types/wiki.js";
import { notebookStore } from "../../stores/notebook-store.js";
import { useStoreSnapshot } from "../hooks.js";

let registered = false;
function ensureRegistered() {
	if (registered) return;
	cytoscape.use(cola);
	registered = true;
}

type NodeCategory = "source-summary" | "entity" | "concept" | "analysis" | "tag";
const ALL_CATEGORIES: NodeCategory[] = ["source-summary", "entity", "concept", "analysis", "tag"];
const DEFAULT_VISIBLE: NodeCategory[] = ["source-summary", "entity", "concept", "analysis"];

const TYPE_COLORS: Record<string, string> = {
	"source-summary": "#4b8ef0",
	entity: "#3dba6f",
	concept: "#e8993a",
	analysis: "#9b5de5",
	tag: "#8b949e",
};

function buildElements(nodes: WikiGraphNode[], edges: WikiGraphEdge[]): ElementDefinition[] {
	const degree = new Map<string, number>();
	for (const e of edges) {
		degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
		degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
	}
	const nodeIds = new Set(nodes.map((n) => n.id));
	const els: ElementDefinition[] = nodes.map((n) => ({
		data: {
			id: n.id,
			label: n.title || n.id,
			type: n.type,
			color: TYPE_COLORS[n.type] ?? "#8b949e",
			degree: degree.get(n.id) ?? 0,
			size: 18 + Math.min(28, (degree.get(n.id) ?? 0) * 3),
		},
	}));
	for (const e of edges) {
		if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) continue;
		els.push({
			data: {
				id: `${e.source}__${e.target}__${e.type}`,
				source: e.source,
				target: e.target,
				edgeType: e.type,
			},
		});
	}
	return els;
}

function makeColaLayoutOptions(): cytoscape.LayoutOptions {
	return {
		name: "cola",
		// Keep the simulation running so nodes continuously repel and dragging
		// naturally nudges connected/nearby nodes out of the way.
		infinite: true,
		fit: false,
		animate: true,
		refresh: 1,
		maxSimulationTime: 0,
		ungrabifyWhileSimulating: false,
		nodeSpacing: () => 18,
		avoidOverlap: true,
		handleDisconnected: true,
		edgeLength: (edge: cytoscape.EdgeSingular) =>
			edge.data("edgeType") === "tag" ? 90 : 130,
		randomize: false,
		padding: 24,
	} as unknown as cytoscape.LayoutOptions;
}

export function GraphView() {
	const { t } = useTranslation();
	const state = useStoreSnapshot(notebookStore, () => ({
		nodes: notebookStore.nodes,
		edges: notebookStore.edges,
		isLoading: notebookStore.isLoadingGraph,
		selectedNodeId: notebookStore.selectedNodeId,
		searchQuery: notebookStore.searchQuery,
		highlight: notebookStore.highlightSet,
	}));

	const containerRef = useRef<HTMLDivElement | null>(null);
	const cyRef = useRef<Core | null>(null);
	const layoutRef = useRef<cytoscape.Layouts | null>(null);

	const [visibleCategories, setVisibleCategories] = useState<Set<NodeCategory>>(
		() => new Set(DEFAULT_VISIBLE),
	);
	const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);

	const toggleCategory = useCallback((category: NodeCategory) => {
		setVisibleCategories((prev) => {
			const next = new Set(prev);
			if (next.has(category)) next.delete(category);
			else next.add(category);
			return next;
		});
	}, []);

	const elements = useMemo(() => buildElements(state.nodes, state.edges), [state.nodes, state.edges]);

	useEffect(() => {
		ensureRegistered();
		if (!containerRef.current) return;
		const cy = cytoscape({
			container: containerRef.current,
			elements,
			wheelSensitivity: 0.2,
			minZoom: 0.2,
			maxZoom: 2.5,
			style: [
				{
					selector: "node",
					style: {
						"background-color": "data(color)",
						label: "data(label)",
						color: "#0f172a",
						"font-size": 11,
						"text-margin-y": 6,
						"text-valign": "bottom",
						"text-halign": "center",
						"text-outline-width": 2,
						"text-outline-color": "#ffffff",
						"text-outline-opacity": 0.9,
						width: "data(size)" as unknown as number,
						height: "data(size)" as unknown as number,
						"border-color": "#ffffff",
						"border-width": 1.5,
						"overlay-opacity": 0,
						"transition-property": "opacity, border-color, border-width",
						"transition-duration": 150,
					},
				},
				{
					selector: "node:selected",
					style: {
						"border-color": "#2563eb",
						"border-width": 3,
					},
				},
				{
					selector: "node.dim",
					style: { opacity: 0.15 },
				},
				{
					selector: "node.hl",
					style: {
						"border-color": "#f59e0b",
						"border-width": 3,
					},
				},
				{
					selector: "node.hidden, edge.hidden",
					style: { display: "none" },
				},
				{
					selector: "edge",
					style: {
						width: 1.4,
						"line-color": "#cbd5e1",
						"curve-style": "bezier",
						opacity: 0.7,
						"transition-property": "opacity, line-color, width",
						"transition-duration": 150,
					},
				},
				{
					selector: "edge[edgeType = 'tag']",
					style: { "line-color": "#e2e8f0", "line-style": "dashed" },
				},
				{
					selector: "edge.dim",
					style: { opacity: 0.08 },
				},
				{
					selector: "edge.hl",
					style: { "line-color": "#2563eb", width: 2, opacity: 1 },
				},
			],
		});

		// Start continuous cola simulation. We keep a reference so we can stop/restart.
		const layout = cy.layout(makeColaLayoutOptions());
		layoutRef.current = layout;
		layout.run();
		// One-time fit after the first stabilisation pass.
		setTimeout(() => cy.fit(undefined, 32), 600);

		cy.on("tap", "node", (evt) => {
			const id = evt.target.id() as string;
			const node = state.nodes.find((n) => n.id === id);
			if (!node) return;
			if (node.type === "tag") {
				notebookStore.selectNode(id);
				return;
			}
			void notebookStore.selectPage(id);
		});
		cy.on("tap", (evt) => {
			if (evt.target === cy) {
				notebookStore.selectNode(null);
			}
		});
		cy.on("mouseover", "node", (evt) => {
			const node = evt.target;
			setHoveredNodeId(node.id());
			cy.elements(":visible").addClass("dim");
			node.removeClass("dim").addClass("hl");
			const neighborhood = node.openNeighborhood().filter(":visible");
			neighborhood.removeClass("dim").addClass("hl");
		});
		cy.on("mouseout", "node", () => {
			setHoveredNodeId(null);
			cy.elements().removeClass("dim").removeClass("hl");
		});

		cyRef.current = cy;
		return () => {
			layoutRef.current?.stop();
			layoutRef.current = null;
			cy.destroy();
			cyRef.current = null;
		};
	}, [elements]); // eslint-disable-line react-hooks/exhaustive-deps

	// React to selection from outside (e.g. clicking the list)
	useEffect(() => {
		const cy = cyRef.current;
		if (!cy) return;
		cy.elements().unselect();
		if (state.selectedNodeId) {
			const ele = cy.getElementById(state.selectedNodeId);
			if (ele.nonempty()) {
				ele.select();
				cy.animate({ center: { eles: ele }, duration: 250 });
			}
		}
	}, [state.selectedNodeId]);

	// React to search query → dim non-matches
	useEffect(() => {
		const cy = cyRef.current;
		if (!cy) return;
		cy.elements().removeClass("dim").removeClass("hl");
		if (!state.searchQuery || state.highlight.size === 0) return;
		cy.nodes(":visible").forEach((n) => {
			if (state.highlight.has(n.id())) {
				n.addClass("hl");
			} else {
				n.addClass("dim");
			}
		});
		cy.edges(":visible").addClass("dim");
	}, [state.searchQuery, state.highlight]);

	// Apply category visibility, then restart layout so it recomputes against the
	// new node set (otherwise hidden nodes still contribute to forces visually).
	useEffect(() => {
		const cy = cyRef.current;
		if (!cy) return;
		const visible = visibleCategories;
		cy.batch(() => {
			cy.nodes().forEach((n) => {
				const type = (n.data("type") as NodeCategory) ?? "entity";
				if (visible.has(type)) n.removeClass("hidden");
				else n.addClass("hidden");
			});
			cy.edges().forEach((e) => {
				const src = e.source();
				const tgt = e.target();
				if (src.hasClass("hidden") || tgt.hasClass("hidden")) e.addClass("hidden");
				else e.removeClass("hidden");
			});
		});
		layoutRef.current?.stop();
		const layout = cy.elements(":visible").layout(makeColaLayoutOptions());
		layoutRef.current = layout;
		layout.run();
	}, [visibleCategories, elements]);

	function fit() {
		cyRef.current?.fit(undefined, 32);
	}

	function reLayout() {
		const cy = cyRef.current;
		if (!cy) return;
		layoutRef.current?.stop();
		const layout = cy.elements(":visible").layout({
			...makeColaLayoutOptions(),
			randomize: true,
		} as unknown as cytoscape.LayoutOptions);
		layoutRef.current = layout;
		layout.run();
	}

	const visibleNodeCount = useMemo(
		() => state.nodes.filter((n) => visibleCategories.has(n.type as NodeCategory)).length,
		[state.nodes, visibleCategories],
	);
	const visibleEdgeCount = useMemo(() => {
		const visibleIds = new Set(
			state.nodes.filter((n) => visibleCategories.has(n.type as NodeCategory)).map((n) => n.id),
		);
		return state.edges.filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target)).length;
	}, [state.nodes, state.edges, visibleCategories]);

	const selectedNode = useMemo(
		() => state.nodes.find((n) => n.id === state.selectedNodeId) ?? null,
		[state.nodes, state.selectedNodeId],
	);

	const hoveredNode = useMemo(
		() => (hoveredNodeId ? state.nodes.find((n) => n.id === hoveredNodeId) ?? null : null),
		[state.nodes, hoveredNodeId],
	);

	const displayNode = hoveredNode ?? selectedNode;

	return (
		<div className="relative flex h-full min-h-0 flex-col">
			<div className="@container flex items-center gap-2 border-b border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-2 text-xs text-[var(--inno-text-muted)]">
				<button className="inline-flex items-center gap-1 rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2 py-1 hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]" onClick={fit} title={t("notebook.graph.fit")}>
					<Scan size={13} />
					<span className="hidden @[680px]:inline">{t("notebook.graph.fit")}</span>
				</button>
				<button className="inline-flex items-center gap-1 rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2 py-1 hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]" onClick={reLayout} title={t("notebook.graph.relayout")}>
					<Shuffle size={13} />
					<span className="hidden @[680px]:inline">{t("notebook.graph.relayout")}</span>
				</button>
				<button className="inline-flex items-center gap-1 rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2 py-1 hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]" onClick={() => void notebookStore.loadGraph()} title={t("notebook.graph.refresh")}>
					<RefreshCw size={13} />
					<span className="hidden @[680px]:inline">{t("notebook.graph.refresh")}</span>
				</button>
				<div className="mx-1 h-4 w-px bg-[var(--inno-surface-muted)]" />
				<span className="text-[var(--inno-text-subtle)]">{t("notebook.graph.show")}</span>
				{ALL_CATEGORIES.map((cat) => {
					const active = visibleCategories.has(cat);
					const color = TYPE_COLORS[cat];
					return (
						<button
							key={cat}
							type="button"
							onClick={() => toggleCategory(cat)}
							className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition ${
								active
									? "border-[var(--inno-border-strong)] bg-[var(--inno-surface)] text-[var(--inno-text)] hover:bg-[var(--inno-surface-muted)]"
									: "border-[var(--inno-border)] bg-[var(--inno-surface-muted)] text-[var(--inno-text-subtle)] line-through hover:bg-[var(--inno-surface-muted)]"
							}`}
							title={t(`notebook.types.${cat}`)}
						>
							<span
								className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
								style={{ backgroundColor: color, opacity: active ? 1 : 0.4 }}
							/>
							<span className="hidden @[680px]:inline">{t(`notebook.types.${cat}`)}</span>
						</button>
					);
				})}
				<span className="ml-auto hidden @[680px]:inline">
					{t("notebook.subtitle", { nodes: visibleNodeCount, edges: visibleEdgeCount })}
				</span>
			</div>
			<div ref={containerRef} className="relative min-h-0 flex-1 bg-[var(--inno-workspace-bg,#fafafa)]">
				{displayNode ? (
					<div className="absolute inset-x-0 top-0 z-10 flex items-center gap-2 border-b border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-1.5 text-xs">
						<span
							className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
							style={{ backgroundColor: TYPE_COLORS[displayNode.type] ?? "#8b949e" }}
						/>
						<span className="truncate font-medium text-[var(--inno-text)]">{displayNode.title || displayNode.id}</span>
						<span className="text-[var(--inno-text-subtle)]">{t(`notebook.types.${displayNode.type}`)}</span>
						{displayNode.tags.length > 0 ? (
							<span className="truncate text-[var(--inno-text-subtle)]">
								{displayNode.tags.map((tag) => `#${tag}`).join(" ")}
							</span>
						) : null}
						{displayNode.type !== "tag" ? (
							<button
								className="ml-auto shrink-0 rounded-md inno-primary-button px-2 py-0.5 text-xs text-white"
								onClick={() => void notebookStore.selectPage(displayNode.id)}
							>
								{t("notebook.inspector.openPage")}
							</button>
						) : null}
					</div>
				) : null}
			</div>
			{state.isLoading ? (
				<div className="absolute inset-0 flex items-center justify-center bg-white/40 text-sm text-[var(--inno-text-muted)]">
					<span className="mr-2 inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
					{t("common.loading")}
				</div>
			) : null}
			{!state.isLoading && state.nodes.length === 0 ? (
				<div className="absolute inset-0 flex items-center justify-center text-sm text-[var(--inno-text-muted)]">
					{t("notebook.graph.empty")}
				</div>
			) : null}
		</div>
	);
}
