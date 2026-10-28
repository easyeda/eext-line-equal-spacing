import type { Line, Point } from './geometry';
import type { Box, Obstacle } from './routes';
import type { Steps } from './work';
import { equalLine } from './geometry';
import { contains, pointDistance, segmentDistance, terminalTouchesLine } from './routes';
import { finish } from './work';

const EPS = 0.001;
const sameLayer = (a: number, b: number) => a === b || a === 12 || b === 12;

function group<T extends { net: string }>(items: T[]) {
	const result = new Map<string, T[]>();
	for (const item of items) {
		if (!result.has(item.net))
			result.set(item.net, []);
		result.get(item.net)!.push(item);
	}
	return result;
}

function* graph(lines: Line[], terminals: Obstacle[]): Steps<{ keys: MapIterator<string>; root: (key: string) => string }> {
	const parents = new Map<string, string>();
	const nets = group(lines);
	const pads = group(terminals);
	const lineKey = (line: Line) => `line/${line.id}`;
	const terminalKey = (terminal: Obstacle) => `terminal/${terminal.id}`;
	for (const line of lines)
		parents.set(lineKey(line), lineKey(line));
	for (const terminal of terminals)
		parents.set(terminalKey(terminal), terminalKey(terminal));
	const root = (key: string): string => {
		const parent = parents.get(key);
		if (parent === undefined)
			throw new Error(`连接对象缺失：${key}`);
		if (parent === key)
			return key;
		const found = root(parent);
		parents.set(key, found);
		return found;
	};
	const join = (a: string, b: string) => parents.set(root(a), root(b));
	const fixedCopper = new Map<string, string>();
	for (const terminal of terminals) {
		if (!terminal.connection)
			continue;
		const component = `${terminal.net}/${terminal.layer}/${terminal.connection}`;
		const previous = fixedCopper.get(component);
		if (previous)
			join(previous, terminalKey(terminal));
		else
			fixedCopper.set(component, terminalKey(terminal));
		yield;
	}
	for (const members of nets.values()) {
		for (let i = 0; i < members.length; i++) {
			const a = members[i];
			for (let j = i + 1; j < members.length; j++) {
				if (j % 64 === 0)
					yield;
				const b = members[j];
				if (a.layer === b.layer
					&& segmentDistance(a.start, a.end, b.start, b.end) <= (a.width + b.width) / 2 + EPS) {
					join(lineKey(a), lineKey(b));
				}
			}
			for (const terminal of pads.get(a.net) ?? []) {
				if (sameLayer(a.layer, terminal.layer)
					&& terminalTouchesLine(terminal, a)) {
					join(lineKey(a), terminalKey(terminal));
				}
			}
			yield;
		}
	}
	return { keys: parents.keys(), root };
}

// Keep an original contact point as well as the component relation. A pad's
// bounding box alone cannot prove the new copper still touches its real shape.
function contactPoints(line: Line, terminal: Obstacle): Point[] {
	const center = terminal.anchor ?? terminal.circle?.center;
	if (center) {
		if (!terminalTouchesLine(terminal, line))
			return [];
		const dx = line.end.x - line.start.x;
		const dy = line.end.y - line.start.y;
		const t = Math.max(0, Math.min(1, ((center.x - line.start.x) * dx + (center.y - line.start.y) * dy) / (dx * dx + dy * dy || 1)));
		return [{ x: line.start.x + t * dx, y: line.start.y + t * dy }];
	}
	const box: Box = terminal.box;
	const padding = line.width / 2;
	const endpoints = [line.start, line.end].filter(p => contains(box, p, padding));
	if (endpoints.length)
		return endpoints;
	const expanded = { minX: box.minX - padding, maxX: box.maxX + padding, minY: box.minY - padding, maxY: box.maxY + padding };
	let lo = 0;
	let hi = 1;
	for (const axis of ['x', 'y'] as const) {
		const delta = line.end[axis] - line.start[axis];
		const min = axis === 'x' ? expanded.minX : expanded.minY;
		const max = axis === 'x' ? expanded.maxX : expanded.maxY;
		if (Math.abs(delta) < 1e-12) {
			if (line.start[axis] < min || line.start[axis] > max)
				return [];
			continue;
		}
		const a = (min - line.start[axis]) / delta;
		const b = (max - line.start[axis]) / delta;
		lo = Math.max(lo, Math.min(a, b));
		hi = Math.min(hi, Math.max(a, b));
	}
	if (lo > hi)
		return [];
	const t = (lo + hi) / 2;
	return [{ x: line.start.x + (line.end.x - line.start.x) * t, y: line.start.y + (line.end.y - line.start.y) * t }];
}

export function assertConnections(before: Line[], after: Line[], obstacles: Obstacle[]) {
	finish(assertConnectionsSteps(before, after, obstacles));
}

export function* assertConnectionsSteps(before: Line[], after: Line[], obstacles: Obstacle[]): Steps<void> {
	// Connectivity is independent between nets. Rebuilding the unchanged ground
	// graph for every small signal edit dominates verification on larger boards.
	const previous = new Map(before.map(l => [l.id, l]));
	const updated = new Map(after.map(l => [l.id, l]));
	const changedNets = new Set<string>();
	for (const lines of [before, after]) {
		for (let i = 0; i < lines.length; i++) {
			if (i % 128 === 0)
				yield;
			const line = lines[i];
			const other = (lines === before ? updated : previous).get(line.id);
			if (!other || !equalLine(line, other, 1e-9))
				changedNets.add(line.net);
		}
	}
	if (!changedNets.size)
		return;
	before = before.filter(l => changedNets.has(l.net));
	after = after.filter(l => changedNets.has(l.net));
	const terminals = obstacles.filter(o => o.terminal && changedNets.has(o.net));
	const pads = group(terminals);
	const nets = group(after);
	const old = yield* graph(before, terminals);
	const next = yield* graph(after, terminals);
	const components = new Map<string, string>();
	for (const key of old.keys) {
		const original = old.root(key);
		const current = next.root(key);
		const previous = components.get(original);
		if (previous !== undefined && previous !== current)
			throw new Error(`调整会断开原有连接（${key}），未提交`);
		components.set(original, current);
		yield;
	}
	for (const line of before) {
		if (line.locked && (!updated.has(line.id) || !equalLine(line, updated.get(line.id)!, EPS)))
			throw new Error(`调整涉及锁定线段 ${line.id}，未提交`);
		for (const terminal of pads.get(line.net) ?? []) {
			if (line.net !== terminal.net || !sameLayer(line.layer, terminal.layer))
				continue;
			for (const point of contactPoints(line, terminal)) {
				if (!(nets.get(line.net) ?? []).some(l => l.layer === line.layer && l.width >= line.width - EPS
					&& pointDistance(point, l.start, l.end) <= EPS)) {
					throw new Error(`无法保留${terminal.anchor ? '固定圆弧' : '焊盘/过孔'}接入位置（${terminal.id}），未提交`);
				}
			}
		}
		yield;
	}
}
