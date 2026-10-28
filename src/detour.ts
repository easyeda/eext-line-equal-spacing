import type { Line, Point } from './geometry';
import type { Box, Obstacle } from './routes';
import type { Clearance } from './rules';
import type { Steps } from './work';
import { contains, obstacleDistance, segmentDistance } from './routes';
import { clearanceGap, clearanceStep } from './rules';

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const directions = Array.from({ length: 8 }, (_, i) => ({ x: Math.round(Math.cos(i * Math.PI / 4)), y: Math.round(Math.sin(i * Math.PI / 4)) }));
const follows = (a: Point | undefined, b: Point) => !a || (a.x * b.x + a.y * b.y) >= 0.7071 * Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y);
const vector = (a: Point, b: Point) => ({ x: b.x - a.x, y: b.y - a.y });

export function connectorPaths(a: Point, b: Point): Point[][] {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const diagonal = Math.min(Math.abs(dx), Math.abs(dy));
	return [
		[a, { x: a.x + Math.sign(dx) * diagonal, y: a.y + Math.sign(dy) * diagonal }, b],
		[a, { x: b.x - Math.sign(dx) * diagonal, y: b.y - Math.sign(dy) * diagonal }, b],
	].map(path => path.filter((p, i) => !i || distance(p, path[i - 1]) > 0.001));
}

// Route only the requested connector. The caller fixes the offset body and
// original pad/via contacts; the grid never changes their requested pitch.
export function* detourSteps(start: Point, end: Point, source: Line, copper: Line[], obstacles: Obstacle[], boundaries: Line[], clearance: Clearance, heading?: Point, ending?: Point, padding = 200): Steps<Point[] | undefined> {
	const step = Math.max(2, Math.min(4, (source.width + clearanceStep(clearance)) / 3));
	const margin = clearanceStep(clearance) + source.width / 2 + 0.02;
	const domain = { minX: Math.min(start.x, end.x) - padding, maxX: Math.max(start.x, end.x) + padding, minY: Math.min(start.y, end.y) - padding, maxY: Math.max(start.y, end.y) + padding };
	interface Block { box: Box; test: (a: Point, b: Point) => boolean }
	const cells = new Map<string, Block[]>();
	const tile = 32;
	const index = (block: Block, extra: number) => {
		const box = { minX: Math.max(domain.minX, block.box.minX - extra), maxX: Math.min(domain.maxX, block.box.maxX + extra), minY: Math.max(domain.minY, block.box.minY - extra), maxY: Math.min(domain.maxY, block.box.maxY + extra) };
		for (let x = Math.floor(box.minX / tile); x <= Math.floor(box.maxX / tile); x++) {
			for (let y = Math.floor(box.minY / tile); y <= Math.floor(box.maxY / tile); y++) {
				const key = `${x}/${y}`;
				if (!cells.has(key))
					cells.set(key, []);
				cells.get(key)!.push(block);
			}
		}
	};
	for (const line of [...copper, ...boundaries]) {
		yield;
		if (line.layer !== 11 && (line.layer !== source.layer || line.net === source.net))
			continue;
		const gap = clearanceGap(clearance, source, line, line.layer === 11 ? 'Board Outline' : 'Track') + (source.width + line.width) / 2;
		index({ box: { minX: Math.min(line.start.x, line.end.x), maxX: Math.max(line.start.x, line.end.x), minY: Math.min(line.start.y, line.end.y), maxY: Math.max(line.start.y, line.end.y) }, test: (a, b) => segmentDistance(a, b, line.start, line.end) < gap - 0.001 }, gap);
	}
	for (const obstacle of obstacles) {
		yield;
		if (obstacle.net === source.net || (obstacle.layer !== source.layer && obstacle.layer !== 12))
			continue;
		const gap = clearanceGap(clearance, source, obstacle, obstacle.kind ?? 'Track') + source.width / 2;
		if (obstacle.polygon) {
			// Index the closed boundary instead of testing every polygon edge at
			// each node in the large native bounding box. No path can enter it.
			if ([start, end].some(p => obstacleDistance({ ...source, start: p, end: p }, obstacle) < gap - 0.001))
				return undefined;
			const points = obstacle.polygon;
			const required = gap + (obstacle.stroke ?? 0) / 2;
			for (const [i, a] of points.entries()) {
				const b = points[(i + 1) % points.length];
				index({ box: { minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y) }, test: (p, q) => segmentDistance(p, q, a, b) < required - 0.001 }, required);
			}
			continue;
		}
		index({ box: obstacle.box, test: (a, b) => obstacleDistance({ ...source, start: a, end: b }, obstacle) < gap - 0.001 }, gap + margin);
	}
	const free = (a: Point, b: Point) => {
		const tested = new Set<Block>();
		for (let x = Math.floor(Math.min(a.x, b.x) / tile); x <= Math.floor(Math.max(a.x, b.x) / tile); x++) {
			for (let y = Math.floor(Math.min(a.y, b.y) / tile); y <= Math.floor(Math.max(a.y, b.y) / tile); y++) {
				for (const block of cells.get(`${x}/${y}`) ?? []) {
					if (!tested.has(block) && block.test(a, b))
						return false;
					tested.add(block);
				}
			}
		}
		return true;
	};
	interface Node { x: number; y: number; direction: number; g: number; f: number; parent?: Node }
	const heap: Node[] = [];
	const push = (node: Node) => {
		heap.push(node);
		let i = heap.length - 1;
		while (i > 0) {
			const parent = (i - 1) >> 1;
			if (heap[parent].f <= node.f)
				break;
			heap[i] = heap[parent];
			i = parent;
		}
		heap[i] = node;
	};
	const pop = () => {
		const first = heap[0];
		const last = heap.pop()!;
		if (heap.length) {
			let i = 0;
			while (i * 2 + 1 < heap.length) {
				let child = i * 2 + 1;
				if (child + 1 < heap.length && heap[child + 1].f < heap[child].f)
					child++;
				if (heap[child].f >= last.f)
					break;
				heap[i] = heap[child];
				i = child;
			}
			heap[i] = last;
		}
		return first;
	};
	const location = (n: { x: number; y: number }) => ({ x: start.x + n.x * step, y: start.y + n.y * step });
	push({ x: 0, y: 0, direction: -1, g: 0, f: distance(start, end) });
	const best = new Map<string, number>();
	let count = 0;
	while (heap.length && count++ < 200000) {
		if (count % 32 === 0)
			yield;
		const node = pop();
		if (node.g > (best.get(`${node.x}/${node.y}/${node.direction}`) ?? Infinity) + 1e-8)
			continue;
		const point = location(node);
		const incoming = node.direction < 0 ? heading : directions[node.direction];
		if (distance(point, end) <= 3 * step) {
			for (const tail of connectorPaths(point, end)) {
				let direction = incoming;
				let valid = true;
				for (let i = 1; i < tail.length; i++) {
					const next = vector(tail[i - 1], tail[i]);
					if (!follows(direction, next) || !free(tail[i - 1], tail[i])) {
						valid = false;
						break;
					}
					direction = next;
				}
				if (!valid || !follows(direction, ending ?? direction ?? { x: 1, y: 0 }))
					continue;
				const path: Point[] = tail.slice(1);
				let current: Node | undefined = node;
				while (current) {
					path.unshift(location(current));
					current = current.parent;
				}
				return path;
			}
		}
		for (const [i, d] of directions.entries()) {
			if (!follows(incoming, d))
				continue;
			const next = { x: node.x + d.x, y: node.y + d.y };
			const to = location(next);
			if (!contains(domain, to) || !free(point, to))
				continue;
			const g = node.g + step * Math.hypot(d.x, d.y) + (node.direction !== i ? step * 0.2 : 0);
			const key = `${next.x}/${next.y}/${i}`;
			if (g >= (best.get(key) ?? Infinity))
				continue;
			best.set(key, g);
			push({ ...next, direction: i, g, f: g + distance(to, end), parent: node });
		}
	}
	return undefined;
}
