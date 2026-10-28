import type { Line, Point } from './geometry';
import type { Obstacle, Route, RoutePlan, SelectionScope } from './routes';
import type { Clearance } from './rules';
import type { Steps } from './work';
import { collision, dist, hardCollision, materialize, planSegmentRoute, resolvePlansSteps, taperedSegments } from './routes';
import { clearanceStep } from './rules';

const EPS = 0.001;
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
interface Support { lines: Line[]; normal: Point; tangent: Point; offset: number; min: number; max: number; net: string; layer: number }
interface Constraint { a: number; b: number; gap: number }

function* supports(selected: Route[]): Steps<Support[]> {
	const result: Support[] = [];
	for (const route of selected) {
		let previous: Support | undefined;
		for (const line of route.lines) {
			const length = dist(line.start, line.end);
			if (!Number.isFinite(length) || length <= EPS)
				throw new Error('目标包含无效或零长度线段');
			let tangent = { x: (line.end.x - line.start.x) / length, y: (line.end.y - line.start.y) / length };
			if (tangent.x < -EPS || (Math.abs(tangent.x) <= EPS && tangent.y < 0))
				tangent = { x: -tangent.x, y: -tangent.y };
			let normal = { x: -tangent.y, y: tangent.x };
			if (normal.y < -EPS || (Math.abs(normal.y) <= EPS && normal.x < 0))
				normal = { x: -normal.x, y: -normal.y };
			const a = dot(line.start, tangent);
			const b = dot(line.end, tangent);
			const node = { lines: [line], normal, tangent, offset: dot(line.start, normal), min: Math.min(a, b), max: Math.max(a, b), net: line.net, layer: line.layer };
			if (previous && dot(previous.normal, normal) > 1 - 1e-8 && Math.abs(previous.offset - node.offset) < EPS) {
				previous.lines.push(line);
				previous.min = Math.min(previous.min, node.min);
				previous.max = Math.max(previous.max, node.max);
			}
			else {
				result.push(node);
				previous = node;
			}
			yield;
		}
	}
	return result;
}

function* constraintsFor(nodes: Support[], spacing: number): Steps<Constraint[]> {
	const constraints: Constraint[] = [];
	for (let i = 0; i < nodes.length; i++) {
		yield;
		const a = nodes[i];
		for (let j = i + 1; j < nodes.length; j++) {
			const b = nodes[j];
			if (a.net === b.net || a.layer !== b.layer || dot(a.normal, b.normal) < 1 - 1e-8
				|| Math.min(a.max, b.max) - Math.max(a.min, b.min) <= EPS) {
				continue;
			}
			const gap = Math.abs(b.offset - a.offset);
			if (gap >= spacing - EPS)
				continue;
			constraints.push({ a: a.offset <= b.offset ? i : j, b: a.offset <= b.offset ? j : i, gap: spacing });
		}
	}
	return constraints;
}

function* displacements(nodes: Support[], constraints: Constraint[], bias: number): Steps<number[]> {
	const offsets = nodes.map(n => n.offset);
	// Original transverse order makes this a directed acyclic graph. Expand
	// each constrained component only; unrelated, already wide runs stay fixed.
	const order = nodes.map((_, i) => i).sort((a, b) => nodes[a].offset - nodes[b].offset);
	for (const i of order) {
		yield;
		for (const edge of constraints.filter(c => c.a === i))
			offsets[edge.b] = Math.max(offsets[edge.b], offsets[i] + edge.gap);
	}
	const seen = new Set<number>();
	for (const seed of order) {
		yield;
		if (seen.has(seed) || !constraints.some(c => c.a === seed || c.b === seed))
			continue;
		const component = [seed];
		seen.add(seed);
		for (let i = 0; i < component.length; i++) {
			yield;
			for (const edge of constraints) {
				const next = edge.a === component[i] ? edge.b : edge.b === component[i] ? edge.a : -1;
				if (next >= 0 && !seen.has(next)) {
					seen.add(next);
					component.push(next);
				}
			}
		}
		const shift = Math.max(...component.map(i => offsets[i] - nodes[i].offset)) * bias;
		for (const i of component)
			offsets[i] -= shift;
	}
	return offsets.map((offset, i) => offset - nodes[i].offset);
}

function* retainedEndsSteps(routes: Route[], affected: Route[], nodes: Support[], constraints: Constraint[], spacing: number, clearance: Clearance, obstacles: Obstacle[], boundaries: Line[]): Steps<RoutePlan[] | undefined> {
	// Keep the pad approaches in place and stagger the 45-degree transitions
	// inside the selected finite runs. Search existing free space before shoving.
	const ids = new Set(nodes.flatMap(n => n.lines.map(l => l.id)));
	const moving = new Set(affected.map(r => r.id));
	const surrounding = routes.filter(r => !moving.has(r.id)).map(route => ({ route, points: route.points, pushed: false, unchanged: true }));
	for (const bias of [0.5, 1, 0, 0.25, 0.75]) {
		yield '兼容模式：正在空白区域安排端部过渡…';
		const deltas = yield* displacements(nodes, constraints, bias);
		const shifts = new Map(nodes.flatMap((node, i) => Math.abs(deltas[i]) <= EPS
			? []
			: node.lines.map((line) => {
					const move = (p: Point) => ({ x: p.x + node.normal.x * deltas[i], y: p.y + node.normal.y * deltas[i] });
					return [line.id, { ...line, start: move(line.start), end: move(line.end) }] as const;
				})));
		const candidates: { route: Route; options: RoutePlan[] }[] = [];
		for (const route of affected) {
			const options: RoutePlan[] = [];
			for (let trial = -1; trial <= 16; trial++) {
				yield;
				try {
					const plan = trial < 0
						? planSegmentRoute(route, new Map([...shifts].map(([id, after]) => [id, { after, moved: true }])))
						: taperedSegments(route, shifts, trial / 40);
					if (hardCollision(plan, obstacles, boundaries, clearance))
						continue;
					let blocked = false;
					for (const other of surrounding) {
						yield;
						if (collision(plan, other, clearance)) {
							blocked = true;
							break;
						}
					}
					if (!blocked)
						options.push(plan);
					if (plan.unchanged)
						break;
				}
				catch { /* Try a longer approach while keeping the same body spacing. */ }
			}
			if (!options.length)
				break;
			candidates.push({ route, options });
		}
		if (candidates.length !== affected.length)
			continue;
		candidates.sort((a, b) => {
			const offset = (r: Route) => nodes.find(n => n.lines.some(l => r.lines.some(s => s.id === l.id)))!.offset;
			return offset(b.route) - offset(a.route);
		});
		let visits = 0;
		function* search(index: number, selected: RoutePlan[]): Steps<RoutePlan[] | undefined> {
			yield;
			if (++visits > 2048)
				return undefined;
			if (index === candidates.length) {
				const pieces = selected.flatMap(p => p.unchanged ? p.route.lines : materialize(p).map(s => s.after));
				const bodies = nodes.map(node => ({ ...node, lines: pieces.filter(l => node.lines.some(s => s.id === l.id)) }));
				for (const edge of constraints) {
					const a = bodies[edge.a];
					const b = bodies[edge.b];
					const extent = (n: Support) => n.lines.flatMap(l => [dot(l.start, n.tangent), dot(l.end, n.tangent)]);
					const aa = extent(a);
					const bb = extent(b);
					const overlap = Math.min(Math.max(...aa), Math.max(...bb)) - Math.max(Math.min(...aa), Math.min(...bb));
					if (!aa.length || !bb.length || overlap < Math.min(spacing, Math.min(a.max, b.max) - Math.max(a.min, b.min)) - EPS)
						return undefined;
				}
				const checked = selected.map(p => ({ ...p.route, lines: (p.unchanged ? p.route.lines : materialize(p).map(s => s.after)).filter(l => ids.has(l.id)) }));
				return (yield* constraintsFor(yield* supports(checked), spacing)).length ? undefined : selected;
			}
			for (const plan of candidates[index].options) {
				if (selected.some(other => collision(plan, other, clearance)))
					continue;
				const found = yield* search(index + 1, [...selected, plan]);
				if (found)
					return found;
			}
			return undefined;
		}
		const found = yield* search(0, []);
		if (found)
			return found;
	}
	return undefined;
}

export function* planLocalSpacingSteps(routes: Route[], selected: Route[], spacing: number, mode: 'direct' | 'push', clearance: Clearance, obstacles: Obstacle[] = [], boundaries: Line[] = [], scope: SelectionScope = 'route'): Steps<RoutePlan[]> {
	if (!Number.isFinite(spacing) || spacing <= 0)
		throw new Error('中心距须大于 0');
	if (!Number.isFinite(clearanceStep(clearance)) || clearanceStep(clearance) < 0)
		throw new Error('避让净距不得小于 0');
	if (selected.length < 2 || selected.some(r => r.locked || r.unsupported))
		throw new Error('请选择至少两条可调整的完整走线');
	const ids = new Set(selected.flatMap(r => r.lines.map(l => l.id)));
	const affected = scope === 'segment' ? routes.filter(r => r.lines.some(l => ids.has(l.id))) : selected;
	const nodes = yield* supports(selected);
	const constraints = yield* constraintsFor(nodes, spacing);
	let failure: unknown;
	for (const bias of [0.5, 1, 0, 0.25, 0.75]) {
		yield '兼容模式：正在展开间距不足的局部走线…';
		try {
			const deltas = yield* displacements(nodes, constraints, bias);
			const shifts = new Map<string, { after: Line; moved: boolean }>();
			nodes.forEach((node, i) => {
				if (Math.abs(deltas[i]) <= EPS)
					return;
				for (const line of node.lines) {
					const move = (p: Point) => ({ x: p.x + node.normal.x * deltas[i], y: p.y + node.normal.y * deltas[i] });
					shifts.set(line.id, { after: { ...line, start: move(line.start), end: move(line.end) }, moved: true });
				}
			});
			const plans = new Map<string, RoutePlan>();
			for (const route of affected) {
				yield;
				plans.set(route.id, planSegmentRoute(route, shifts));
			}
			// Reconnecting bends changes finite run lengths. Check the resulting
			// overlaps too, including previously wide runs, before accepting a trial.
			const checked = affected.map((route) => {
				const plan = plans.get(route.id)!;
				const lines = plan.unchanged ? route.lines : materialize(plan).map(step => step.after);
				return { ...route, lines: scope === 'segment' ? lines.filter(l => ids.has(l.id)) : lines };
			});
			if ((yield* constraintsFor(yield* supports(checked), spacing)).length)
				throw new Error('局部连接后的中心距不足，当前候选不满足要求');
			return yield* resolvePlansSteps(routes, plans, mode, clearance, obstacles, boundaries);
		}
		catch (error) {
			failure ??= error;
		}
	}
	if (mode === 'push' && scope === 'segment' && nodes.every(n => dot(n.normal, nodes[0].normal) > 1 - 1e-8)) {
		const retained = yield* retainedEndsSteps(routes, affected, nodes, constraints, spacing, clearance, obstacles, boundaries);
		if (retained)
			return yield* resolvePlansSteps(routes, new Map(retained.map(p => [p.route.id, p])), mode, clearance, obstacles, boundaries);
	}
	throw failure;
}
