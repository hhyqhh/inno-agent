import { describe, expect, it } from "vitest";
import { ForceSimulation, type SimNode } from "./force-simulation.js";

function node(id: string, x: number, y: number, group = 0): SimNode {
	return { id, x, y, vx: 0, vy: 0, radius: 7, fixed: false, group };
}

function settle(sim: ForceSimulation) {
	sim.reheat(0.35);
	for (let tick = 0; tick < 1_000 && sim.running; tick++) sim.tick();
	expect(sim.running).toBe(false);
}

describe("notebook force layout", () => {
	it("brings distant disconnected pages near the graph before cooling, keeping them separated", () => {
		const connected = Array.from({ length: 30 }, (_, i) => node(`page-${i}`, (i % 6 - 2.5) * 70, (Math.floor(i / 6) - 2) * 55));
		const isolates = [
			node("isolated-left", -1_200, 0, 1),
			node("isolated-right", 1_200, 0, 2),
			node("isolated-top", 0, -1_200, 3),
			node("isolated-bottom", 0, 1_200, 4),
			node("isolated-corner", 1_200, 1_000, 5),
		];
		const nodes = [...connected, ...isolates];
		const sim = new ForceSimulation({ groupStrength: 0.025 });
		sim.setGraph(nodes, connected.slice(1).map((_, i) => ({ source: i, target: i + 1, length: 150, strength: 0.2 })));
		sim.setCenter(nodes.reduce((sum, n) => sum + n.x, 0) / nodes.length, nodes.reduce((sum, n) => sum + n.y, 0) / nodes.length);
		settle(sim);

		const center = {
			x: connected.reduce((sum, n) => sum + n.x, 0) / connected.length,
			y: connected.reduce((sum, n) => sum + n.y, 0) / connected.length,
		};
		for (const isolated of isolates) {
			expect(Math.hypot(isolated.x - center.x, isolated.y - center.y)).toBeLessThan(500);
			for (const other of nodes) {
				if (other === isolated) continue;
				expect(Math.hypot(isolated.x - other.x, isolated.y - other.y)).toBeGreaterThan(isolated.radius + other.radius + 20);
			}
		}
	});

	it("keeps a grabbed node fixed while gravity pulls nearby disconnected nodes inward", () => {
		const fixed = { ...node("grabbed", 1_200, 900), fixed: true };
		const free = node("free", -1_200, -900, 1);
		const sim = new ForceSimulation();
		sim.setGraph([fixed, free], []);
		sim.setCenter(0, 0);
		settle(sim);
		expect({ x: fixed.x, y: fixed.y, vx: fixed.vx, vy: fixed.vy }).toEqual({ x: 1_200, y: 900, vx: 0, vy: 0 });
		expect(Math.hypot(free.x, free.y)).toBeLessThan(500);
	});
});
