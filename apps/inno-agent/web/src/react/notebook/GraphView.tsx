import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Scan, Focus, Shuffle, RefreshCw, Network, Tag } from "lucide-react";
import { Spinner } from "../ui/Spinner.js";
import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import { ForceSimulation, type SimLink, type SimNode } from "./force-simulation.js";
import { focusDefaultGraph } from "./graph-viewport.js";
import type { WikiGraphEdge, WikiGraphNode } from "../../types/wiki.js";
import { notebookStore } from "../../stores/notebook-store.js";
import { useStoreSnapshot } from "../hooks.js";
import { Button, SegmentedControl } from "../ui/index.js";

type NodeCategory = "source" | "entity" | "concept" | "comparison" | "synthesis" | "analysis" | "tag";
type GraphColorMode = "type" | "community";
const ALL_CATEGORIES: NodeCategory[] = ["source", "entity", "concept", "comparison", "synthesis", "analysis", "tag"];
const DEFAULT_VISIBLE: NodeCategory[] = ["source", "entity", "concept", "comparison", "synthesis", "analysis"];

const TYPE_COLORS: Record<string, string> = {
	source: "#4b8ef0",
	"source-summary": "#4b8ef0",
	entity: "#3dba6f",
	concept: "#e8993a",
	comparison: "#2aa9a1",
	synthesis: "#9b5de5",
	analysis: "#9b5de5",
	tag: "#8b949e",
};

function graphCategory(type: string): NodeCategory {
	return type === "source-summary" ? "source" : (type as NodeCategory);
}

const COMMUNITY_COLORS = [
	"#4b8ef0",
	"#3dba6f",
	"#e8993a",
	"#9b5de5",
	"#ef6b73",
	"#2aa9a1",
	"#d6a328",
	"#db6fa8",
];

function communityColor(node: WikiGraphNode): string {
	if (node.type === "tag") return TYPE_COLORS.tag;
	return COMMUNITY_COLORS[(node.community ?? 0) % COMMUNITY_COLORS.length] ?? TYPE_COLORS.tag;
}

function deduplicateEdges(edges: WikiGraphEdge[]): WikiGraphEdge[] {
	const byPair = new Map<string, WikiGraphEdge>();
	for (const edge of edges) {
		const endpoints = edge.type === "link"
			? [edge.source, edge.target].sort()
			: [edge.source, edge.target];
		const key = `${edge.type}\u0000${endpoints[0]}\u0000${endpoints[1]}`;
		const existing = byPair.get(key);
		if (!existing || (edge.weight ?? 1) > (existing.weight ?? 1)) byPair.set(key, edge);
	}
	return [...byPair.values()];
}

function truncateLabel(label: string, maxLength = 20): string {
	return label.length <= maxLength ? label : `${label.slice(0, maxLength - 3)}...`;
}

/**
 * Chrome colors (labels, outlines, edges, selection) read from the live CSS
 * variables so the canvas follows the active theme. Categorical node colors
 * (TYPE_COLORS / COMMUNITY_COLORS) are mid-tone and work on both themes.
 */
interface GraphTheme {
	labelColor: string;
	textOutline: string;
	nodeBorder: string;
	edgeColor: string;
	tagEdgeColor: string;
	accent: string;
	hl: string;
}

function readGraphTheme(): GraphTheme {
	const cs = getComputedStyle(document.documentElement);
	const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
	return {
		labelColor: v("--inno-text-muted", "#5f6368"),
		textOutline: v("--inno-card-bg", "#ffffff"),
		nodeBorder: v("--inno-card-bg", "#ffffff"),
		edgeColor: v("--inno-border-strong", "#cbd5e1"),
		tagEdgeColor: v("--inno-border", "#e2e8f0"),
		accent: v("--inno-accent", "#2563eb"),
		hl: v("--inno-warning", "#f59e0b"),
	};
}

function cyStyle(theme: GraphTheme): cytoscape.StylesheetJson {
	return [
		{
			selector: "node",
			style: {
				"background-color": "data(color)",
				label: "data(label)",
				color: theme.labelColor,
				"font-size": 12,
				// At overview scale, suppress unreadable text rather than rendering
				// a cloud of tiny labels. Hover/selection still reveals the title.
				"min-zoomed-font-size": 10,
				"text-wrap": "ellipsis",
				"text-max-width": "144px",
				"text-margin-y": 5,
				"text-valign": "bottom",
				"text-halign": "center",
				"text-outline-width": 2,
				"text-outline-color": theme.textOutline,
				"text-outline-opacity": 0.9,
				width: "data(size)" as unknown as number,
				height: "data(size)" as unknown as number,
				"border-color": theme.nodeBorder,
				"border-width": 1,
				"overlay-opacity": 0,
				"transition-property": "opacity, border-color, border-width",
				"transition-duration": 150,
			},
		},
		{
			selector: "node:selected",
			style: {
				"border-color": theme.accent,
				"border-width": 3,
				label: "data(fullLabel)",
				"min-zoomed-font-size": 0,
				"text-wrap": "wrap",
				"text-max-width": "240px",
			},
		},
		{
			selector: "node.dim",
			style: { opacity: 0.15 },
		},
		{
			selector: "node.hl",
			style: {
				"border-color": theme.hl,
				"border-width": 3,
			},
		},
		{
			selector: "node.focus",
			style: {
				label: "data(fullLabel)",
				"min-zoomed-font-size": 0,
				"text-wrap": "wrap",
				"text-max-width": "240px",
			},
		},
		{
			selector: "node.hidden, edge.hidden",
			style: { display: "none" },
		},
		{
			selector: "edge",
			style: {
				width: "data(edgeWidth)" as unknown as number,
				"line-color": theme.edgeColor,
				"curve-style": "straight",
				opacity: "data(edgeOpacity)" as unknown as number,
				"transition-property": "opacity, line-color, width",
				"transition-duration": 150,
			},
		},
		{
			selector: "edge[edgeType = 'tag']",
			style: { "line-color": theme.tagEdgeColor, "line-style": "dashed", opacity: 0.16 },
		},
		{
			selector: "edge.dim",
			style: { opacity: 0.08 },
		},
		{
			selector: "edge.hl",
			style: { "line-color": theme.accent, width: 2, opacity: 1 },
		},
	];
}

function buildCommunitySeedPositions(nodes: WikiGraphNode[]): Map<string, { x: number; y: number }> {
	const groups = new Map<number, WikiGraphNode[]>();
	for (const node of nodes) {
		const community = node.type === "tag" ? -1 : (node.community ?? 0);
		const group = groups.get(community) ?? [];
		group.push(node);
		groups.set(community, group);
	}

	const orderedGroups = [...groups.entries()].sort(([a], [b]) => a - b);
	const columns = Math.max(1, Math.ceil(Math.sqrt(orderedGroups.length)));
	const positions = new Map<string, { x: number; y: number }>();
	const goldenAngle = Math.PI * (3 - Math.sqrt(5));

	orderedGroups.forEach(([, group], groupIndex) => {
		const centerX = (groupIndex % columns) * 540;
		const centerY = Math.floor(groupIndex / columns) * 440;
		group.sort((a, b) => a.id.localeCompare(b.id)).forEach((node, nodeIndex) => {
			const radius = nodeIndex === 0 ? 0 : 44 + Math.sqrt(nodeIndex) * 25;
			const angle = nodeIndex * goldenAngle;
			positions.set(node.id, {
				x: centerX + Math.cos(angle) * radius,
				y: centerY + Math.sin(angle) * radius,
			});
		});
	});

	return positions;
}

function buildElements(nodes: WikiGraphNode[], edges: WikiGraphEdge[]): ElementDefinition[] {
	const uniqueEdges = deduplicateEdges(edges);
	const degree = new Map<string, number>();
	for (const e of uniqueEdges) {
		degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
		degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
	}
	const pageDegrees = nodes
		.filter((node) => node.type !== "tag")
		.map((node) => degree.get(node.id) ?? node.degree ?? 0)
		.sort((a, b) => a - b);
	const labelThreshold = Math.max(3, pageDegrees[Math.floor(pageDegrees.length * 0.8)] ?? 3);
	const communityHubs = new Map<number, WikiGraphNode>();
	for (const node of nodes) {
		if (node.type === "tag") continue;
		const community = node.community ?? 0;
		const hub = communityHubs.get(community);
		if (!hub || (degree.get(node.id) ?? node.degree ?? 0) > (degree.get(hub.id) ?? hub.degree ?? 0)) {
			communityHubs.set(community, node);
		}
	}
	const maxWeight = Math.max(...uniqueEdges.filter((edge) => edge.type === "link").map((edge) => edge.weight ?? 1), 1);
	const nodeIds = new Set(nodes.map((n) => n.id));
	const nodeCommunities = new Map(nodes.map((node) => [node.id, node.community ?? 0]));
	const seedPositions = buildCommunitySeedPositions(nodes);
	const els: ElementDefinition[] = nodes.map((n) => {
		const nodeDegree = degree.get(n.id) ?? n.degree ?? 0;
		const fullLabel = n.title || n.id;
		// Labelling every source clutters the readable default scale. Keep hubs
		// and analysis titles, and reveal other names only on hover/selection.
		const showLabel = n.type === "analysis" || nodeDegree >= labelThreshold
			|| communityHubs.get(n.community ?? 0)?.id === n.id;
		const seed = seedPositions.get(n.id) ?? { x: 0, y: 0 };
		return {
			data: {
				id: n.id,
				label: showLabel ? truncateLabel(fullLabel) : "",
				fullLabel,
					type: graphCategory(n.type),
					typeColor: TYPE_COLORS[graphCategory(n.type)] ?? TYPE_COLORS.tag,
				communityColor: communityColor(n),
					color: TYPE_COLORS[graphCategory(n.type)] ?? TYPE_COLORS.tag,
				community: n.community ?? 0,
				degree: nodeDegree,
				size: 9 + Math.min(20, Math.sqrt(nodeDegree) * 3.5),
				seedX: seed.x,
				seedY: seed.y,
			},
			position: seed,
		};
	});
	for (const e of uniqueEdges) {
		if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) continue;
		const normalizedWeight = e.type === "tag" ? 0 : Math.min(1, (e.weight ?? 1) / maxWeight);
		const sameCommunity = e.type === "link"
			&& nodeCommunities.get(e.source) === nodeCommunities.get(e.target);
		const baseOpacity = e.type === "tag" ? 0.1 : 0.04 + Math.pow(normalizedWeight, 1.4) * 0.56;
		const communityEdgeOpacity = sameCommunity ? baseOpacity : Math.max(0.035, baseOpacity * 0.6);
		const endpoints = e.type === "link" ? [e.source, e.target].sort() : [e.source, e.target];
		els.push({
			data: {
				id: `${endpoints[0]}__${endpoints[1]}__${e.type}`,
				source: e.source,
				target: e.target,
				edgeType: e.type,
				weight: e.weight ?? 1,
				normalizedWeight,
				sameCommunity,
				edgeWidth: e.type === "tag" ? 0.25 : 0.15 + Math.pow(normalizedWeight, 1.3) * 0.95,
				edgeOpacity: communityEdgeOpacity,
				communityEdgeOpacity,
				typeEdgeOpacity: baseOpacity,
			},
		});
	}
	return els;
}

/**
 * Rebuild the live simulation from the currently visible elements, keeping
 * each node's on-screen position. Returns cytoscape nodes aligned index-for-
 * index with the simulation's nodes so ticks can write positions back cheaply.
 */
function syncSimulation(cy: Core, sim: ForceSimulation, mode: GraphColorMode): cytoscape.NodeSingular[] {
	const cyNodes: cytoscape.NodeSingular[] = [];
	const simNodes: SimNode[] = [];
	const indexById = new Map<string, number>();
	cy.nodes(":visible").forEach((node) => {
		const pos = node.position();
		indexById.set(node.id(), simNodes.length);
		cyNodes.push(node);
		simNodes.push({
			id: node.id(),
			x: pos.x,
			y: pos.y,
			vx: 0,
			vy: 0,
			radius: (Number(node.data("size")) || 14) / 2,
			fixed: node.grabbed(),
			group: Number(node.data("community")) || 0,
		});
	});

	const degree = new Map<number, number>();
	const rawLinks: { source: number; target: number; tag: boolean; weight: number }[] = [];
	cy.edges(":visible").forEach((edge) => {
		const source = indexById.get(edge.source().id());
		const target = indexById.get(edge.target().id());
		if (source === undefined || target === undefined || source === target) return;
		degree.set(source, (degree.get(source) ?? 0) + 1);
		degree.set(target, (degree.get(target) ?? 0) + 1);
		rawLinks.push({
			source,
			target,
			tag: edge.data("edgeType") === "tag",
			weight: Number(edge.data("normalizedWeight")) || 0,
		});
	});
	const links: SimLink[] = rawLinks.map((link) => {
		// d3-force-style: hubs get weaker per-link springs so they stay put
		// while leaves swing around them.
		const minDegree = Math.max(1, Math.min(degree.get(link.source) ?? 1, degree.get(link.target) ?? 1));
		const strength = Math.min(0.42, (link.tag ? 0.18 : 0.62) / minDegree + 0.035);
		return {
			source: link.source,
			target: link.target,
			length: link.tag ? 280 : 150 + (1 - link.weight) * 105,
			strength,
		};
	});

	sim.setGraph(simNodes, links);
	sim.options.groupStrength = mode === "community" ? 0.025 : 0;
	if (simNodes.length > 0) {
		let cx = 0;
		let cyy = 0;
		for (const node of simNodes) {
			cx += node.x;
			cyy += node.y;
		}
		sim.setCenter(cx / simNodes.length, cyy / simNodes.length);
	}
	return cyNodes;
}

function applySimPositions(cy: Core, sim: ForceSimulation, cyNodes: cytoscape.NodeSingular[]): void {
	cy.batch(() => {
		for (let i = 0; i < cyNodes.length; i++) {
			const simNode = sim.getNode(cyNodes[i].id());
			// Grabbed/fixed nodes are positioned by cytoscape's own drag handling.
			if (!simNode || simNode.fixed) continue;
			cyNodes[i].position({ x: simNode.x, y: simNode.y });
		}
	});
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
		communities: notebookStore.communities,
	}));

	const containerRef = useRef<HTMLDivElement | null>(null);
	const cyRef = useRef<Core | null>(null);
	const simRef = useRef<ForceSimulation | null>(null);
	if (!simRef.current) simRef.current = new ForceSimulation();
	const simNodesRef = useRef<cytoscape.NodeSingular[]>([]);
	const rafRef = useRef<number | null>(null);
	const pendingDefaultViewRef = useRef(false);
	const selectedNodeIdRef = useRef(state.selectedNodeId);
	selectedNodeIdRef.current = state.selectedNodeId;

	const [visibleCategories, setVisibleCategories] = useState<Set<NodeCategory>>(
		() => new Set(DEFAULT_VISIBLE),
	);
	const [colorMode, setColorMode] = useState<GraphColorMode>("community");
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
		if (!containerRef.current) return;
		const cy = cytoscape({
			container: containerRef.current,
			elements,
			layout: { name: "preset", fit: false },
			minZoom: 0.05,
			maxZoom: 2.5,
			style: cyStyle(readGraphTheme()),
		});

		// Re-read CSS variables and restyle when the theme flips (data-theme /
		// .dark on <html>), without rebuilding the graph or the simulation.
		const themeObserver = new MutationObserver(() => {
			cy.style().fromJson(cyStyle(readGraphTheme())).update();
		});
		themeObserver.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["data-theme", "class"],
		});

		// Touch devices have no hover; tap becomes the neighborhood-highlight
		// gesture (used below for tag nodes, which stay in graph view).
		const coarsePointer = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
		const highlightNeighborhood = (node: cytoscape.NodeSingular) => {
			cy.elements().removeClass("hl").removeClass("focus");
			cy.elements(":visible").addClass("dim");
			node.removeClass("dim").addClass("hl").addClass("focus");
			const neighborhood = node.openNeighborhood().filter(":visible");
			neighborhood.removeClass("dim").addClass("hl");
		};
		const clearHighlight = () => {
			cy.elements().removeClass("dim").removeClass("hl").removeClass("focus");
		};
		// Only renderer gestures cancel the pending camera update. Listening to
		// generic pan/zoom would also cancel our own programmatic viewport changes.
		cy.on("dragpan scrollzoom pinchzoom tapstart grab", () => {
			pendingDefaultViewRef.current = false;
		});

		cy.on("tap", "node", (evt) => {
			const id = evt.target.id() as string;
			const node = state.nodes.find((n) => n.id === id);
			if (!node) return;
			if (node.type === "tag") {
				notebookStore.selectNode(id);
				// Touch has no hover: let the tap also light up the neighborhood
				// (tag selection stays in graph view, so the highlight is visible).
				if (coarsePointer) highlightNeighborhood(evt.target as cytoscape.NodeSingular);
				return;
			}
			void notebookStore.selectPage(id);
		});
		cy.on("tap", (evt) => {
			if (evt.target === cy) {
				notebookStore.selectNode(null);
				clearHighlight();
			}
		});
		cy.on("mouseover", "node", (evt) => {
			const node = evt.target;
			setHoveredNodeId(node.id());
			highlightNeighborhood(node);
		});
		cy.on("mouseout", "node", () => {
			setHoveredNodeId(null);
			clearHighlight();
		});

		const sim = simRef.current!;
		const startTicking = () => {
			if (rafRef.current !== null) return;
			const frame = () => {
				if (!cyRef.current || !sim.running) {
					// Seed communities are widely spaced, then the force layout
					// contracts them. Fit the settled subject once, unless the user
					// has already taken control of the camera.
					if (cyRef.current && pendingDefaultViewRef.current) {
						pendingDefaultViewRef.current = false;
						focusDefaultGraph(cy, selectedNodeIdRef.current);
					}
					rafRef.current = null;
					return;
				}
				sim.tick();
				applySimPositions(cy, sim, simNodesRef.current);
				rafRef.current = requestAnimationFrame(frame);
			};
			rafRef.current = requestAnimationFrame(frame);
		};
		cy.scratch("innoStartTicking", startTicking);

		// Obsidian-style drag: the grabbed node is pinned to the pointer while
		// the simulation keeps running, so springs pull neighbours along and
		// repulsion shoulders bystanders out of the way. Reheat only once the
		// pointer actually moves — a plain click should not shake the graph.
		let dragging = false;
		cy.on("grab", "node", (evt) => {
			const simNode = sim.getNode((evt.target as cytoscape.NodeSingular).id());
			if (simNode) simNode.fixed = true;
		});
		cy.on("drag", "node", (evt) => {
			const node = evt.target as cytoscape.NodeSingular;
			const simNode = sim.getNode(node.id());
			if (!simNode) return;
			const pos = node.position();
			simNode.x = pos.x;
			simNode.y = pos.y;
			if (!dragging) {
				dragging = true;
				sim.reheat(0.45, 0.28);
				startTicking();
			}
		});
		cy.on("free", "node", (evt) => {
			const node = evt.target as cytoscape.NodeSingular;
			const simNode = sim.getNode(node.id());
			if (simNode) {
				const pos = node.position();
				simNode.x = pos.x;
				simNode.y = pos.y;
				simNode.fixed = false;
			}
			if (dragging) {
				dragging = false;
				sim.alphaTarget = 0;
				sim.reheat(0.25);
				startTicking();
			}
		});

		cyRef.current = cy;
		return () => {
			themeObserver.disconnect();
			if (rafRef.current !== null) {
				cancelAnimationFrame(rafRef.current);
				rafRef.current = null;
			}
			sim.stop();
			pendingDefaultViewRef.current = false;
			simNodesRef.current = [];
			cy.destroy();
			cyRef.current = null;
		};
	}, [elements]); // eslint-disable-line react-hooks/exhaustive-deps

	// Keep presentation and layout changes in one effect. Separate mode and
	// visibility effects would each rebuild the simulation when the graph mounts.
	useEffect(() => {
		const cy = cyRef.current;
		const sim = simRef.current;
		if (!cy || !sim) return;
		cy.batch(() => {
			cy.nodes().forEach((node) => {
				node.data("color", node.data(colorMode === "community" ? "communityColor" : "typeColor"));
			});
			cy.edges().forEach((edge) => {
				edge.data("edgeOpacity", edge.data(colorMode === "community" ? "communityEdgeOpacity" : "typeEdgeOpacity"));
			});
			cy.nodes().forEach((node) => {
				const type = (node.data("type") as NodeCategory) ?? "entity";
				node.toggleClass("hidden", !visibleCategories.has(type));
			});
			cy.edges().forEach((edge) => {
				const sourceHidden = edge.source().hasClass("hidden");
				const targetHidden = edge.target().hasClass("hidden");
				edge.toggleClass("hidden", sourceHidden || targetHidden);
			});
			if (colorMode === "community") {
				cy.nodes(":visible").forEach((node) => {
					node.position({ x: Number(node.data("seedX")), y: Number(node.data("seedY")) });
				});
			}
		});
		simNodesRef.current = syncSimulation(cy, sim, colorMode);
		focusDefaultGraph(cy, selectedNodeIdRef.current);
		pendingDefaultViewRef.current = true;
		sim.reheat(colorMode === "community" ? 0.35 : 0.6);
		(cy.scratch("innoStartTicking") as (() => void) | undefined)?.();
	}, [colorMode, elements, visibleCategories]);

	// React to selection from outside (e.g. clicking the list)
	useEffect(() => {
		const cy = cyRef.current;
		if (!cy) return;
		cy.elements().unselect();
		if (state.selectedNodeId) {
			const ele = cy.getElementById(state.selectedNodeId);
			if (ele.nonempty()) {
				ele.select();
				if (pendingDefaultViewRef.current) {
					focusDefaultGraph(cy, state.selectedNodeId);
				} else {
					cy.animate({ center: { eles: ele }, duration: 250 });
				}
			}
		}
	}, [state.selectedNodeId]);

	// React to search query → dim non-matches
	useEffect(() => {
		const cy = cyRef.current;
		if (!cy) return;
		cy.elements().removeClass("dim").removeClass("hl").removeClass("focus");
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

	function fit() {
		pendingDefaultViewRef.current = false;
		cyRef.current?.fit(cyRef.current.elements(":visible"), 32);
	}

	function resetView() {
		const cy = cyRef.current;
		if (!cy) return;
		focusDefaultGraph(cy, state.selectedNodeId);
		pendingDefaultViewRef.current = Boolean(simRef.current?.running);
	}

	function reLayout() {
		const cy = cyRef.current;
		const sim = simRef.current;
		if (!cy || !sim) return;
		if (colorMode === "community") {
			cy.batch(() => {
				cy.nodes(":visible").forEach((node) => {
					node.position({ x: Number(node.data("seedX")), y: Number(node.data("seedY")) });
				});
			});
		}
		simNodesRef.current = syncSimulation(cy, sim, colorMode);
		focusDefaultGraph(cy, state.selectedNodeId);
		pendingDefaultViewRef.current = true;
		sim.reheat(0.8);
		(cy.scratch("innoStartTicking") as (() => void) | undefined)?.();
	}

	const visibleNodeCount = useMemo(
		() => state.nodes.filter((n) => visibleCategories.has(graphCategory(n.type))).length,
		[state.nodes, visibleCategories],
	);
	const visibleEdgeCount = useMemo(() => {
		const visibleIds = new Set(
			state.nodes.filter((n) => visibleCategories.has(graphCategory(n.type))).map((n) => n.id),
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
		<div className="relative flex h-full min-h-0 flex-col overflow-hidden">
			<div className="@container flex w-full min-w-0 items-center gap-2 overflow-x-auto whitespace-nowrap border-b border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-2 text-xs text-[var(--inno-text-muted)]">
				<Button variant="secondary" size="xs" className="shrink-0" aria-label={t("notebook.graph.resetView")} onClick={resetView} title={t("notebook.graph.resetView")}>
					<Focus size={14} />
					<span className="hidden @[1050px]:inline">{t("notebook.graph.resetView")}</span>
				</Button>
				<Button variant="secondary" size="xs" className="shrink-0" aria-label={t("notebook.graph.fit")} onClick={fit} title={t("notebook.graph.fit")}>
					<Scan size={14} />
					<span className="hidden @[1050px]:inline">{t("notebook.graph.fit")}</span>
				</Button>
				<Button variant="secondary" size="xs" className="shrink-0" aria-label={t("notebook.graph.relayout")} onClick={reLayout} title={t("notebook.graph.relayout")}>
					<Shuffle size={14} />
					<span className="hidden @[1050px]:inline">{t("notebook.graph.relayout")}</span>
				</Button>
				<Button variant="secondary" size="xs" className="shrink-0" aria-label={t("notebook.graph.refresh")} onClick={() => void notebookStore.loadGraph()} title={t("notebook.graph.refresh")}>
					<RefreshCw size={14} />
					<span className="hidden @[1050px]:inline">{t("notebook.graph.refresh")}</span>
				</Button>
				<div className="mx-1 h-4 w-px bg-[var(--inno-surface-muted)]" />
				<SegmentedControl
					value={colorMode}
					onValueChange={setColorMode}
					ariaLabel={t("notebook.graph.colorMode")}
					items={[
						{ value: "type", ariaLabel: t("notebook.graph.colorType"), title: t("notebook.graph.colorType"), label: <><Tag size={13} /><span className="hidden @[900px]:inline">{t("notebook.graph.colorType")}</span></> },
						{ value: "community", ariaLabel: t("notebook.graph.colorCommunity"), title: t("notebook.graph.colorCommunity"), label: <><Network size={13} /><span className="hidden @[900px]:inline">{t("notebook.graph.colorCommunity")}</span></> },
					]}
				/>
				<div className="mx-1 h-4 w-px bg-[var(--inno-surface-muted)]" />
				<span className="text-[var(--inno-text-subtle)]">{t("notebook.graph.show")}</span>
				{ALL_CATEGORIES.map((cat) => {
					const active = visibleCategories.has(cat);
					const color = TYPE_COLORS[cat];
					return (
						<Button
							key={cat}
							variant={active ? "primary" : "secondary"}
							size="xs"
							shape="pill"
							aria-pressed={active}
							onClick={() => toggleCategory(cat)}
							className="inno-filter-button inno-graph-category-filter shrink-0"
							title={t(`notebook.types.${cat}`)}
						>
							<span
								aria-hidden="true"
								className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
								style={{ backgroundColor: color, opacity: active ? 1 : 0.4 }}
							/>
							<span className={`hidden @[1050px]:inline ${active ? "" : "line-through"}`}>{t(`notebook.types.${cat}`)}</span>
						</Button>
					);
				})}
				<div className="ml-auto hidden shrink-0 text-right @[900px]:block">
					<div>{t("notebook.subtitle", { nodes: visibleNodeCount, edges: visibleEdgeCount })}</div>
					{colorMode === "community" && state.communities ? (
						<div className="text-[var(--inno-text-subtle)]">
							{t("notebook.graph.communityStats", {
								count: state.communities.count,
								modularity: state.communities.modularity.toFixed(3),
							})}
						</div>
					) : null}
				</div>
			</div>
			<div ref={containerRef} className="relative min-h-0 flex-1 overflow-hidden bg-[var(--inno-card-bg)]">
				{displayNode ? (
					<div className="absolute inset-x-0 top-0 z-10 flex items-center gap-2 border-b border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-1.5 text-xs">
						<span
							className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
							style={{
								backgroundColor: colorMode === "community"
									? communityColor(displayNode)
									: TYPE_COLORS[displayNode.type] ?? TYPE_COLORS.tag,
							}}
						/>
						<span className="truncate font-medium text-[var(--inno-text)]">{displayNode.title || displayNode.id}</span>
						<span className="text-[var(--inno-text-subtle)]">{t(`notebook.types.${displayNode.type}`)}</span>
						{displayNode.tags.length > 0 ? (
							<span className="truncate text-[var(--inno-text-subtle)]">
								{displayNode.tags.map((tag) => `#${tag}`).join(" ")}
							</span>
						) : null}
						{displayNode.type !== "tag" ? (
							<Button
								variant="primary"
								size="xs"
								className="ml-auto shrink-0"
								onClick={() => void notebookStore.selectPage(displayNode.id)}
							>
								{t("notebook.inspector.openPage")}
							</Button>
						) : null}
					</div>
				) : null}
			</div>
			{state.isLoading ? (
				<div className="absolute inset-0 flex items-center justify-center bg-[color-mix(in_srgb,var(--inno-card-bg)_55%,transparent)] text-sm text-[var(--inno-text-muted)]">
					<Spinner size={16} className="mr-2" />
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
