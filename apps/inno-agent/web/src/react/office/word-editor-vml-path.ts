/** VML coordinates allow omitted zeroes (m,l,21600) and adjacent @/# references. */
export type VmlPoint = [number, number];
export type VmlCommand = { kind: "moveTo" | "lnTo" | "cubicBezTo" | "quadBezTo" | "close"; points: VmlPoint[] };
export interface VmlPath { commands: VmlCommand[]; fill: boolean; stroke: boolean }

export function vmlNumbers(source: string, resolve: (value: string) => number): number[] {
	return source.trim().split(",").flatMap((part) => {
		const tokens = part.trim().match(/[@#]\d+|[+-]?(?:\d*\.\d+|\d+)/g);
		if (!tokens) return [0];
		if (part.replace(/[@#]\d+|[+-]?(?:\d*\.\d+|\d+)|\s/g, "")) throw new Error("Invalid VML coordinate");
		return tokens.map(resolve);
	});
}

export function vmlFormulaResolver(equations: string[], adjustments: string, width: number, height: number): (value: string) => number {
	const adj = adjustments.split(",").map((value) => Number(value || 0));
	const values: number[] = [];
	const resolve = (value: string): number => {
		const n = value.startsWith("@") ? values[Number(value.slice(1))]
			: value.startsWith("#") ? adj[Number(value.slice(1))]
				: value === "width" ? width : value === "height" ? height : Number(value);
		if (!Number.isFinite(n) || Math.abs(n) > 1e12) throw new Error("Invalid VML formula");
		return n;
	};
	if (equations.length > 256) throw new Error("Too many VML formulas");
	for (const equation of equations) {
		const [op, ...args] = equation.trim().split(/\s+/);
		const [a = 0, b = 0, c = 0] = args.map(resolve);
		let value: number;
		switch (op) {
			case "val": value = a; break;
			case "sum": value = a + b - c; break;
			case "prod": value = a * b / c; break;
			case "mid": value = (a + b) / 2; break;
			case "abs": value = Math.abs(a); break;
			case "min": value = Math.min(a, b); break;
			case "max": value = Math.max(a, b); break;
			case "if": value = a > 0 ? b : c; break;
			case "sqrt": value = Math.sqrt(a); break;
			case "mod": value = Math.hypot(a, b, c); break;
			case "sin": value = a * Math.sin(b / 65536 * Math.PI / 180); break;
			case "cos": value = a * Math.cos(b / 65536 * Math.PI / 180); break;
			case "tan": value = a * Math.tan(b / 65536 * Math.PI / 180); break;
			case "atan2": value = Math.atan2(b, a) * 180 / Math.PI * 65536; break;
			case "sinatan2": value = a * Math.sin(Math.atan2(c, b)); break;
			case "cosatan2": value = a * Math.cos(Math.atan2(c, b)); break;
			case "sumangle": value = a + b * 65536 - c * 65536; break;
			case "ellipse": value = c * Math.sqrt(1 - a * a / (b * b)); break;
			default: throw new Error("Unsupported VML formula");
		}
		if (!Number.isFinite(value) || Math.abs(value) > 1e12) throw new Error("Invalid VML formula");
		values.push(value);
	}
	return resolve;
}

/** Convert to absolute DrawingML segments; never execute document expressions. */
export function parseVmlPath(source: string, resolve: (value: string) => number): VmlPath[] {
	if (source.length > 128_000) throw new Error("VML path too large");
	const paths: VmlPath[] = [];
	let path: VmlPath = { commands: [], fill: true, stroke: true };
	let current: VmlPoint = [0, 0];
	let start: VmlPoint = [0, 0];
	let offset = 0;
	const finish = () => { if (path.commands.length) paths.push(path); path = { commands: [], fill: true, stroke: true }; };
	for (const match of source.matchAll(/([a-z]+)([^a-z]*)/gi)) {
		if (source.slice(offset, match.index).trim()) throw new Error("Invalid VML path");
		offset = match.index! + match[0].length;
		const op = match[1].toLowerCase();
		// Commands are concatenated in Word's paths: xe, nfc, ...
		const commands = op.match(/nf|ns|qb|qx|qy|[mlcrvtxe]/g) ?? [];
		if (commands.join("") !== op) throw new Error("Unsupported VML path command");
		for (let ci = 0; ci < commands.length; ci++) {
			const command = commands[ci];
			const params = ci === commands.length - 1 ? match[2] : "";
			if (command === "nf") { path.fill = false; continue; }
			if (command === "ns") { path.stroke = false; continue; }
			if (command === "e") { finish(); continue; }
			if (command === "x") { path.commands.push({ kind: "close", points: [] }); current = [...start]; continue; }
			const count = command === "c" || command === "v" ? 6 : command === "qb" ? 4 : 2;
			const numbers = vmlNumbers(params, resolve);
			// Missing final coordinate is also zero (e.g. m@0, or m).
			while (numbers.length % count) numbers.push(0);
			for (let i = 0; i < numbers.length; i += count) {
				const points: VmlPoint[] = [];
				for (let j = 0; j < count; j += 2) points.push([numbers[i + j], numbers[i + j + 1]]);
				if (["r", "v", "t"].includes(command)) for (const point of points) { point[0] += current[0]; point[1] += current[1]; }
				let kind: VmlCommand["kind"] = command === "c" || command === "v" ? "cubicBezTo" : command === "qb" ? "quadBezTo" : (command === "m" || command === "t") && i === 0 ? "moveTo" : "lnTo";
				if (command === "qx" || command === "qy") {
					// Elliptical quadrant, alternating tangent direction for repeated pairs.
					const end = points[0]; const k = 0.5522847498307936;
					const horizontal = (command === "qx") !== (i / count % 2 === 1);
					points.unshift(horizontal ? [current[0] + (end[0] - current[0]) * k, current[1]] : [current[0], current[1] + (end[1] - current[1]) * k], horizontal ? [end[0], end[1] - (end[1] - current[1]) * k] : [end[0] - (end[0] - current[0]) * k, end[1]]);
					kind = "cubicBezTo";
				}
				path.commands.push({ kind, points });
				current = [...points[points.length - 1]];
				if (kind === "moveTo") start = [...current];
				if (path.commands.length > 4096 || paths.length > 256) throw new Error("VML path too complex");
			}
		}
	}
	if (source.slice(offset).trim()) throw new Error("Invalid VML path");
	finish();
	if (!paths.length) throw new Error("Empty VML path");
	return paths;
}
