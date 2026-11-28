import { useId } from "react";
import { useReducedMotion } from "motion/react";

const CYCLE_DURATION = "4.4s";

interface Particle {
	x: string;
	y: string;
	xm: string;
	ym: string;
	xe: string;
	ye: string;
	r0: string;
	r1: string;
	r2: string;
	er: string;
	t1: string;
	t2: string;
	t3: string;
	t4: string;
}

type QuadCurve = readonly [number, number, number, number, number, number, number];

function mulberry32(seed: number): () => number {
	let state = seed;
	return () => {
		state += 0x6d2b79f5;
		let t = Math.imul(state ^ (state >>> 15), state | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Sample particles directly along a quadratic Bezier stroke so erosion and
 *  particle liftoff align cleanly with the curved ribbon paths. */
function sampleQuadCurve(
	[x0, y0, cx, cy, x1, y1, count]: QuadCurve,
	rand: () => number,
	baseDelay: number,
	spreadDelay: number,
): Particle[] {
	const list: Particle[] = [];
	for (let i = 0; i < count; i++) {
		const u = count === 1 ? 0.5 : i / (count - 1);
		const inv = 1 - u;
		const bx = inv * inv * x0 + 2 * inv * u * cx + u * u * x1;
		const by = inv * inv * y0 + 2 * inv * u * cy + u * u * y1;
		const x = bx + (rand() - 0.5) * 3.2;
		const y = by + (rand() - 0.5) * 3.2;
		const wave = ((bx - 108) / 98) * 0.65 + ((128 - by) / 72) * 0.35;
		const t = Math.max(0.01, Math.min(0.92, baseDelay + wave * spreadDelay + (rand() - 0.5) * 0.02));
		const angle = -0.7 + (rand() - 0.5) * 1.4;
		const dist = 6 + rand() * 11;
		const dx = Math.cos(angle) * dist;
		const dy = Math.sin(angle) * dist - 1.5;
		const roll = rand();
		const r = roll < 0.45 ? 1.3 + rand() * 0.6 : roll < 0.82 ? 2.1 + rand() * 0.7 : 2.9 + rand() * 0.8;
		list.push({
			x: x.toFixed(1),
			y: y.toFixed(1),
			xm: (x + dx * 0.62).toFixed(1),
			ym: (y + dy * 0.62).toFixed(1),
			xe: (x + dx).toFixed(1),
			ye: (y + dy).toFixed(1),
			r0: (r * 0.35).toFixed(1),
			r1: r.toFixed(1),
			r2: (r * 0.6).toFixed(1),
			er: (8.5 + r * 1.4).toFixed(1),
			t1: t.toFixed(3),
			t2: (t + 0.06).toFixed(3),
			t3: (t + 0.14).toFixed(3),
			t4: (t + 0.2).toFixed(3),
		});
	}
	return list;
}

function createStardust(): { particles: Particle[]; eroders: Particle[] } {
	const rand = mulberry32(67);
	// Exact quadratic curves matching the /A and AI ribbon strokes below.
	const iaCurves: ReadonlyArray<QuadCurve> = [
		[144, 58, 128, 92, 111, 124, 18],
		[170, 58, 154, 92, 137, 124, 16],
		[170, 58, 188, 90, 201, 124, 16],
		[153, 105, 171, 96, 188, 105, 8],
	];
	const aiCurves: ReadonlyArray<QuadCurve> = [
		[148, 58, 131, 94, 114, 124, 16],
		[148, 58, 166, 90, 179, 124, 16],
		[131, 105, 149, 96, 166, 105, 8],
		[199, 58, 195, 92, 199, 124, 18],
	];
	const ia = iaCurves.flatMap((curve) => sampleQuadCurve(curve, rand, 0.02, 0.13));
	const ai = aiCurves.flatMap((curve) => sampleQuadCurve(curve, rand, 0.52, 0.13));
	return {
		particles: [...ia, ...ai],
		eroders: [...ia.filter((_, i) => i % 2 === 0), ...ai.filter((_, i) => i % 2 === 0)],
	};
}

const { particles: STARDUST, eroders: ERODERS } = createStardust();

/** Animated curved-ribbon /A <-> AI morphing mark with lightweight stardust dissolve. */
export function WorkingLogo({ className = "" }: { className?: string }) {
	const uid = useId().replace(/:/g, "");
	const reduceMotion = useReducedMotion();
	const maskLettersId = `inno-work-letters-${uid}`;
	const maskErodeId = `inno-work-erode-${uid}`;

	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="96 44 126 96"
			fill="none"
			aria-hidden="true"
			className={`inno-trace-working-logo${className ? ` ${className}` : ""}`}
		>
			<defs>
				<mask
					id={maskLettersId}
					maskUnits="userSpaceOnUse"
					maskContentUnits="userSpaceOnUse"
					x="0"
					y="0"
					width="320"
					height="180"
				>
					<g
						fill="none"
						stroke="#fff"
						strokeWidth="11"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<path d="M144 58 Q128 92 111 124">
							{!reduceMotion ? (
								<animate
									attributeName="d"
									dur={CYCLE_DURATION}
									repeatCount="indefinite"
									calcMode="spline"
									keyTimes="0;.34;.48;.84;.98;1"
									keySplines="0 0 1 1;.4 0 .2 1;0 0 1 1;.4 0 .2 1;0 0 1 1"
									values="M144 58 Q128 92 111 124;M144 58 Q128 92 111 124;M148 58 Q131 94 114 124;M148 58 Q131 94 114 124;M144 58 Q128 92 111 124;M144 58 Q128 92 111 124"
								/>
							) : null}
						</path>
						<path d="M170 58 Q154 92 137 124">
							{!reduceMotion ? (
								<animate
									attributeName="d"
									dur={CYCLE_DURATION}
									repeatCount="indefinite"
									calcMode="spline"
									keyTimes="0;.34;.48;.84;.98;1"
									keySplines="0 0 1 1;.4 0 .2 1;0 0 1 1;.4 0 .2 1;0 0 1 1"
									values="M170 58 Q154 92 137 124;M170 58 Q154 92 137 124;M148 58 Q166 90 179 124;M148 58 Q166 90 179 124;M170 58 Q154 92 137 124;M170 58 Q154 92 137 124"
								/>
							) : null}
						</path>
						<path d="M170 58 Q188 90 201 124">
							{!reduceMotion ? (
								<animate
									attributeName="d"
									dur={CYCLE_DURATION}
									repeatCount="indefinite"
									calcMode="spline"
									keyTimes="0;.34;.48;.84;.98;1"
									keySplines="0 0 1 1;.4 0 .2 1;0 0 1 1;.4 0 .2 1;0 0 1 1"
									values="M170 58 Q188 90 201 124;M170 58 Q188 90 201 124;M199 58 Q195 92 199 124;M199 58 Q195 92 199 124;M170 58 Q188 90 201 124;M170 58 Q188 90 201 124"
								/>
							) : null}
						</path>
						<path d="M153 105 Q171 96 188 105" strokeWidth="8">
							{!reduceMotion ? (
								<>
									<animate
										attributeName="d"
										dur={CYCLE_DURATION}
										repeatCount="indefinite"
										calcMode="spline"
										keyTimes="0;.34;.41;.48;.84;.91;.98;1"
										keySplines="0 0 1 1;.4 0 .2 1;.4 0 .2 1;0 0 1 1;.4 0 .2 1;.4 0 .2 1;0 0 1 1"
										values="M153 105 Q171 96 188 105;M153 105 Q171 96 188 105;M160 104 Q160 104 160 104;M131 105 Q149 96 166 105;M131 105 Q149 96 166 105;M160 104 Q160 104 160 104;M153 105 Q171 96 188 105;M153 105 Q171 96 188 105"
									/>
									<animate
										attributeName="opacity"
										dur={CYCLE_DURATION}
										repeatCount="indefinite"
										values="1;1;0;1;1;0;1;1"
										keyTimes="0;.34;.41;.48;.84;.91;.98;1"
									/>
								</>
							) : null}
						</path>
					</g>
				</mask>

				{!reduceMotion ? (
					<mask
						id={maskErodeId}
						maskUnits="userSpaceOnUse"
						maskContentUnits="userSpaceOnUse"
						x="0"
						y="0"
						width="320"
						height="180"
					>
						<rect width="320" height="180" fill="#fff" />
						<g fill="#000">
							{ERODERS.map((p, index) => (
								<circle key={index} cx={p.x} cy={p.y} r="0">
									<animate
										attributeName="r"
										dur={CYCLE_DURATION}
										repeatCount="indefinite"
										calcMode="spline"
										keyTimes={`0;${p.t1};${p.t2};${p.t3};${p.t4};1`}
										keySplines=".4 0 .2 1;.4 0 .2 1;.4 0 .2 1;.4 0 .2 1;.4 0 .2 1"
										values={`0;0;${p.er};${p.er};0;0`}
									/>
								</circle>
							))}
						</g>
					</mask>
				) : null}
			</defs>

			<g mask={reduceMotion ? undefined : `url(#${maskErodeId})`}>
				<g mask={`url(#${maskLettersId})`}>
					<rect width="320" height="180" fill="currentColor" />
				</g>
			</g>

			{!reduceMotion ? (
				<g fill="currentColor">
					{STARDUST.map((p, index) => (
						<circle
							key={index}
							cx={p.x}
							cy={p.y}
							r={p.r1}
							opacity="0"
						>
							<animate
								attributeName="cx"
								dur={CYCLE_DURATION}
								repeatCount="indefinite"
								calcMode="spline"
								keyTimes={`0;${p.t1};${p.t2};${p.t3};${p.t4};1`}
								keySplines=".22 1 .36 1;.4 0 .2 1;.4 0 .2 1;.4 0 .2 1;.4 0 .2 1"
								values={`${p.x};${p.x};${p.xm};${p.xe};${p.x};${p.x}`}
							/>
							<animate
								attributeName="cy"
								dur={CYCLE_DURATION}
								repeatCount="indefinite"
								calcMode="spline"
								keyTimes={`0;${p.t1};${p.t2};${p.t3};${p.t4};1`}
								keySplines=".22 1 .36 1;.4 0 .2 1;.4 0 .2 1;.4 0 .2 1;.4 0 .2 1"
								values={`${p.y};${p.y};${p.ym};${p.ye};${p.y};${p.y}`}
							/>
							<animate
								attributeName="opacity"
								dur={CYCLE_DURATION}
								repeatCount="indefinite"
								calcMode="spline"
								keyTimes={`0;${p.t1};${p.t2};${p.t3};${p.t4};1`}
								keySplines=".4 0 .2 1;.4 0 .2 1;.4 0 .2 1;.4 0 .2 1;.4 0 .2 1"
								values="0;0;0.95;0.55;0;0"
							/>
							<animate
								attributeName="r"
								dur={CYCLE_DURATION}
								repeatCount="indefinite"
								calcMode="spline"
								keyTimes={`0;${p.t1};${p.t2};${p.t3};${p.t4};1`}
								keySplines=".4 0 .2 1;.4 0 .2 1;.4 0 .2 1;.4 0 .2 1;.4 0 .2 1"
								values={`${p.r0};${p.r0};${p.r1};${p.r2};${p.r0};${p.r0}`}
							/>
						</circle>
					))}
				</g>
			) : null}
		</svg>
	);
}
