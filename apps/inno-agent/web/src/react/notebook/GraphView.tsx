import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Scan, Shuffle, RefreshCw, Network, Tag, Link2 } from "lucide-react";
import { Spinner } from "../ui/Spinner.js";
import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import { ForceSimulation, type SimLink, type SimNode } from "./force-simulation.js";
import type { WikiGraphEdge, WikiGraphNode } from "../../types/wiki.js";
import type { PersonalLink } from "../../types/learner.js";
import { notebookStore } from "../../stores/notebook-store.js";
import { appStore, type WorkspaceMode } from "../../stores/app-store.js";
import { chatStore } from "../../stores/chat-store.js";
import { sessionsStore } from "../../stores/sessions-store.js";
import { useStoreSnapshot } from "../hooks.js";
import { PersonalLinksPanel } from "./PersonalLinksPanel.js";

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
	const labelThreshold = Math.max(3, pageDegrees[Math.floor(pageDegrees.length * 0.6)] ?? 3);
	const maxWeight = Math.max(...uniqueEdges.filter((edge) => edge.type === "link").map((edge) => edge.weight ?? 1), 1);
	const nodeIds = new Set(nodes.map((n) => n.id));
	const nodeCommunities = new Map(nodes.map((node) => [node.id, node.community ?? 0]));
	const seedPositions = buildCommunitySeedPositions(nodes);
	const els: ElementDefinition[] = nodes.map((n) => {
		const nodeDegree = degree.get(n.id) ?? n.degree ?? 0;
		const fullLabel = n.title || n.id;
		const showLabel = graphCategory(n.type) === "source" || n.type === "analysis" || nodeDegree >= labelThreshold;
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

function buildPersonalLinkElements(cy: Core, personalLinks: PersonalLink[]): ElementDefinition[] {
	return personalLinks.flatMap((link) => {
		if (cy.getElementById(link.source).empty() || cy.getElementById(link.target).empty()) return [];
		return [{
			data: {
				id: `personal__${link.id}`,
				source: link.source,
				target: link.target,
				edgeType: "personal",
				personalStatus: link.status,
				edgeWidth: 0.8,
				edgeOpacity: 0.3,
			},
		}];
	});
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

	const [visibleCategories, setVisibleCategories] = useState<Set<NodeCategory>>(
		() => new Set(DEFAULT_VISIBLE),
	);
	const [colorMode, setColorMode] = useState<GraphColorMode>("community");
	const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
	const [isCoBuilding, setIsCoBuilding] = useState(false);
	const [connectionNodeIds, setConnectionNodeIds] = useState<string[]>([]);
	const [personalLinks, setPersonalLinks] = useState<PersonalLink[]>([]);
	const [showPersonalLinks, setShowPersonalLinks] = useState(false);
	const isCoBuildingRef = useRef(false);
	const connectionNodeIdsRef = useRef<string[]>([]);
	const workspaceModeBeforeCoBuildRef = useRef<WorkspaceMode | null>(null);

	const chooseConnectionNodes = useCallback((ids: string[]) => {
		connectionNodeIdsRef.current = ids;
		setConnectionNodeIds(ids);
	}, []);

	useEffect(() => {
		isCoBuildingRef.current = isCoBuilding;
		if (!isCoBuilding) chooseConnectionNodes([]);
	}, [chooseConnectionNodes, isCoBuilding]);

	const toggleCategory = useCallback((category: NodeCategory) => {
		setVisibleCategories((prev) => {
			const next = new Set(prev);
			if (next.has(category)) next.delete(category);
			else next.add(category);
			return next;
		});
	}, []);

	const elements = useMemo(
		() => buildElements(state.nodes, state.edges),
		[state.nodes, state.edges],
	);

	useEffect(() => {
		if (!containerRef.current) return;
		const cy = cytoscape({
			container: containerRef.current,
			elements,
			minZoom: 0.2,
			maxZoom: 2.5,
			style: [
				{
					selector: "node",
					style: {
						"background-color": "data(color)",
						label: "data(label)",
						color: "#334155",
						"font-size": 10,
						"text-margin-y": 5,
						"text-valign": "bottom",
						"text-halign": "center",
						"text-outline-width": 2,
						"text-outline-color": "#ffffff",
						"text-outline-opacity": 0.9,
						width: "data(size)" as unknown as number,
						height: "data(size)" as unknown as number,
						"border-color": "#ffffff",
						"border-width": 1,
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
						label: "data(fullLabel)",
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
						label: "data(fullLabel)",
					},
				},
				{
					selector: "node.co-build-selected",
					style: {
						"border-color": "#0f766e",
						"border-width": 4,
						label: "data(fullLabel)",
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
						"line-color": "#cbd5e1",
						"curve-style": "straight",
						opacity: "data(edgeOpacity)" as unknown as number,
						"transition-property": "opacity, line-color, width",
						"transition-duration": 150,
					},
				},
				{
					selector: "edge[edgeType = 'tag']",
					style: { "line-color": "#e2e8f0", "line-style": "dashed", opacity: 0.16 },
				},
				{
					selector: "edge[edgeType = 'personal']",
					style: { "line-color": "#94a3b8", "line-style": "dashed", width: 0.8, opacity: 0.3 },
				},
				{
					selector: "edge[personalStatus = 'rejected']",
					style: { "line-color": "#94a3b8", opacity: 0.45 },
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

		cy.on("tap", "node", (evt) => {
			const id = evt.target.id() as string;
			const node = state.nodes.find((n) => n.id === id);
			if (!node) return;
			if (isCoBuildingRef.current && node.type !== "tag") {
				const current = connectionNodeIdsRef.current;
				if (current.includes(id)) {
					chooseConnectionNodes(current.filter((item) => item !== id));
				} else if (current.length < 2) {
					chooseConnectionNodes([...current, id]);
				}
				return;
			}
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

		const sim = simRef.current!;
		const startTicking = () => {
			if (rafRef.current !== null) return;
			const frame = () => {
				if (!cyRef.current || !sim.running) {
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
		// GraphView is mounted inside a tabbed flex layout. Give Cytoscape a
		// stable, non-zero viewport after the tab becomes visible and whenever
		// the surrounding panel is resized.
		const resizeObserver = new ResizeObserver(() => {
			cy.resize();
		});
		resizeObserver.observe(containerRef.current);
		return () => {
			resizeObserver.disconnect();
			if (rafRef.current !== null) {
				cancelAnimationFrame(rafRef.current);
				rafRef.current = null;
			}
			sim.stop();
			simNodesRef.current = [];
			cy.destroy();
			cyRef.current = null;
		};
	}, [elements]); // eslint-disable-line react-hooks/exhaustive-deps

	// Personal links are an overlay, not part of the Wiki graph's lifecycle.
	// Updating them must not recreate Cytoscape or move the learner's viewport.
	useEffect(() => {
		const cy = cyRef.current;
		if (!cy) return;
		cy.batch(() => {
			cy.edges("[edgeType = 'personal']").remove();
			cy.add(buildPersonalLinkElements(cy, personalLinks));
			cy.edges("[edgeType = 'personal']").forEach((edge) => {
				edge.toggleClass("hidden", !showPersonalLinks || edge.source().hasClass("hidden") || edge.target().hasClass("hidden"));
			});
		});
	}, [personalLinks, showPersonalLinks]);

	useEffect(() => {
		const cy = cyRef.current;
		if (!cy) return;
		cy.nodes().removeClass("co-build-selected");
		for (const id of connectionNodeIds) cy.getElementById(id).addClass("co-build-selected");
	}, [connectionNodeIds]);

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
			cy.edges().filter("[edgeType != 'personal']").forEach((edge) => {
				edge.data("edgeOpacity", edge.data(colorMode === "community" ? "communityEdgeOpacity" : "typeEdgeOpacity"));
			});
			cy.nodes().forEach((node) => {
				const type = (node.data("type") as NodeCategory) ?? "entity";
				node.toggleClass("hidden", !visibleCategories.has(type));
			});
			cy.edges().filter("[edgeType != 'personal']").forEach((edge) => {
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
		cy.fit(cy.elements(":visible"), 32);
		sim.reheat(colorMode === "community" ? 0.35 : 0.6);
		(cy.scratch("innoStartTicking") as (() => void) | undefined)?.();
	}, [colorMode, elements, visibleCategories]);

	// This is deliberately separate from the layout effect: toggling personal
	// links is a visibility preference, so it must never fit or rearrange nodes.
	useEffect(() => {
		const cy = cyRef.current;
		if (!cy) return;
		cy.edges("[edgeType = 'personal']").forEach((edge) => {
			edge.toggleClass("hidden", !showPersonalLinks || edge.source().hasClass("hidden") || edge.target().hasClass("hidden"));
		});
	}, [showPersonalLinks, visibleCategories]);

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

	function fit() {
		cyRef.current?.fit(undefined, 32);
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
		cy.fit(cy.elements(":visible"), 32);
		sim.reheat(0.8);
		(cy.scratch("innoStartTicking") as (() => void) | undefined)?.();
	}

	function openCoBuilding(): void {
		if (isCoBuilding) {
			closeCoBuilding();
			return;
		}
		workspaceModeBeforeCoBuildRef.current = appStore.workspaceMode;
		appStore.setRightPanelTab("notebook");
		appStore.setWorkspaceMode("full");
		setShowPersonalLinks(true);
		setIsCoBuilding(true);
	}

	function closeCoBuilding(): void {
		setIsCoBuilding(false);
		const previousMode = workspaceModeBeforeCoBuildRef.current;
		workspaceModeBeforeCoBuildRef.current = null;
		if (previousMode && appStore.workspaceMode === "full") appStore.setWorkspaceMode(previousMode);
	}

	function returnToChatWithReview(feedback: string): void {
		setIsCoBuilding(false);
		workspaceModeBeforeCoBuildRef.current = null;
		appStore.setWorkspaceMode("collapsed");
		if (feedback && sessionsStore.currentSessionId) chatStore.appendAssistantMessage(feedback);
	}

	function togglePersonalLinks(): void {
		setShowPersonalLinks((visible) => !visible);
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
				<button className="inline-flex items-center gap-1 rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2 py-1 hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]" onClick={fit} title={t("notebook.graph.fit")}>
					<Scan size={14} />
					<span className="hidden @[1050px]:inline">{t("notebook.graph.fit")}</span>
				</button>
				<button className="inline-flex items-center gap-1 rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2 py-1 hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]" onClick={reLayout} title={t("notebook.graph.relayout")}>
					<Shuffle size={14} />
					<span className="hidden @[1050px]:inline">{t("notebook.graph.relayout")}</span>
				</button>
				<button className="inline-flex items-center gap-1 rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2 py-1 hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]" onClick={() => void notebookStore.loadGraph()} title={t("notebook.graph.refresh")}>
					<RefreshCw size={14} />
					<span className="hidden @[1050px]:inline">{t("notebook.graph.refresh")}</span>
				</button>
				<button
					type="button"
					onClick={openCoBuilding}
					className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 ${isCoBuilding ? "border-teal-700 bg-teal-700 text-white" : "border-[var(--inno-border)] bg-[var(--inno-surface)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]"}`}
					aria-pressed={isCoBuilding}
					title="共建个人连接"
				>
					<Link2 size={14} />
					<span>共建连接</span>
				</button>
				<div className="mx-1 h-4 w-px bg-[var(--inno-surface-muted)]" />
				<div className="inline-flex rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] p-0.5">
					<button
						type="button"
						onClick={() => setColorMode("type")}
						className={`inline-flex items-center gap-1 rounded px-2 py-0.5 ${colorMode === "type" ? "bg-[var(--inno-surface)] text-[var(--inno-text)] shadow-sm" : "text-[var(--inno-text-subtle)]"}`}
						title={t("notebook.graph.colorType")}
						aria-pressed={colorMode === "type"}
					>
						<Tag size={13} />
						<span className="hidden @[900px]:inline">{t("notebook.graph.colorType")}</span>
					</button>
					<button
						type="button"
						onClick={() => setColorMode("community")}
						className={`inline-flex items-center gap-1 rounded px-2 py-0.5 ${colorMode === "community" ? "bg-[var(--inno-surface)] text-[var(--inno-text)] shadow-sm" : "text-[var(--inno-text-subtle)]"}`}
						title={t("notebook.graph.colorCommunity")}
						aria-pressed={colorMode === "community"}
					>
						<Network size={13} />
						<span className="hidden @[900px]:inline">{t("notebook.graph.colorCommunity")}</span>
					</button>
				</div>
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
							<span className="hidden @[1050px]:inline">{t(`notebook.types.${cat}`)}</span>
						</button>
					);
				})}
				<button
					type="button"
					onClick={togglePersonalLinks}
					disabled={personalLinks.length === 0}
					className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition ${
						showPersonalLinks
							? "border-slate-400 bg-[var(--inno-surface)] text-[var(--inno-text)] hover:bg-[var(--inno-surface-muted)]"
							: "border-[var(--inno-border)] bg-[var(--inno-surface-muted)] text-[var(--inno-text-subtle)] hover:bg-[var(--inno-surface-muted)] disabled:cursor-not-allowed disabled:opacity-50"
					}`}
					aria-pressed={showPersonalLinks}
					title={personalLinks.length > 0 ? "显示或隐藏我建立的虚线连接" : "你还没有建立个人连接"}
				>
					<span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full border border-slate-400" />
					<span>我的连接{personalLinks.length > 0 ? ` (${personalLinks.length})` : ""}</span>
				</button>
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
			<div className="relative min-h-0 flex-1 overflow-hidden bg-[var(--inno-workspace-bg,#fafafa)]">
				{/* Cytoscape owns this subtree; React overlays remain sibling layers. */}
				<div ref={containerRef} className="h-full w-full" />
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
							<button
								className="ml-auto shrink-0 rounded-md inno-primary-button px-2 py-0.5 text-xs text-white"
								onClick={() => void notebookStore.selectPage(displayNode.id)}
							>
								{t("notebook.inspector.openPage")}
							</button>
						) : null}
					</div>
				) : null}
				{isCoBuilding ? (
					<PersonalLinksPanel
						nodes={state.nodes}
						selectedIds={connectionNodeIds}
						onResetSelection={() => chooseConnectionNodes([])}
						onClose={closeCoBuilding}
						onReviewComplete={returnToChatWithReview}
						onLinksChange={setPersonalLinks}
					/>
				) : null}
			</div>
			{state.isLoading ? (
				<div className="absolute inset-0 flex items-center justify-center bg-white/40 text-sm text-[var(--inno-text-muted)]">
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
