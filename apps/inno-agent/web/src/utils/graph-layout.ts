/**
 * Deterministic graph layout and Canvas 2D renderer.
 * The graph intentionally stays still: interactions redraw, they do not re-simulate.
 */

export interface LayoutNode {
	id: string;
	x: number;
	y: number;
	vx: number;
	vy: number;
	label: string;
	color: string;
	type?: string;
	radius: number;
	degree: number;
}

export interface LayoutEdge {
	source: string;
	target: string;
	type?: "link" | "tag";
}

export interface GraphView {
	x: number;
	y: number;
	scale: number;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const MIN_PADDING = 32;
const LABEL_FONT = "10px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
const LABEL_FONT_BOLD = "600 10.5px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif";

export function initializeLayout(
	nodes: { id: string; label: string; color: string; degree?: number }[],
	edges: LayoutEdge[],
	width: number,
	height: number,
): LayoutNode[] {
	const logicalWidth = Math.max(240, width);
	const logicalHeight = Math.max(180, height);
	const padding = Math.min(MIN_PADDING, Math.max(18, Math.min(logicalWidth, logicalHeight) * 0.08));
	const usableWidth = Math.max(1, logicalWidth - padding * 2);
	const usableHeight = Math.max(1, logicalHeight - padding * 2);
	const nodeIds = new Set(nodes.map((node) => node.id));
	const adjacency = new Map<string, Set<string>>();
	for (const node of nodes) adjacency.set(node.id, new Set());
	for (const edge of edges) {
		if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
		adjacency.get(edge.source)?.add(edge.target);
		adjacency.get(edge.target)?.add(edge.source);
	}

	const nodeById = new Map(nodes.map((node) => [node.id, node]));
	const seen = new Set<string>();
	const components: string[][] = [];
	const sortedSeeds = [...nodes].sort(compareNode);
	for (const seed of sortedSeeds) {
		if (seen.has(seed.id)) continue;
		const stack = [seed.id];
		const component: string[] = [];
		seen.add(seed.id);
		while (stack.length) {
			const id = stack.pop()!;
			component.push(id);
			const neighbors = [...(adjacency.get(id) ?? [])].sort((a, b) => compareNode(nodeById.get(a)!, nodeById.get(b)!));
			for (const neighbor of neighbors) {
				if (seen.has(neighbor)) continue;
				seen.add(neighbor);
				stack.push(neighbor);
			}
		}
		component.sort((a, b) => compareNode(nodeById.get(a)!, nodeById.get(b)!));
		components.push(component);
	}
	components.sort((a, b) => {
		const degreeA = a.reduce((total, id) => total + (nodeById.get(id)?.degree ?? 1), 0);
		const degreeB = b.reduce((total, id) => total + (nodeById.get(id)?.degree ?? 1), 0);
		return b.length - a.length || degreeB - degreeA || a[0].localeCompare(b[0]);
	});

	const componentCenters = placeComponentCenters(components, usableWidth, usableHeight, padding);
	const positions = new Map<string, { x: number; y: number }>();
	for (let i = 0; i < components.length; i++) {
		const component = components[i];
		const center = componentCenters[i];
		const radiusLimit = componentRadiusLimit(center.x, center.y, logicalWidth, logicalHeight, padding);
		placeComponent(component, nodeById, positions, center.x, center.y, Math.max(18, radiusLimit));
	}

	return nodes.map((n) => {
		const position = positions.get(n.id) ?? { x: logicalWidth / 2, y: logicalHeight / 2 };
		return {
			...n,
			x: clamp(position.x, padding, logicalWidth - padding),
			y: clamp(position.y, padding, logicalHeight - padding),
			vx: 0,
			vy: 0,
			degree: n.degree ?? 1,
			radius: Math.min(14, 5.5 + Math.sqrt(n.degree ?? 1) * 1.15),
		};
	});
}

export function drawGraph(
	ctx: CanvasRenderingContext2D,
	nodes: LayoutNode[],
	edges: LayoutEdge[],
	width: number,
	height: number,
	selectedId: string | null,
	hoveredId: string | null,
	pixelRatio = 1,
	view: GraphView = { x: 0, y: 0, scale: 1 },
) {
	const nodeIndex = new Map(nodes.map((n) => [n.id, n]));
	const logicalWidth = width / pixelRatio;
	const logicalHeight = height / pixelRatio;
	const topLabels = new Set(
		[...nodes]
			.sort((a, b) => b.degree - a.degree || a.label.localeCompare(b.label))
			.slice(0, Math.min(8, Math.ceil(nodes.length * 0.18)))
			.map((node) => node.id),
	);

	ctx.save();
	ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
	ctx.clearRect(0, 0, logicalWidth, logicalHeight);
	ctx.fillStyle = "#0d1117";
	ctx.fillRect(0, 0, logicalWidth, logicalHeight);
	drawGrid(ctx, logicalWidth, logicalHeight, view);
	ctx.translate(view.x, view.y);
	ctx.scale(view.scale, view.scale);
	ctx.lineCap = "round";
	ctx.lineJoin = "round";

	const focusId = hoveredId ?? selectedId;
	const neighbors = new Set<string>();
	if (focusId) {
		for (const edge of edges) {
			if (edge.source === focusId) neighbors.add(edge.target);
			if (edge.target === focusId) neighbors.add(edge.source);
		}
	}

	// Draw edges
	for (const edge of edges) {
		const s = nodeIndex.get(edge.source);
		const t = nodeIndex.get(edge.target);
		if (!s || !t) continue;
		const focused = !focusId || edge.source === focusId || edge.target === focusId;
		ctx.strokeStyle = focused ? "rgba(88, 166, 255, 0.82)" : "rgba(139, 148, 158, 0.24)";
		ctx.lineWidth = focused ? 1.6 : 1.05;
		ctx.beginPath();
		ctx.moveTo(s.x, s.y);
		ctx.lineTo(t.x, t.y);
		ctx.stroke();
	}

	// Draw nodes
	for (const node of nodes) {
		const isHighlighted = node.id === selectedId || node.id === hoveredId;
		const isNeighbor = focusId ? neighbors.has(node.id) : true;
		const isDimmed = focusId ? !isHighlighted && !isNeighbor : false;
		const r = isHighlighted ? node.radius + 2.2 : node.radius;
		const rgb = hexToRgb(node.color);
		const alpha = isDimmed ? 0.16 : 1;

		ctx.beginPath();
		ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
		ctx.fillStyle = rgb ? `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${isHighlighted ? 0.28 : 0.16})` : "rgba(139, 148, 158, 0.18)";
		ctx.globalAlpha = alpha;
		ctx.fill();

		if (isHighlighted) {
			ctx.shadowColor = "rgba(88, 166, 255, 0.42)";
			ctx.shadowBlur = 12;
			ctx.strokeStyle = "#58a6ff";
			ctx.lineWidth = 2.8;
			ctx.stroke();
			ctx.shadowBlur = 0;
		} else {
			ctx.strokeStyle = node.color;
			ctx.lineWidth = focusId && isNeighbor ? 2.2 : 1.8;
			ctx.stroke();
		}
		ctx.globalAlpha = 1;

		const shouldLabel = isHighlighted || (focusId && isNeighbor) || (!focusId && topLabels.has(node.id));
		if (shouldLabel) {
			drawLabel(ctx, node.label, node.x, node.y + r + 8, isHighlighted, isDimmed);
		}
	}
	ctx.restore();
}

export function hitTest(nodes: LayoutNode[], x: number, y: number): LayoutNode | null {
	for (let i = nodes.length - 1; i >= 0; i--) {
		const node = nodes[i];
		const dx = x - node.x;
		const dy = y - node.y;
		if (dx * dx + dy * dy <= (node.radius + 4) * (node.radius + 4)) {
			return node;
		}
	}
	return null;
}

function compareNode(
	a: { id: string; label: string; degree?: number },
	b: { id: string; label: string; degree?: number },
) {
	return (b.degree ?? 1) - (a.degree ?? 1) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id);
}

function placeComponentCenters(components: string[][], usableWidth: number, usableHeight: number, padding: number) {
	const cx = padding + usableWidth / 2;
	const cy = padding + usableHeight / 2;
	const centers: { x: number; y: number }[] = [];
	const ringX = Math.max(70, usableWidth * 0.31);
	const ringY = Math.max(54, usableHeight * 0.29);

	for (let i = 0; i < components.length; i++) {
		if (i === 0) {
			centers.push({ x: cx, y: cy });
			continue;
		}
		const angle = (i - 1) * GOLDEN_ANGLE - Math.PI / 2;
		const ring = 1 + Math.floor(Math.sqrt(i - 1) / 2);
		const scale = Math.min(1, 0.7 + ring * 0.22);
		centers.push({
			x: clamp(cx + Math.cos(angle) * ringX * scale, padding + 24, padding + usableWidth - 24),
			y: clamp(cy + Math.sin(angle) * ringY * scale, padding + 24, padding + usableHeight - 24),
		});
	}

	return centers;
}

function componentRadiusLimit(x: number, y: number, width: number, height: number, padding: number) {
	return Math.max(
		18,
		Math.min(x - padding, y - padding, width - padding - x, height - padding - y),
	);
}

function placeComponent(
	component: string[],
	nodeById: Map<string, { id: string; label: string; degree?: number }>,
	positions: Map<string, { x: number; y: number }>,
	cx: number,
	cy: number,
	radiusLimit: number,
) {
	if (component.length === 0) return;
	if (component.length === 1) {
		positions.set(component[0], { x: cx, y: cy });
		return;
	}
	if (component.length === 2) {
		const spread = Math.min(44, radiusLimit);
		positions.set(component[0], { x: cx - spread / 2, y: cy });
		positions.set(component[1], { x: cx + spread / 2, y: cy });
		return;
	}

	positions.set(component[0], { x: cx, y: cy });
	const remaining = component.slice(1);
	const ringGap = clamp(radiusLimit / Math.max(1.8, Math.sqrt(remaining.length)), 26, 58);
	let cursor = 0;
	let ring = 1;
	while (cursor < remaining.length) {
		const ringRadius = Math.min(radiusLimit, ring * ringGap);
		const capacity = Math.max(6, Math.floor((Math.PI * 2 * ringRadius) / 34));
		const count = Math.min(capacity, remaining.length - cursor);
		for (let i = 0; i < count; i++) {
			const id = remaining[cursor + i];
			const angle = (i / count) * Math.PI * 2 + ring * 0.47 + cursor * 0.13;
			const node = nodeById.get(id);
			const degreePush = Math.min(0.18, ((node?.degree ?? 1) - 1) * 0.025);
			const radius = Math.max(18, ringRadius * (1 - degreePush));
			positions.set(id, {
				x: cx + Math.cos(angle) * radius,
				y: cy + Math.sin(angle) * radius,
			});
		}
		cursor += count;
		ring++;
	}
}

function drawLabel(
	ctx: CanvasRenderingContext2D,
	label: string,
	x: number,
	y: number,
	strong: boolean,
	dimmed: boolean,
) {
	ctx.font = strong ? LABEL_FONT_BOLD : LABEL_FONT;
	ctx.textAlign = "center";
	ctx.textBaseline = "top";
	const lines = splitLabel(label);
	ctx.fillStyle = dimmed ? "rgba(139, 148, 158, 0.26)" : strong ? "#e6edf3" : "#8b949e";
	for (let i = 0; i < lines.length; i++) {
		ctx.fillText(lines[i], x, y + i * 11.5, 112);
	}
}

function drawGrid(ctx: CanvasRenderingContext2D, width: number, height: number, view: GraphView) {
	const gap = 56 * view.scale;
	if (gap < 18) return;
	const startX = ((view.x % gap) + gap) % gap;
	const startY = ((view.y % gap) + gap) % gap;
	ctx.save();
	ctx.strokeStyle = "rgba(48, 54, 61, 0.22)";
	ctx.lineWidth = 1;
	for (let x = startX; x < width; x += gap) {
		ctx.beginPath();
		ctx.moveTo(x, 0);
		ctx.lineTo(x, height);
		ctx.stroke();
	}
	for (let y = startY; y < height; y += gap) {
		ctx.beginPath();
		ctx.moveTo(0, y);
		ctx.lineTo(width, y);
		ctx.stroke();
	}
	ctx.restore();
}

function splitLabel(label: string) {
	const clean = label.trim();
	if (clean.length <= 12) return [clean];
	const parts = clean.includes(" ") ? clean.split(/\s+/) : clean.match(/.{1,9}/g) ?? [clean];
	const lines: string[] = [];
	let current = "";
	for (const part of parts) {
		const next = current ? `${current} ${part}` : part;
		if (next.length > 12 && current) {
			lines.push(current);
			current = part;
		} else {
			current = next;
		}
		if (lines.length === 2) break;
	}
	if (current && lines.length < 2) lines.push(current);
	return lines.map((line, index) => index === 1 && line.length > 12 ? `${line.slice(0, 11)}...` : line);
}

function hexToRgb(hex: string) {
	const normalized = hex.replace("#", "");
	if (!/^[0-9a-f]{6}$/i.test(normalized)) return null;
	const value = Number.parseInt(normalized, 16);
	return {
		r: (value >> 16) & 255,
		g: (value >> 8) & 255,
		b: value & 255,
	};
}

function clamp(value: number, min: number, max: number) {
	if (max < min) return min;
	return Math.max(min, Math.min(max, value));
}
