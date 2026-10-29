/**
 * Continuous force simulation for the notebook graph.
 *
 * Modelled on d3-force's velocity-Verlet integrator so the graph keeps a live
 * physics state: dragging a node drags its neighbours through link springs
 * while every node pushes its neighbours away. Repulsion uses a spatial hash
 * with a cutoff instead of Barnes-Hut, which keeps a tick O(n) and is enough
 * because centering gravity — not long-range repulsion — is what spreads
 * disconnected components apart.
 *
 * The simulation owns positions only; the caller is responsible for reading
 * them back onto whatever renders the graph.
 */

export interface SimNode {
	id: string;
	x: number;
	y: number;
	vx: number;
	vy: number;
	/** Rendered radius; drives repulsion mass and the minimum spring length. */
	radius: number;
	/** Held in place by a drag or an explicit pin. */
	fixed: boolean;
	/** Community id, used by the optional group cohesion force. */
	group: number;
}

export interface SimLink {
	source: number;
	target: number;
	length: number;
	strength: number;
}

export interface ForceSimulationOptions {
	/** Pairwise repulsion coefficient; force falls off as 1/d². */
	repulsion: number;
	/** Distance beyond which repulsion is not evaluated. */
	repulsionCutoff: number;
	/** Pull towards the layout centre, per pixel of offset. */
	centerStrength: number;
	/** Pull towards the node's own community centroid. */
	groupStrength: number;
	/** Fraction of velocity kept between ticks. */
	velocityDecay: number;
	alphaDecay: number;
	alphaMin: number;
	/** Horizontal clearance kept between node edges, sized for labels. */
	collidePaddingX: number;
	/** Vertical clearance kept between node edges. */
	collidePaddingY: number;
	/** Relaxation passes per tick for the separation constraint. */
	collideIterations: number;
	/** Fraction of an overlap corrected per pass; <1 keeps the pass springy. */
	collideRelax: number;
	/** How much of the positional correction is also removed from velocity. */
	collideDamping: number;
}

export const DEFAULT_FORCE_OPTIONS: ForceSimulationOptions = {
	repulsion: 6_600,
	repulsionCutoff: 440,
	// At 0.005 the layout cools before disconnected seed communities return:
	// isolated pages remain hundreds of pixels beyond the connected graph.
	// Stronger gravity closes that gap; repulsion/collisions retain separation.
	centerStrength: 0.03,
	groupStrength: 0,
	velocityDecay: 0.72,
	alphaDecay: 0.022,
	alphaMin: 0.006,
	collidePaddingX: 74,
	collidePaddingY: 30,
	collideIterations: 2,
	collideRelax: 0.55,
	collideDamping: 0.5,
};

/** Cap per-tick velocity so a near-zero distance cannot fling nodes offscreen. */
const MAX_VELOCITY = 45;

/** Largest node radius produced by the sizing formula in GraphView. */
const MAX_NODE_RADIUS = 14.5;

export class ForceSimulation {
	private nodes: SimNode[] = [];
	private links: SimLink[] = [];
	private index = new Map<string, SimNode>();
	private fx: Float64Array = new Float64Array(0);
	private fy: Float64Array = new Float64Array(0);
	private groupCentroids = new Map<number, { x: number; y: number; count: number }>();
	private centerX = 0;
	private centerY = 0;

	alpha = 0;
	alphaTarget = 0;
	options: ForceSimulationOptions;

	constructor(options: Partial<ForceSimulationOptions> = {}) {
		this.options = { ...DEFAULT_FORCE_OPTIONS, ...options };
	}

	setGraph(nodes: SimNode[], links: SimLink[]): void {
		this.nodes = nodes;
		this.links = links;
		this.index = new Map(nodes.map((node) => [node.id, node]));
		this.fx = new Float64Array(nodes.length);
		this.fy = new Float64Array(nodes.length);
	}

	getNode(id: string): SimNode | undefined {
		return this.index.get(id);
	}

	get nodeCount(): number {
		return this.nodes.length;
	}

	setCenter(x: number, y: number): void {
		this.centerX = x;
		this.centerY = y;
	}

	/** Kick the simulation back to life, e.g. on drag or a layout change. */
	reheat(alpha = 0.45, target = 0): void {
		this.alpha = Math.max(this.alpha, alpha);
		this.alphaTarget = target;
	}

	stop(): void {
		this.alpha = 0;
		this.alphaTarget = 0;
	}

	get running(): boolean {
		return this.alpha > this.options.alphaMin || this.alphaTarget > 0;
	}

	tick(): void {
		const { alphaDecay, alphaMin, velocityDecay } = this.options;
		this.alpha += (this.alphaTarget - this.alpha) * alphaDecay;
		if (this.alpha < alphaMin && this.alphaTarget === 0) {
			this.alpha = 0;
			return;
		}

		this.fx.fill(0);
		this.fy.fill(0);
		this.applyRepulsion();
		this.applyLinks();
		this.applyCentering();

		const alpha = this.alpha;
		for (let i = 0; i < this.nodes.length; i++) {
			const node = this.nodes[i];
			if (node.fixed) {
				node.vx = 0;
				node.vy = 0;
				continue;
			}
			node.vx = (node.vx + this.fx[i] * alpha) * velocityDecay;
			node.vy = (node.vy + this.fy[i] * alpha) * velocityDecay;
			const speed = Math.hypot(node.vx, node.vy);
			if (speed > MAX_VELOCITY) {
				const scale = MAX_VELOCITY / speed;
				node.vx *= scale;
				node.vy *= scale;
			}
			node.x += node.vx;
			node.y += node.vy;
		}

		this.resolveCollisions();
	}

	/**
	 * Hard separation pass. Repulsion alone leaves nodes closer than their
	 * labels need, so nudge overlapping pairs apart positionally — the label box
	 * is wider than tall, hence the asymmetric padding.
	 */
	private resolveCollisions(): void {
		const { collidePaddingX, collidePaddingY, collideIterations, collideRelax, collideDamping } =
			this.options;
		if (collideIterations <= 0) return;
		const cell = 2 * (MAX_NODE_RADIUS + collidePaddingX);
		for (let pass = 0; pass < collideIterations; pass++) {
			const bins = new Map<string, number[]>();
			for (let i = 0; i < this.nodes.length; i++) {
				const node = this.nodes[i];
				const key = `${Math.floor(node.x / cell)},${Math.floor(node.y / cell)}`;
				const bin = bins.get(key);
				if (bin) bin.push(i);
				else bins.set(key, [i]);
			}
			for (let i = 0; i < this.nodes.length; i++) {
				const a = this.nodes[i];
				const bx = Math.floor(a.x / cell);
				const by = Math.floor(a.y / cell);
				for (let gx = bx - 1; gx <= bx + 1; gx++) {
					for (let gy = by - 1; gy <= by + 1; gy++) {
						const bin = bins.get(`${gx},${gy}`);
						if (!bin) continue;
						for (const j of bin) {
							if (j <= i) continue;
							const b = this.nodes[j];
							// Scale to an ellipse so a wide label clears sideways
							// while stacked rows stay compact.
							const aspect = (collidePaddingX + MAX_NODE_RADIUS) / (collidePaddingY + MAX_NODE_RADIUS);
							const dx = (b.x - a.x) / aspect;
							const dy = b.y - a.y;
							const minDist = a.radius + b.radius + collidePaddingY;
							let dist = Math.hypot(dx, dy);
							if (dist >= minDist) continue;
							let ux: number;
							let uy: number;
							if (dist < 0.001) {
								ux = ((i * 37 + j * 17) % 13) - 6 || 1;
								uy = ((i * 19 + j * 41) % 11) - 5 || 1;
								dist = Math.hypot(ux, uy);
								ux /= dist;
								uy /= dist;
							} else {
								ux = dx / dist;
								uy = dy / dist;
							}
							// Relax rather than fully separate: a hard positional
							// snap fights the spring pulling the pair together and
							// the two never agree, which reads as jitter.
							const push = ((minDist - dist) / 2) * collideRelax;
							const px = ux * push * aspect;
							const py = uy * push;
							if (!a.fixed) {
								a.x -= px;
								a.y -= py;
								// Cancel the inbound velocity component too, so the
								// next tick does not re-close the gap we just opened.
								a.vx -= px * collideDamping;
								a.vy -= py * collideDamping;
							}
							if (!b.fixed) {
								b.x += px;
								b.y += py;
								b.vx += px * collideDamping;
								b.vy += py * collideDamping;
							}
						}
					}
				}
			}
		}
	}
	/**
	 * O(n) short-range repulsion: bin nodes into a grid sized to the cutoff and
	 * only evaluate pairs within the 3×3 neighbourhood of each bin.
	 */
	private applyRepulsion(): void {
		const { repulsion, repulsionCutoff } = this.options;
		const cell = repulsionCutoff;
		const cutoffSq = repulsionCutoff * repulsionCutoff;
		const bins = new Map<string, number[]>();
		for (let i = 0; i < this.nodes.length; i++) {
			const node = this.nodes[i];
			const key = `${Math.floor(node.x / cell)},${Math.floor(node.y / cell)}`;
			const bin = bins.get(key);
			if (bin) bin.push(i);
			else bins.set(key, [i]);
		}

		for (let i = 0; i < this.nodes.length; i++) {
			const a = this.nodes[i];
			const bx = Math.floor(a.x / cell);
			const by = Math.floor(a.y / cell);
			for (let gx = bx - 1; gx <= bx + 1; gx++) {
				for (let gy = by - 1; gy <= by + 1; gy++) {
					const bin = bins.get(`${gx},${gy}`);
					if (!bin) continue;
					for (const j of bin) {
						if (j <= i) continue;
						const b = this.nodes[j];
						let dx = b.x - a.x;
						let dy = b.y - a.y;
						let distSq = dx * dx + dy * dy;
						if (distSq >= cutoffSq) continue;
						if (distSq < 1) {
							// Deterministic jitter to split co-located nodes.
							dx = ((i * 37 + j * 17) % 13) - 6 || 1;
							dy = ((i * 19 + j * 41) % 11) - 5 || 1;
							distSq = dx * dx + dy * dy;
						}
						const dist = Math.sqrt(distSq);
						// Taper to zero at the cutoff so nodes crossing it do not pop.
						const taper = 1 - dist / repulsionCutoff;
						const mass = (a.radius + b.radius) / 14;
						const force = (repulsion * mass * taper) / distSq;
						const fx = (dx / dist) * force;
						const fy = (dy / dist) * force;
						this.fx[i] -= fx;
						this.fy[i] -= fy;
						this.fx[j] += fx;
						this.fy[j] += fy;
					}
				}
			}
		}
	}

	private applyLinks(): void {
		for (const link of this.links) {
			const a = this.nodes[link.source];
			const b = this.nodes[link.target];
			let dx = b.x - a.x;
			let dy = b.y - a.y;
			let dist = Math.hypot(dx, dy);
			if (dist < 1) {
				dx = 1;
				dy = 0;
				dist = 1;
			}
			const minLength = a.radius + b.radius + 34;
			const rest = Math.max(link.length, minLength);
			const displacement = ((dist - rest) / dist) * link.strength;
			const fx = dx * displacement;
			const fy = dy * displacement;
			this.fx[link.source] += fx;
			this.fy[link.source] += fy;
			this.fx[link.target] -= fx;
			this.fy[link.target] -= fy;
		}
	}

	private applyCentering(): void {
		const { centerStrength, groupStrength } = this.options;
		if (groupStrength > 0) {
			this.groupCentroids.clear();
			for (const node of this.nodes) {
				const centroid = this.groupCentroids.get(node.group);
				if (centroid) {
					centroid.x += node.x;
					centroid.y += node.y;
					centroid.count += 1;
				} else {
					this.groupCentroids.set(node.group, { x: node.x, y: node.y, count: 1 });
				}
			}
			for (const centroid of this.groupCentroids.values()) {
				centroid.x /= centroid.count;
				centroid.y /= centroid.count;
			}
		}
		for (let i = 0; i < this.nodes.length; i++) {
			const node = this.nodes[i];
			this.fx[i] += (this.centerX - node.x) * centerStrength;
			this.fy[i] += (this.centerY - node.y) * centerStrength;
			if (groupStrength > 0) {
				const centroid = this.groupCentroids.get(node.group);
				if (centroid && centroid.count > 1) {
					this.fx[i] += (centroid.x - node.x) * groupStrength;
					this.fy[i] += (centroid.y - node.y) * groupStrength;
				}
			}
		}
	}
}
