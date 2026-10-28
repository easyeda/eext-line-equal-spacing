import type { Line, Point } from './geometry';
import type { Clearance, RuleObject } from './rules';
import type { Steps } from './work';
import { detourSteps } from './detour';
import { analyze, planSpacing, sameLineGeometry } from './geometry';
import { clearanceGap, clearanceStep } from './rules';
import { finish } from './work';

export type SelectionScope = 'route' | 'segment';
export interface Box { minX: number; minY: number; maxX: number; maxY: number }
export interface Obstacle { id: string; net: string; layer: number; box: Box; terminal?: boolean; arc?: boolean; anchor?: Point; radius?: number; circle?: { center: Point; radius: number }; polygon?: Point[]; stroke?: number; connection?: string; kind?: RuleObject }
export interface Route {
	id: string;
	net: string;
	layer: number;
	lines: Line[];
	points: Point[];
	fixedStart: boolean;
	fixedEnd: boolean;
	locked: boolean;
	unsupported: boolean;
}
export interface LineChange { before?: Line; after: Line; retained?: Line }
export interface RoutePlan { route: Route; points: Point[]; pushed: boolean; unchanged?: boolean; pieces?: LineChange[] }
const EPS = 0.001;
export const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const mul = (a: Point, s: number): Point => ({ x: a.x * s, y: a.y * s });
const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x;
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
const key = (p: Point, l: Line) => `${l.net}/${l.layer}/${p.x.toFixed(3)}/${p.y.toFixed(3)}`;
const sameLayer = (a: number, b: number) => a === b || a === 12 || b === 12;
const sameNet = (a: string, b: string) => !!a && a === b;

export function outlinePoints(source: (string | number)[]): Point[] {
	if (source[0] === 'R') {
		const [, x, y, w, h, rotation] = source.map((v, i) => i ? Number(v) : v) as [string, number, number, number, number, number];
		// Older host versions omit the winding flag before the corner radius.
		const round = Number(source.length >= 8 ? source[7] : source[6] ?? 0);
		if (rotation !== 0 || ![x, y, w, h, round].every(Number.isFinite) || w <= 0 || h <= 0)
			throw new Error('当前板框矩形参数不支持，不能执行推挤');
		const r = Math.min(Math.max(0, round), w / 2, h / 2);
		if (!r)
			return [{ x, y }, { x: x + w, y }, { x: x + w, y: y - h }, { x, y: y - h }];
		const n = Math.max(4, Math.ceil(Math.PI / 2 / (2 * Math.acos(1 - Math.min(0.1 / r, 1)))));
		const centers = [{ x: x + r, y: y - r }, { x: x + w - r, y: y - r }, { x: x + w - r, y: y - h + r }, { x: x + r, y: y - h + r }];
		return centers.flatMap((c, corner) => Array.from({ length: n + 1 }, (_, j) => {
			const angle = Math.PI - corner * Math.PI / 2 - j * Math.PI / 2 / n;
			return { x: c.x + r * Math.cos(angle), y: c.y + r * Math.sin(angle) };
		}));
	}
	const invalid = () => new Error('当前板框含无效或暂不支持的曲线指令，不能执行推挤');
	const number = (index: number) => {
		const value = source[index];
		if (typeof value !== 'number' || !Number.isFinite(value))
			throw invalid();
		return value;
	};
	// Chords stay within 0.01 mil of the native circular boundary.
	const arcCount = (radius: number, sweep: number) => Math.max(2, Math.ceil(Math.abs(sweep) / (2 * Math.acos(1 - Math.min(0.01 / radius, 1)))));
	if (source[0] === 'CIRCLE') {
		const x = number(1);
		const y = number(2);
		const radius = number(3);
		if (radius <= 0)
			throw invalid();
		const n = arcCount(radius, 2 * Math.PI);
		return Array.from({ length: n }, (_, i) => ({ x: x + radius * Math.cos(i * 2 * Math.PI / n), y: y + radius * Math.sin(i * 2 * Math.PI / n) }));
	}
	const points: Point[] = [{ x: number(0), y: number(1) }];
	for (let i = 2; i < source.length;) {
		if (source[i] === 'L') {
			i++;
			if (i === source.length || typeof source[i] !== 'number')
				throw invalid();
		}
		if (source[i] === 'ARC' || source[i] === 'CARC') {
			const sweep = number(i + 1) * Math.PI / 180;
			const end = { x: number(i + 2), y: number(i + 3) };
			const start = points.at(-1)!;
			const chord = dist(start, end);
			if (chord < 1e-9 || Math.abs(sweep) < 1e-9 || Math.abs(sweep) >= 2 * Math.PI - 1e-9)
				throw invalid();
			const offset = chord / (2 * Math.tan(sweep / 2));
			const center = { x: (start.x + end.x) / 2 - (end.y - start.y) / chord * offset, y: (start.y + end.y) / 2 + (end.x - start.x) / chord * offset };
			const radius = dist(start, center);
			const angle = Math.atan2(start.y - center.y, start.x - center.x);
			const n = arcCount(radius, sweep);
			for (let j = 1; j < n; j++)
				points.push({ x: center.x + radius * Math.cos(angle + sweep * j / n), y: center.y + radius * Math.sin(angle + sweep * j / n) });
			points.push(end);
			i += 4;
		}
		else {
			const next = { x: number(i), y: number(i + 1) };
			if (dist(points.at(-1)!, next) > 1e-9)
				points.push(next);
			i += 2;
		}
	}
	if (points.length > 1 && dist(points[0], points.at(-1)!) < 1e-9)
		points.pop();
	if (points.length < 3)
		throw invalid();
	return points;
}

export function contains(box: Box, p: Point, padding = 0) {
	return p.x >= box.minX - padding && p.x <= box.maxX + padding && p.y >= box.minY - padding && p.y <= box.maxY + padding;
}

export function pointDistance(p: Point, a: Point, b: Point) {
	const v = sub(b, a);
	const t = Math.max(0, Math.min(1, dot(sub(p, a), v) / (dot(v, v) || 1)));
	return dist(p, add(a, mul(v, t)));
}

export function terminalTouchesLine(terminal: Obstacle, line: Line) {
	const center = terminal.anchor ?? terminal.circle?.center;
	return center
		? pointDistance(center, line.start, line.end) <= line.width / 2 + (terminal.circle?.radius ?? terminal.radius ?? 0) + EPS
		: touchesBox(line.start, line.end, terminal.box, line.width / 2);
}

export function segmentDistance(a: Point, b: Point, c: Point, d: Point) {
	const ab = sub(b, a);
	const cd = sub(d, c);
	const denominator = cross(ab, cd);
	if (Math.abs(denominator) > 1e-10) {
		const t = cross(sub(c, a), cd) / denominator;
		const u = cross(sub(c, a), ab) / denominator;
		if (t >= 0 && t <= 1 && u >= 0 && u <= 1)
			return 0;
	}
	return Math.min(pointDistance(a, c, d), pointDistance(b, c, d), pointDistance(c, a, b), pointDistance(d, a, b));
}

export function touchesBox(a: Point, b: Point, box: Box, padding = 0) {
	const expanded = { minX: box.minX - padding, maxX: box.maxX + padding, minY: box.minY - padding, maxY: box.maxY + padding };
	if (contains(expanded, a) || contains(expanded, b))
		return true;
	const corners = [
		{ x: expanded.minX, y: expanded.minY },
		{ x: expanded.maxX, y: expanded.minY },
		{ x: expanded.maxX, y: expanded.maxY },
		{ x: expanded.minX, y: expanded.maxY },
	];
	return corners.some((p, i) => segmentDistance(a, b, p, corners[(i + 1) % 4]) < EPS);
}

export function buildRoutes(lines: Line[], anchors: Obstacle[]): Route[] {
	return finish(buildRoutesSteps(lines, anchors));
}

export function* buildRoutesSteps(lines: Line[], anchors: Obstacle[]): Steps<Route[]> {
	const nodes = new Map<string, Line[]>();
	const groupedLines = new Map<string, Line[]>();
	const groupedAnchors = new Map<string, Obstacle[]>();
	for (const anchor of anchors) {
		if (anchor.terminal) {
			if (!groupedAnchors.has(anchor.net))
				groupedAnchors.set(anchor.net, []);
			groupedAnchors.get(anchor.net)!.push(anchor);
		}
	}
	for (const line of lines) {
		const group = `${line.layer}/${line.net}`;
		if (!groupedLines.has(group))
			groupedLines.set(group, []);
		groupedLines.get(group)!.push(line);
		for (const p of [line.start, line.end]) {
			const k = key(p, line);
			nodes.set(k, [...(nodes.get(k) ?? []), line]);
		}
		yield;
	}
	const anchorCache = new Map<string, Obstacle[]>();
	const branchCache = new Map<string, boolean>();
	const atAnchor = (p: Point, l: Line) => {
		const node = key(p, l);
		if (!anchorCache.has(node)) {
			anchorCache.set(node, (groupedAnchors.get(l.net) ?? []).filter((a) => {
				const center = a.anchor ?? a.circle?.center;
				return sameLayer(a.layer, l.layer) && (center ? dist(p, center) <= l.width / 2 + (a.circle?.radius ?? a.radius ?? 0) + EPS : contains(a.box, p, EPS));
			}));
		}
		return anchorCache.get(node)!;
	};
	const interiorBranch = (p: Point, l: Line) => {
		const node = key(p, l);
		if (!branchCache.has(node)) {
			branchCache.set(node, groupedLines.get(`${l.layer}/${l.net}`)!.some(other => other.id !== l.id
				&& dist(p, other.start) > EPS && dist(p, other.end) > EPS && pointDistance(p, other.start, other.end) < EPS));
		}
		return branchCache.get(node)!;
	};
	const stop = (p: Point, l: Line) => nodes.get(key(p, l))!.length !== 2 || atAnchor(p, l).length > 0;
	const visited = new Set<string>();
	const routes: Route[] = [];
	function* walk(first: Line, start: Point): Steps<void> {
		const points = [start];
		const ordered: Line[] = [];
		let current = first;
		let point = start;
		let loop = false;
		let blocked = false;
		while (!visited.has(current.id)) {
			visited.add(current.id);
			ordered.push(current);
			const end = dist(point, current.start) < EPS ? current.end : current.start;
			blocked ||= [point, end].some(p => interiorBranch(p, current) || atAnchor(p, current).some(a => a.arc && !a.anchor));
			points.push(end);
			if (stop(end, current))
				break;
			const next = nodes.get(key(end, current))!.find(l => l.id !== current.id)!;
			if (visited.has(next.id)) {
				loop = true;
				break;
			}
			point = end;
			current = next;
			yield;
		}
		const last = ordered[ordered.length - 1];
		const fixed = (p: Point, line: Line) => nodes.get(key(p, line))!.length > 1 || atAnchor(p, line).length > 0 || interiorBranch(p, line);
		routes.push({ id: ordered.map(l => l.id).sort().join('|'), net: first.net, layer: first.layer, lines: ordered, points, fixedStart: fixed(start, first), fixedEnd: fixed(points[points.length - 1], last), locked: ordered.some(l => l.locked), unsupported: loop || blocked });
	}
	for (const line of lines) {
		if (visited.has(line.id))
			continue;
		if (stop(line.start, line))
			yield* walk(line, line.start);
		else if (stop(line.end, line))
			yield* walk(line, line.end);
		yield;
	}
	for (const line of lines) {
		if (!visited.has(line.id))
			yield* walk(line, line.start);
	}
	return routes;
}

function simplify(points: Point[]) {
	const result: Point[] = [];
	for (const point of points) {
		if (!result.length || dist(point, result[result.length - 1]) > EPS)
			result.push({ ...point });
	}
	for (let i = result.length - 2; i > 0; i--) {
		const a = sub(result[i], result[i - 1]);
		const b = sub(result[i + 1], result[i]);
		if (Math.abs(cross(a, b)) / (Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y)) < 1e-8 && dot(a, b) > 0)
			result.splice(i, 1);
	}
	return result;
}

export function offsetPath(points: Point[], distance: number): Point[] {
	const clean = simplify(points);
	if (clean.length < 2)
		throw new Error('路径过短或包含零长度线段');
	const directions = clean.slice(1).map((p, i) => mul(sub(p, clean[i]), 1 / dist(p, clean[i])));
	const normals = directions.map(v => ({ x: -v.y, y: v.x }));
	const result = [add(clean[0], mul(normals[0], distance))];
	for (let i = 1; i < clean.length - 1; i++) {
		const a = add(clean[i], mul(normals[i - 1], distance));
		const b = add(clean[i], mul(normals[i], distance));
		const denominator = cross(directions[i - 1], directions[i]);
		if (Math.abs(denominator) < 1e-8) {
			if (dot(directions[i - 1], directions[i]) < 0)
				throw new Error('路径包含折返，无法建立偏移路径');
			result.push(a);
		}
		else {
			const joint = add(a, mul(directions[i - 1], cross(sub(b, a), directions[i]) / denominator));
			if (dist(joint, clean[i]) > Math.max(1, Math.abs(distance) * 12))
				throw new Error('路径转角过尖，偏移后无法形成稳定连接');
			result.push(joint);
		}
	}
	result.push(add(clean[clean.length - 1], mul(normals[normals.length - 1], distance)));
	return result;
}

function withAnchors(route: Route, points: Point[]) {
	points = points.map(p => ({ ...p }));
	if (route.fixedStart)
		points[0] = taperToAnchor(route.points[0], points[0], points[1], true);
	if (route.fixedEnd) {
		const i = points.length - 2;
		points[i + 1] = taperToAnchor(route.points[route.points.length - 1], points[i], points[i + 1], false);
	}
	const path = simplify([
		...(route.fixedStart ? [route.points[0]] : []),
		...points,
		...(route.fixedEnd ? [route.points[route.points.length - 1]] : []),
	]);
	// Never remove original primitive IDs: extra vertices subdivide straight segments if needed.
	while (path.length - 1 < route.lines.length) {
		let longest = 0;
		for (let i = 1; i < path.length - 1; i++) {
			if (dist(path[i], path[i + 1]) > dist(path[longest], path[longest + 1]))
				longest = i;
		}
		path.splice(longest + 1, 0, mul(add(path[longest], path[longest + 1]), 0.5));
	}
	validatePath(path);
	return path;
}

function taperToAnchor(anchor: Point, start: Point, end: Point, atStart: boolean): Point {
	const length = dist(start, end);
	if (length < EPS)
		throw new Error('连接段长度不足，未提交');
	const direction = mul(sub(end, start), 1 / length);
	const projection = add(start, mul(direction, dot(sub(anchor, start), direction)));
	const offset = dist(anchor, projection);
	const joint = add(projection, mul(direction, atStart ? offset : -offset));
	if ((atStart ? dot(sub(end, joint), direction) : dot(sub(joint, start), direction)) < EPS)
		throw new Error('没有足够空间形成 45° 连接，请减小间距，未提交');
	return joint;
}

function validatePath(path: Point[]) {
	if (path.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y)))
		throw new Error('路径坐标异常，未提交');
	for (let i = 0; i < path.length - 1; i++) {
		if (dist(path[i], path[i + 1]) < EPS)
			throw new Error('偏移后出现零长度路径');
		if (i + 2 < path.length) {
			const a = sub(path[i + 1], path[i]);
			const b = sub(path[i + 2], path[i + 1]);
			if (dot(a, b) < -1e-8 * Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y))
				throw new Error('连接产生锐角或折返，请减小间距，未提交');
		}
		for (let j = i + 2; j < path.length - 1; j++) {
			if (segmentDistance(path[i], path[i + 1], path[j], path[j + 1]) < EPS)
				throw new Error('偏移后路径自身相交，未提交');
		}
	}
}

function width(route: Route) {
	return Math.max(...route.lines.map(l => l.width));
}

const pieceCache = new WeakMap<RoutePlan, LineChange[]>();
const boundsCache = new WeakMap<Line, Box>();
const staticPlans = new WeakMap<Route, RoutePlan>();
const changedCache = new WeakMap<LineChange, boolean>();
const obstacleLayers = new WeakMap<Obstacle[], Map<number, Obstacle[]>>();
const movingCache = new WeakMap<RoutePlan, LineChange[]>();
const planBoundsCache = new WeakMap<RoutePlan, Box>();

function changed(piece: LineChange) {
	if (!changedCache.has(piece)) {
		const { retained, after } = piece;
		// A split can retain existing copper without retaining its native ID.
		// Verify both physical coverage and attributes before exempting that piece.
		const existing = retained && sameLineGeometry({ ...retained, start: after.start, end: after.end }, after, 1e-9)
			&& pointDistance(after.start, retained.start, retained.end) < 1e-9 && pointDistance(after.end, retained.start, retained.end) < 1e-9;
		changedCache.set(piece, !existing && (!piece.before || !sameLineGeometry(piece.before, after, 1e-9)));
	}
	return changedCache.get(piece)!;
}

function obstaclesFor(obstacles: Obstacle[], layer: number) {
	let layers = obstacleLayers.get(obstacles);
	if (!layers) {
		layers = new Map();
		obstacleLayers.set(obstacles, layers);
	}
	if (!layers.has(layer))
		layers.set(layer, obstacles.filter(o => sameLayer(o.layer, layer)));
	return layers.get(layer)!;
}

function staticPlan(route: Route): RoutePlan {
	let plan = staticPlans.get(route);
	if (!plan) {
		plan = { route, points: route.points, pushed: false, unchanged: true };
		staticPlans.set(route, plan);
	}
	return plan;
}

function collisionPieces(plan: RoutePlan): LineChange[] {
	let pieces = pieceCache.get(plan);
	if (!pieces) {
		pieces = plan.unchanged || (!plan.pieces && plan.points === plan.route.points)
			? plan.route.lines.map(line => ({ before: line, after: line }))
			: materialize(plan);
		pieceCache.set(plan, pieces);
	}
	return pieces;
}

function movingPieces(plan: RoutePlan) {
	if (!movingCache.has(plan))
		movingCache.set(plan, collisionPieces(plan).filter(changed));
	return movingCache.get(plan)!;
}

function planBounds(plan: RoutePlan) {
	if (!planBoundsCache.has(plan)) {
		const pieces = collisionPieces(plan);
		planBoundsCache.set(plan, {
			minX: Math.min(...pieces.map(p => Math.min(p.after.start.x, p.after.end.x) - p.after.width / 2)),
			maxX: Math.max(...pieces.map(p => Math.max(p.after.start.x, p.after.end.x) + p.after.width / 2)),
			minY: Math.min(...pieces.map(p => Math.min(p.after.start.y, p.after.end.y) - p.after.width / 2)),
			maxY: Math.max(...pieces.map(p => Math.max(p.after.start.y, p.after.end.y) + p.after.width / 2)),
		});
	}
	return planBoundsCache.get(plan)!;
}

function bounds(line: Line): Box {
	let box = boundsCache.get(line);
	if (!box) {
		box = { minX: Math.min(line.start.x, line.end.x), minY: Math.min(line.start.y, line.end.y), maxX: Math.max(line.start.x, line.end.x), maxY: Math.max(line.start.y, line.end.y) };
		boundsCache.set(line, box);
	}
	return box;
}

function nearBoxes(a: Box, b: Box, gap: number) {
	return a.minX <= b.maxX + gap && b.minX <= a.maxX + gap && a.minY <= b.maxY + gap && b.minY <= a.maxY + gap;
}

export function collision(a: RoutePlan, b: RoutePlan, clearance: Clearance) {
	if ((a.unchanged && b.unchanged) || a.route.layer !== b.route.layer || sameNet(a.route.net, b.route.net))
		return false;
	if (!nearBoxes(planBounds(a), planBounds(b), clearanceStep(clearance)))
		return false;
	const leftPieces = b.unchanged ? movingPieces(a) : collisionPieces(a);
	const rightPieces = a.unchanged ? movingPieces(b) : collisionPieces(b);
	return leftPieces.some(left => rightPieces.some((right) => {
		if (!changed(left) && !changed(right))
			return false;
		const required = clearanceGap(clearance, left.after, right.after);
		if (!nearBoxes(bounds(left.after), bounds(right.after), required + (left.after.width + right.after.width) / 2))
			return false;
		const gap = segmentDistance(left.after.start, left.after.end, right.after.start, right.after.end) - (left.after.width + right.after.width) / 2;
		if (gap >= required - EPS)
			return false;
		const oldLeft = left.before ?? (!changed(left) ? left.after : undefined);
		const oldRight = right.before ?? (!changed(right) ? right.after : undefined);
		const oldGap = oldLeft && oldRight
			? segmentDistance(oldLeft.start, oldLeft.end, oldRight.start, oldRight.end) - (oldLeft.width + oldRight.width) / 2
			: Infinity;
		return gap < oldGap - EPS;
	}));
}

function boxDistance(a: Point, b: Point, box: Box) {
	if (contains(box, a) || contains(box, b))
		return 0;
	const corners = [{ x: box.minX, y: box.minY }, { x: box.maxX, y: box.minY }, { x: box.maxX, y: box.maxY }, { x: box.minX, y: box.maxY }];
	return Math.min(...corners.map((p, i) => segmentDistance(a, b, p, corners[(i + 1) % 4])));
}

export function obstacleDistance(line: Line, obstacle: Obstacle) {
	if (obstacle.circle)
		return Math.max(0, pointDistance(obstacle.circle.center, line.start, line.end) - obstacle.circle.radius);
	if (obstacle.polygon) {
		const points = obstacle.polygon;
		const inside = (p: Point) => {
			let result = false;
			for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
				const a = points[i];
				const b = points[j];
				if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x)
					result = !result;
			}
			return result;
		};
		if (inside(line.start) || inside(line.end))
			return 0;
		return Math.max(0, Math.min(...points.map((p, i) => segmentDistance(line.start, line.end, p, points[(i + 1) % points.length]))) - (obstacle.stroke ?? 0) / 2);
	}
	return boxDistance(line.start, line.end, obstacle.box);
}

export function hardCollision(plan: RoutePlan, obstacles: Obstacle[], boundaries: Line[], clearance: Clearance): string | undefined {
	for (const piece of movingPieces(plan)) {
		const { before, after } = piece;
		for (const obstacle of obstaclesFor(obstacles, after.layer)) {
			if (sameNet(obstacle.net, after.net))
				continue;
			const required = clearanceGap(clearance, after, obstacle, obstacle.kind ?? 'Track');
			if (!nearBoxes(bounds(after), obstacle.box, required + after.width / 2))
				continue;
			const gap = obstacleDistance(after, obstacle) - after.width / 2;
			const oldGap = before ? obstacleDistance(before, obstacle) - before.width / 2 : Infinity;
			if (gap < required - EPS && gap < oldGap - EPS)
				return `与固定铜障碍（${obstacle.net || obstacle.id}）净距不足`;
		}
		for (const edge of boundaries) {
			const required = clearanceGap(clearance, after, edge, 'Board Outline');
			if (!nearBoxes(bounds(after), bounds(edge), required + after.width / 2))
				continue;
			const gap = segmentDistance(after.start, after.end, edge.start, edge.end) - after.width / 2;
			const oldGap = before ? segmentDistance(before.start, before.end, edge.start, edge.end) - before.width / 2 : Infinity;
			if (gap < required - EPS && gap < oldGap - EPS)
				return '与板边净距不足';
		}
	}
	return undefined;
}

export function selectRoutes(routes: Route[], region?: Box, ids?: string[]) {
	const set = new Set(ids ?? []);
	const chosen = routes.filter(r => r.lines.some(l => region ? touchesBox(l.start, l.end, region, l.width / 2) : set.has(l.id)));
	if (chosen.length < 2)
		throw new Error('请圈定至少两条完整走线');
	if (chosen.some(r => r.locked))
		throw new Error('目标路径含锁定线段，请先解锁');
	if (chosen.some(r => r.unsupported))
		throw new Error('目标含闭环、圆弧连接或线段中部 T 连接，暂不调整');
	if (chosen.some(r => r.layer !== chosen[0].layer))
		throw new Error('区域涉及多个铜层，请缩小区域或改用选中集读取');
	return chosen;
}

function segmentRoute(line: Line): Route {
	return { id: `segment/${line.id}`, net: line.net, layer: line.layer, lines: [line], points: [line.start, line.end], fixedStart: false, fixedEnd: false, locked: line.locked, unsupported: false };
}

export function selectSegments(lines: Line[], region?: Box, ids?: string[]): Route[] {
	const set = new Set(ids ?? []);
	const chosen = lines.filter(l => region ? touchesBox(l.start, l.end, region, l.width / 2) : set.has(l.id));
	analyze(chosen);
	return chosen.map(segmentRoute);
}

export function planSegments(routes: Route[], selected: Route[], spacing: number, mode: 'direct' | 'push', clearance: Clearance, obstacles: Obstacle[] = [], boundaries: Line[] = []): RoutePlan[] {
	return finish(planSegmentsSteps(routes, selected, spacing, mode, clearance, obstacles, boundaries));
}

export function* planSegmentsSteps(routes: Route[], selected: Route[], spacing: number, mode: 'direct' | 'push', clearance: Clearance, obstacles: Obstacle[] = [], boundaries: Line[] = []): Steps<RoutePlan[]> {
	if (!Number.isFinite(clearanceStep(clearance)) || clearanceStep(clearance) < 0)
		throw new Error('避让净距不得小于 0');
	if (selected.some(r => r.lines.length !== 1))
		throw new Error('线段模式需要重新读取独立线段');
	const selectedLines = selected.map(r => r.lines[0]);
	const initial = planSpacing(selectedLines, spacing);
	const { normal, offsets } = analyze(selectedLines);
	const ids = new Set(selectedLines.map(l => l.id));
	const affected = routes.filter(r => r.lines.some(l => ids.has(l.id)));
	if (selectedLines.some(l => !affected.some(r => r.lines.some(s => s.id === l.id))))
		throw new Error('无法找到线段的原有连接路径，请重新读取');
	const remaining = routes.filter(r => !affected.includes(r));
	const center = offsets.reduce((sum, offset) => sum + offset, 0) / offsets.length - offsets[0] - spacing * (offsets.length - 1) / 2;
	// Widen a bundle into both sides. If blocked, move the whole bundle while
	// keeping the requested pitch and the original transverse order unchanged.
	const preferred = selectedLines.length > 2 ? center : 0;
	const bases = [preferred];
	if (mode === 'push') {
		bases.push(center, 0, 2 * center);
		const step = Math.max(2, clearanceStep(clearance) + Math.max(...selectedLines.map(l => l.width)));
		for (let n = 1; n <= 16; n++)
			bases.push(center - n * step, center + n * step);
	}
	let failure: unknown;
	const tried = new Set<number>();
	for (const base of bases) {
		yield '正在搜索等距位置…';
		const rounded = Math.round(base / EPS);
		if (tried.has(rounded))
			continue;
		tried.add(rounded);
		try {
			const shifts = new Map(initial.map(({ before, after }) => {
				const delta = mul(normal, base);
				const target = { ...after, start: add(after.start, delta), end: add(after.end, delta) };
				return [before.id, { after: target, moved: dist(before.start, target.start) > 1e-7 }];
			}));
			const plans = new Map(affected.map(route => [route.id, planSegmentRoute(route, shifts)]));
			return yield* resolvePlansSteps(remaining, plans, mode, clearance, obstacles, boundaries);
		}
		catch (error) {
			failure ??= error;
			// Keep remote approaches where they are and make room in the finite
			// selected run itself before moving an entire corridor of neighboring nets.
			try {
				const shifts = new Map(initial.map(({ before, after }) => {
					const delta = mul(normal, base);
					return [before.id, { ...after, start: add(after.start, delta), end: add(after.end, delta) }];
				}));
				const local = new Map(affected.map(route => [route.id, taperedSegments(route, shifts)]));
				return yield* resolveGreedySteps(remaining, local, mode, clearance, obstacles, boundaries);
			}
			catch { /* The next absolute bundle position keeps the same pitch. */ }
		}
	}
	throw failure;
}

export function taperedSegments(route: Route, shifts: Map<string, Line>, fraction = 0): RoutePlan {
	const pieces: LineChange[] = [];
	const points: Point[] = [route.points[0]];
	let moved = false;
	for (const [i, before] of route.lines.entries()) {
		const target = shifts.get(before.id);
		const delta = target ? sub(target.start, before.start) : { x: 0, y: 0 };
		const distance = Math.hypot(delta.x, delta.y);
		const start = route.points[i];
		const end = route.points[i + 1];
		let path = [start, end];
		if (distance > EPS) {
			moved = true;
			const length = dist(start, end);
			const tangent = mul(sub(end, start), 1 / length);
			const lead = Math.max(before.width, 2, length * fraction);
			if (length <= 2 * (lead + distance) + EPS)
				throw new Error('选中主体不足以容纳两端 45° 过渡');
			path = [start, add(start, mul(tangent, lead)), add(add(start, mul(tangent, lead + distance)), delta), add(add(end, mul(tangent, -lead - distance)), delta), add(end, mul(tangent, -lead)), end];
		}
		for (let j = 1; j < path.length; j++) {
			const body = distance <= EPS || j === 3;
			pieces.push({ ...(body ? { before } : { retained: before }), after: distance <= EPS ? before : { ...before, id: body ? before.id : '', start: path[j - 1], end: path[j] } });
			points.push(path[j]);
		}
	}
	validatePath(points);
	return { route, points, pieces, pushed: false, unchanged: !moved };
}

interface Segment { start: Point; end: Point }

function intersection(a: Segment, b: Segment): Point | undefined {
	const av = sub(a.end, a.start);
	const bv = sub(b.end, b.start);
	const denominator = cross(av, bv);
	if (Math.abs(denominator) / (dist(a.start, a.end) * dist(b.start, b.end)) < 1e-8)
		return undefined;
	return add(a.start, mul(av, cross(sub(b.start, a.start), bv) / denominator));
}

function stretchCollinearRun(route: Route, segments: Segment[], shifts: Map<string, { after: Line; moved: boolean }>, joint: number, leftSelected: boolean, point: Point): boolean {
	const selected = leftSelected ? joint - 1 : joint;
	const neighbor = leftSelected ? joint : joint - 1;
	const direction = sub(route.points[neighbor + 1], route.points[neighbor]);
	const advance = leftSelected ? 1 : -1;
	let far = neighbor;
	while (far + advance >= 0 && far + advance < segments.length) {
		const next = far + advance;
		const vector = sub(route.points[next + 1], route.points[next]);
		if (route.lines[next].locked || shifts.has(route.lines[next].id)
			|| dot(direction, vector) <= 0 || Math.abs(cross(direction, vector)) > 1e-8 * Math.hypot(direction.x, direction.y) * Math.hypot(vector.x, vector.y)) {
			break;
		}
		far = next;
	}
	if (far === neighbor)
		return false;
	const start = leftSelected ? point : segments[far].start;
	const end = leftSelected ? segments[far].end : point;
	const selectedStart = leftSelected ? segments[selected].start : point;
	const selectedEnd = leftSelected ? point : segments[selected].end;
	const selectedDirection = sub(route.points[selected + 1], route.points[selected]);
	if (dot(sub(end, start), direction) <= EPS * Math.hypot(direction.x, direction.y)
		|| dot(sub(selectedEnd, selectedStart), selectedDirection) <= EPS * Math.hypot(selectedDirection.x, selectedDirection.y)) {
		return false;
	}
	const first = Math.min(neighbor, far);
	const last = Math.max(neighbor, far);
	const lengths = route.lines.slice(first, last + 1).map((_, i) => dist(route.points[first + i], route.points[first + i + 1]));
	const total = lengths.reduce((sum, length) => sum + length, 0);
	if (lengths.some(length => dist(start, end) * length / total <= EPS))
		return false;
	// Native copper may subdivide one straight diagonal into several IDs.
	// Redistribute its internal vertices instead of turning an exhausted piece back.
	let used = 0;
	for (let i = first; i <= last; i++) {
		const a = add(start, mul(sub(end, start), used / total));
		used += lengths[i - first];
		segments[i] = { start: a, end: i === last ? end : add(start, mul(sub(end, start), used / total)) };
	}
	segments[selected] = { start: selectedStart, end: selectedEnd };
	return true;
}

function slideBend(route: Route, segments: Segment[], shifts: Map<string, { after: Line; moved: boolean }>, joint: number, leftSelected: boolean): boolean {
	const selected = leftSelected ? joint - 1 : joint;
	const neighbor = leftSelected ? joint : joint - 1;
	const outer = leftSelected ? joint + 1 : joint - 2;
	if (outer < 0 || outer >= segments.length || route.lines[outer].locked || shifts.has(route.lines[outer].id))
		return false;
	const step = shifts.get(route.lines[selected].id)!;
	const delta = sub(step.after.start, route.lines[selected].start);
	const moved = { start: add(route.points[neighbor], delta), end: add(route.points[neighbor + 1], delta) };
	const near = intersection(segments[selected], moved);
	const far = intersection(moved, segments[outer]);
	if (!near || !far)
		return false;
	const trial = new Map<number, Segment>();
	trial.set(selected, leftSelected ? { ...segments[selected], end: near } : { ...segments[selected], start: near });
	trial.set(neighbor, leftSelected ? { start: near, end: far } : { start: far, end: near });
	trial.set(outer, leftSelected ? { ...segments[outer], start: far } : { ...segments[outer], end: far });
	for (const [index, line] of trial) {
		const direction = sub(route.points[index + 1], route.points[index]);
		if (dot(sub(line.end, line.start), direction) <= EPS * Math.hypot(direction.x, direction.y))
			return false;
	}
	for (const [index, line] of trial)
		segments[index] = line;
	return true;
}

export function planSegmentRoute(route: Route, shifts: Map<string, { after: Line; moved: boolean }>): RoutePlan {
	if (!route.lines.some(l => shifts.get(l.id)?.moved)) {
		return { route, points: route.points, pushed: false, unchanged: true };
	}
	if (route.unsupported)
		throw new Error('目标连接闭环、圆弧或中部 T 节点，无法保持连接，未提交');
	const segments = route.lines.map((line, i) => {
		const step = shifts.get(line.id);
		const a = step?.after ?? line;
		const forward = dist(line.start, route.points[i]) < EPS;
		return { start: { ...(forward ? a.start : a.end) }, end: { ...(forward ? a.end : a.start) } };
	});
	const reshaped = new Set<string>();
	for (let i = 1; i < segments.length; i++) {
		const leftSelected = shifts.has(route.lines[i - 1].id);
		const rightSelected = shifts.has(route.lines[i].id);
		if (!leftSelected && !rightSelected)
			continue;
		const neighbor = leftSelected ? route.lines[i] : route.lines[i - 1];
		if (neighbor.locked)
			continue; // Keep a locked neighbor fixed and bridge back to its original endpoint.
		const left = segments[i - 1];
		const right = segments[i];
		const a = sub(left.end, left.start);
		const b = sub(right.end, right.start);
		const denominator = cross(a, b);
		if (Math.abs(denominator) / (Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y)) < 1e-8)
			continue;
		const joint = add(left.start, mul(a, cross(sub(right.start, left.start), b) / denominator));
		const displacement = Math.max(dist(left.end, route.points[i]), dist(right.start, route.points[i]));
		if (dist(joint, route.points[i]) > Math.max(1, displacement * 12))
			throw new Error('原连接角度过尖，无法自然衔接，未提交');
		const leftDirection = sub(route.points[i], route.points[i - 1]);
		const rightDirection = sub(route.points[i + 1], route.points[i]);
		if (dot(sub(joint, left.start), leftDirection) <= EPS * Math.hypot(leftDirection.x, leftDirection.y)
			|| dot(sub(right.end, joint), rightDirection) <= EPS * Math.hypot(rightDirection.x, rightDirection.y)) {
			if (leftSelected && rightSelected)
				throw new Error('相邻移动段的交点会产生折返，请搜索另一侧空间');
			if (stretchCollinearRun(route, segments, shifts, i, leftSelected, joint))
				continue;
			// Keep a short bend pointing forwards by sliding its far vertex along
			// the next support. The distant pad/via endpoint stays fixed.
			if (slideBend(route, segments, shifts, i, leftSelected))
				continue;
			// The original diagonal may run out of length. Rebuild that diagonal
			// from its fixed far vertex into a clean 45-degree join, without a stub.
			if (leftSelected) {
				left.end = taperToAnchor(right.end, left.start, left.end, false);
				right.start = left.end;
			}
			else {
				right.start = taperToAnchor(left.start, right.start, right.end, true);
				left.end = right.start;
			}
			reshaped.add(neighbor.id);
			continue;
		}
		left.end = joint;
		right.start = joint;
	}
	// A fixed/parallel neighbor can only be joined by trimming the selected
	// support into a forward 45-degree transition. Never append a perpendicular stub.
	for (let i = 1; i < segments.length; i++) {
		const left = segments[i - 1];
		const right = segments[i];
		if (dist(left.end, right.start) <= EPS)
			continue;
		const leftSelected = shifts.has(route.lines[i - 1].id);
		const rightSelected = shifts.has(route.lines[i].id);
		if (leftSelected === rightSelected)
			throw new Error('相邻所选段无法自然衔接，请重新取区，未提交');
		if (leftSelected)
			left.end = taperToAnchor(right.start, left.start, left.end, false);
		else
			right.start = taperToAnchor(left.end, right.start, right.end, true);
	}
	if (route.fixedStart)
		segments[0].start = taperToAnchor(route.points[0], segments[0].start, segments[0].end, true);
	if (route.fixedEnd) {
		const last = segments[segments.length - 1];
		last.end = taperToAnchor(route.points[route.points.length - 1], last.start, last.end, false);
	}
	const points: Point[] = [];
	const pieces: LineChange[] = [];
	const bridge = (from: Point, to: Point, source: Line) => {
		if (dist(from, to) <= EPS)
			return;
		pieces.push({ after: { ...source, id: '', start: from, end: to, locked: false } });
		points.push(to);
	};
	points.push(route.fixedStart ? route.points[0] : segments[0].start);
	bridge(points[0], segments[0].start, route.lines[0]);
	for (let i = 0; i < segments.length; i++) {
		const before = route.lines[i];
		const { start, end } = segments[i];
		if (!reshaped.has(before.id) && dot(sub(end, start), sub(route.points[i + 1], route.points[i])) <= EPS * dist(route.points[i + 1], route.points[i]))
			throw new Error('间距导致连接段消失或折返，无法保持连接，未提交');
		bridge(points[points.length - 1], start, shifts.has(before.id) ? before : route.lines[i - 1]);
		const forward = dist(before.start, route.points[i]) < EPS;
		const after = { ...before, start: forward ? start : end, end: forward ? end : start };
		pieces.push({ before, after });
		points.push(end);
	}
	if (route.fixedEnd)
		bridge(points[points.length - 1], route.points[route.points.length - 1], route.lines[route.lines.length - 1]);
	validatePath(points);
	return { route, points, pushed: false, pieces };
}

export function planRoutes(routes: Route[], selected: Route[], spacing: number, mode: 'direct' | 'push', clearance: Clearance,	obstacles: Obstacle[] = [], boundaries: Line[] = []): RoutePlan[] {
	return finish(planRoutesSteps(routes, selected, spacing, mode, clearance, obstacles, boundaries));
}

export function* planRoutesSteps(routes: Route[], selected: Route[], spacing: number, mode: 'direct' | 'push', clearance: Clearance, obstacles: Obstacle[] = [], boundaries: Line[] = []): Steps<RoutePlan[]> {
	try {
		return yield* planTemplateSteps(routes, selected, spacing, mode, clearance, obstacles, boundaries);
	}
	catch (error) {
		if (!Number.isFinite(spacing) || spacing <= 0 || selected.length < 2 || selected.some(r => r.locked || r.unsupported))
			throw error;
		if (strictSpineMatches(selected, spacing))
			return selected.map(route => ({ route, points: route.points, pushed: false, unchanged: true }));
		// A narrow meander cannot be offset by a pitch larger than its folds.
		// Rebuild the shared reference geometry, then offset every target by the
		// same exact pitch. This remains strict; no compatible-mode fallback.
		for (const reference of [...selected].sort((a, b) => a.points.length - b.points.length)) {
			for (const base of rebuiltSpines(reference.points, spacing)) {
				yield '正在重建折返区域与固定端点连接…';
				try {
					return yield* planTemplateSteps(routes, selected, spacing, mode, clearance, obstacles, boundaries, { reference, base });
				}
				catch { /* Try another strict spine and its endpoint approaches. */ }
			}
		}
		throw error;
	}
}

function strictSpineMatches(selected: Route[], spacing: number) {
	// Reconnected fixed-end approaches may differ even though the common strict
	// spine is already correct. Recognize all three supports, not just the trunk.
	if (selected.some(r => !r.fixedStart || !r.fixedEnd))
		return false;
	const cores = selected.map((route) => {
		let points = simplify(route.points);
		let i = points.slice(1).map((p, index) => ({ index, length: dist(p, points[index]) })).sort((a, b) => b.length - a.length)[0].index;
		if (points[i + 1].x < points[i].x - EPS || (Math.abs(points[i + 1].x - points[i].x) < EPS && points[i + 1].y < points[i].y)) {
			points = [...points].reverse();
			i = points.length - 2 - i;
		}
		return i > 0 && i + 2 < points.length ? points.slice(i - 1, i + 3) : undefined;
	});
	if (cores.some(c => !c))
		return false;
	const reference = cores[0]!;
	let sign = 0;
	for (let segment = 0; segment < 3; segment++) {
		const a = reference[segment];
		const b = reference[segment + 1];
		const length = dist(a, b);
		if (length < spacing * 2)
			return false;
		const direction = mul(sub(b, a), 1 / length);
		const normal = { x: -direction.y, y: direction.x };
		const offsets = cores.map((core) => {
			const start = core![segment];
			const end = core![segment + 1];
			if (dist(start, end) < spacing * 2 || dot(sub(end, start), direction) < dist(start, end) - EPS
				|| Math.abs(cross(sub(end, start), direction)) > EPS
				|| Math.min(dot(end, direction), dot(b, direction)) - Math.max(dot(start, direction), dot(a, direction)) < spacing) {
				return Number.NaN;
			}
			return dot(start, normal);
		});
		const order = offsets.map((offset, index) => ({ offset, index })).sort((a, b) => a.offset - b.offset);
		if (order.some((p, i) => !Number.isFinite(p.offset) || (i > 0 && Math.abs(p.offset - order[i - 1].offset - spacing) > EPS)))
			return false;
		const side = order[0].index;
		if (segment && side !== sign)
			return false;
		sign = side;
	}
	return true;
}

function rebuiltSpines(original: Point[], spacing: number): Point[][] {
	const result: Point[][] = [];
	for (const limit of [spacing * 4, spacing * 8]) {
		for (const diagonalFirst of [true, false]) {
			const points = simplify(original);
			for (let i = 0; i < points.length - 2; i++) {
				let end = i;
				let length = 0;
				while (end + 1 < points.length && dist(points[end], points[end + 1]) < limit) {
					length += dist(points[end], points[end + 1]);
					end++;
				}
				if (end - i < 3 || dist(points[i], points[end]) > length * 0.85)
					continue;
				const a = points[i];
				const b = points[end];
				const dx = b.x - a.x;
				const dy = b.y - a.y;
				const d = Math.min(Math.abs(dx), Math.abs(dy));
				const corner = diagonalFirst
					? { x: a.x + Math.sign(dx) * d, y: a.y + Math.sign(dy) * d }
					: { x: b.x - Math.sign(dx) * d, y: b.y - Math.sign(dy) * d };
				points.splice(i + 1, end - i - 1, corner);
			}
			const clean = simplify(points);
			try {
				validatePath(clean);
				if (clean.length < simplify(original).length && !result.some(r => JSON.stringify(r) === JSON.stringify(clean)))
					result.push(clean);
			}
			catch { /* Preserve a different approach direction at the next trial. */ }
		}
	}
	return result;
}

function* planTemplateSteps(routes: Route[], selected: Route[], spacing: number, mode: 'direct' | 'push', clearance: Clearance, obstacles: Obstacle[], boundaries: Line[], rebuilt?: { reference: Route; base: Point[] }): Steps<RoutePlan[]> {
	if (!Number.isFinite(spacing) || spacing <= 0 || !Number.isFinite(clearanceStep(clearance)) || clearanceStep(clearance) < 0)
		throw new Error('间距须大于 0，避让净距不得小于 0');
	if (selected.length < 2)
		throw new Error('至少需要两条目标路径');
	const longest = [...selected[0].lines].sort((a, b) => dist(b.start, b.end) - dist(a.start, a.end))[0];
	let tangent = mul(sub(longest.end, longest.start), 1 / dist(longest.start, longest.end));
	if (tangent.x < -EPS || (Math.abs(tangent.x) <= EPS && tangent.y < 0))
		tangent = mul(tangent, -1);
	let normal = { x: -tangent.y, y: tangent.x };
	if (Math.abs(normal.y) <= EPS && normal.x < 0)
		normal = mul(normal, -1);
	const position = (r: Route) => r.points.reduce((n, p) => n + dot(p, normal), 0) / r.points.length;
	const ordered = [...selected].sort((a, b) => position(a) - position(b));
	const reference = rebuilt?.reference ?? ordered[0];
	const base = rebuilt?.base ?? simplify(reference.points);
	const main = base.slice(1).map((p, i) => ({ axis: sub(p, base[i]), length: dist(p, base[i]) })).sort((a, b) => b.length - a.length)[0];
	const axis = main.axis;
	const sign = dot({ x: -axis.y, y: axis.x }, normal) < 0 ? -1 : 1;
	const plans = new Map<string, RoutePlan>();
	ordered.forEach((route, i) => {
		if (route.locked || route.unsupported)
			throw new Error('目标路径无法安全调整');
		if (!rebuilt && !i) {
			plans.set(route.id, { route, points: route.points, pushed: false, unchanged: true });
			return;
		}
		const referenceIndex = ordered.indexOf(reference);
		let points = offsetPath(base, sign * spacing * (i - referenceIndex));
		const cost = (p: Point[]) => dist(p[0], route.points[0]) + dist(p[p.length - 1], route.points[route.points.length - 1]);
		if (cost([...points].reverse()) < cost(points))
			points = points.reverse();
		plans.set(route.id, { route, points: withAnchors(route, points), pushed: false });
	});
	if (rebuilt && mode === 'push' && [...plans.values()].some(p => hardCollision(p, obstacles, boundaries, clearance))) {
		const connected = yield* reconnectTemplateSteps(routes, plans, clearance, obstacles, boundaries);
		if (connected)
			return yield* resolvePlansSteps(routes, connected, mode, clearance, obstacles, boundaries);
	}
	return yield* resolvePlansSteps(routes, plans, mode, clearance, obstacles, boundaries);
}

function* reconnectTemplateSteps(routes: Route[], plans: Map<string, RoutePlan>, clearance: Clearance, obstacles: Obstacle[], boundaries: Line[]): Steps<Map<string, RoutePlan> | undefined> {
	const cores = [...plans.values()].map((plan) => {
		const points = simplify(plan.points);
		const longest = points.slice(1).map((p, i) => ({ i, length: dist(points[i], p) })).sort((a, b) => b.length - a.length)[0].i;
		const first = Math.max(0, longest - 1);
		const last = Math.min(points.length - 1, longest + 2);
		return { plan, points, first, last };
	});
	const approaches = routes.filter(r => !plans.has(r.id)).flatMap(r => [
		...(r.fixedStart ? [{ line: r.lines[0], start: r.points[0], end: r.points[1] }] : []),
		...(r.fixedEnd ? [{ line: r.lines.at(-1)!, start: r.points.at(-1)!, end: r.points.at(-2)! }] : []),
	].map(({ line, start, end }) => ({ ...line, start, end: add(start, mul(sub(end, start), Math.min(1, 32 / dist(start, end)))) })));
	const coreLines = cores.flatMap(({ plan, points, first, last }) => points.slice(first + 1, last + 1).map((p, i) => ({ ...plan.route.lines[0], start: points[first + i], end: p })));
	for (const order of [cores, [...cores].reverse()]) {
		const copper = [...coreLines, ...approaches];
		const result = new Map<string, RoutePlan>();
		let valid = true;
		for (const { plan, points, first, last } of order) {
			yield '正在保持严格主体间距并重接固定端点…';
			const source = plan.route.lines[0];
			const left = first ? yield* detourSteps(points[0], points[first], source, copper, obstacles, boundaries, clearance, undefined, sub(points[first + 1], points[first])) : [points[0]];
			if (!left) {
				valid = false;
				break;
			}
			copper.push(...left.slice(1).map((p, i) => ({ ...source, start: left[i], end: p })));
			const right = last < points.length - 1 ? yield* detourSteps(points[last], points.at(-1)!, source, copper, obstacles, boundaries, clearance, sub(points[last], points[last - 1])) : [points[last]];
			if (!right) {
				valid = false;
				break;
			}
			try {
				const connected = withAnchors(plan.route, simplify([...left, ...points.slice(first + 1, last), ...right]));
				const trial = { route: plan.route, points: connected, pushed: false };
				if (hardCollision(trial, obstacles, boundaries, clearance) || [...result.values()].some(p => collision(trial, p, clearance)))
					throw new Error('重接路径仍有冲突');
				result.set(plan.route.id, trial);
				copper.push(...right.slice(1).map((p, i) => ({ ...source, start: right[i], end: p })));
			}
			catch {
				valid = false;
				break;
			}
		}
		if (valid)
			return result;
	}
	return undefined;
}

export function* resolvePlansSteps(routes: Route[], plans: Map<string, RoutePlan>, mode: 'direct' | 'push', clearance: Clearance, obstacles: Obstacle[], boundaries: Line[]): Steps<RoutePlan[]> {
	return yield* resolveGreedySteps(routes, plans, mode, clearance, obstacles, boundaries);
}

function* resolveGreedySteps(routes: Route[], plans: Map<string, RoutePlan>, mode: 'direct' | 'push', clearance: Clearance, obstacles: Obstacle[], boundaries: Line[]): Steps<RoutePlan[]> {
	if (mode === 'direct')
		return [...plans.values()];
	for (const a of plans.values()) {
		yield;
		const fixedConflict = hardCollision(a, obstacles, boundaries, clearance);
		if (fixedConflict)
			throw new Error(`走线 ${a.route.net || a.route.id} ${fixedConflict}，无法推挤`);
		for (const b of plans.values()) {
			if (a.route.id !== b.route.id && collision(a, b, clearance))
				throw new Error('目标路径或固定端点之间的净距不足');
		}
	}
	for (let cascade = 0; cascade < 64; cascade++) {
		let blocked: Route | undefined;
		for (const route of routes) {
			yield;
			if (!plans.has(route.id) && [...plans.values()].some(p => collision(p, staticPlan(route), clearance))) {
				blocked = route;
				break;
			}
		}
		if (!blocked)
			return [...plans.values()];
		if (blocked.locked || blocked.unsupported)
			throw new Error('推挤遇到锁定、闭环或不支持的连接路径，未提交');
		yield `正在推挤 ${blocked.net || '周围走线'}（${cascade + 1}）…`;
		let candidate: RoutePlan | undefined;
		const step = Math.max(2, clearanceStep(clearance) + width(blocked));
		const hitLines = blocked.lines.filter((line) => {
			const single = segmentRoute(line);
			return [...plans.values()].some(p => collision(p, staticPlan(single), clearance));
		}).sort((a, b) => dist(b.start, b.end) - dist(a.start, a.end));
		for (let n = 1; n <= 16 && !candidate; n++) {
			for (const side of [1, -1]) {
				yield;
				for (const line of hitLines) {
					yield;
					try {
						const direction = mul(sub(line.end, line.start), 1 / dist(line.start, line.end));
						const shift = mul({ x: -direction.y, y: direction.x }, side * n * step);
						const after = { ...line, start: add(line.start, shift), end: add(line.end, shift) };
						const trial = { ...planSegmentRoute(blocked, new Map([[line.id, { after, moved: true }]])), pushed: true };
						if (!hardCollision(trial, obstacles, boundaries, clearance)
							&& ![...plans.values()].some(p => collision(trial, p, clearance))) {
							candidate = trial;
							break;
						}
					}
					catch { /* Try a different local displacement before moving the complete path. */ }
				}
				if (candidate)
					break;
				try {
					const points = withAnchors(blocked, offsetPath(blocked.points, side * n * step));
					const trial = { route: blocked, points, pushed: true };
					if (!hardCollision(trial, obstacles, boundaries, clearance)
						&& ![...plans.values()].some(p => collision(trial, p, clearance))) {
						candidate = trial;
						break;
					}
				}
				catch { /* Try another bounded offset; no host mutation happens during search. */ }
			}
		}
		if (!candidate) {
			yield `正在为 ${blocked.net || '受阻路径'} 重建 45° 绕行…`;
			const indices = hitLines.map(l => blocked.lines.indexOf(l));
			let first = Math.min(...indices);
			let last = Math.max(...indices) + 1;
			const occupied = (point: Point) => {
				const probe = { route: blocked, points: [point, point], pushed: false, pieces: [{ after: { ...blocked.lines[0], start: point, end: point } }] };
				return [...plans.values()].some(p => collision(probe, p, clearance));
			};
			// The endpoint of a hit segment may itself be inside the new corridor.
			// Extend the rebuilt interval to a clear original vertex before routing.
			while (first > 0 && occupied(blocked.points[first]))
				first--;
			while (last < blocked.lines.length && occupied(blocked.points[last]))
				last++;
			const copper = [...plans.values()].flatMap(p => collisionPieces(p).map(s => s.after));
			let path: Point[] | undefined;
			for (let attempt = 0; attempt < 8 && !path; attempt++) {
				path = yield* detourSteps(blocked.points[first], blocked.points[last], blocked.lines[first], copper, obstacles, boundaries, clearance, first ? sub(blocked.points[first], blocked.points[first - 1]) : undefined, last < blocked.points.length - 1 ? sub(blocked.points[last + 1], blocked.points[last]) : undefined);
				if (!path) {
					if (!first && last === blocked.lines.length)
						break;
					first = Math.max(0, first - 1);
					last = Math.min(blocked.lines.length, last + 1);
				}
			}
			if (path) {
				try {
					const trial = { route: blocked, points: withAnchors(blocked, simplify([...blocked.points.slice(0, first), ...path, ...blocked.points.slice(last + 1)])), pushed: true };
					if (!hardCollision(trial, obstacles, boundaries, clearance) && ![...plans.values()].some(p => collision(trial, p, clearance)))
						candidate = trial;
				}
				catch { /* A navigation path must also preserve the complete route. */ }
			}
		}
		if (!candidate)
			throw new Error(`走线 ${blocked.net || blocked.id} 固定端点或周围空间不足，无法完成推挤，未提交`);
		plans.set(blocked.id, candidate);
	}
	throw new Error('推挤级联超过 64 条路径，未提交');
}

export function materialize(plan: RoutePlan): LineChange[] {
	if (plan.unchanged)
		return [];
	if (plan.pieces)
		return plan.pieces;
	const geometryKey = (a: Point, b: Point) => [a, b].map(p => `${p.x.toFixed(6)},${p.y.toFixed(6)}`).sort().join('/');
	const originals = new Map<string, Line[]>();
	for (const line of plan.route.lines) {
		const key = geometryKey(line.start, line.end);
		if (!originals.has(key))
			originals.set(key, []);
		originals.get(key)!.push(line);
	}
	const used = new Set<string>();
	const pieces = plan.points.slice(1).map((end, i) => {
		const start = plan.points[i];
		const exact = originals.get(geometryKey(start, end))?.shift();
		if (exact)
			used.add(exact.id);
		return { start, end, exact };
	});
	const remaining = plan.route.lines.filter(l => !used.has(l.id));
	let next = 0;
	return pieces.map(({ start, end, exact }) => {
		if (exact)
			return { before: exact, after: exact };
		const before = remaining[next++];
		return { before, after: { ...(before ?? plan.route.lines.at(-1)!), id: before?.id ?? '', start, end } };
	});
}
