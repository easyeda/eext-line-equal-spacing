import type { Line, Point } from './geometry';
import type { Route } from './routes';

const length = (line: Line) => Math.hypot(line.end.x - line.start.x, line.end.y - line.start.y);
const center = (line: Line): Point => ({ x: (line.start.x + line.end.x) / 2, y: (line.start.y + line.end.y) / 2 });
interface Body { line: Line; weight: number }

function bodies(route: Route): Body[] {
	const groups = new Map<string, Body>();
	for (const line of route.lines) {
		const size = length(line);
		if (!Number.isFinite(size) || size <= 0.001)
			continue;
		const sign = line.end.x < line.start.x || (line.end.x === line.start.x && line.end.y < line.start.y) ? -1 : 1;
		const dx = (line.end.x - line.start.x) / size * sign;
		const dy = (line.end.y - line.start.y) / size * sign;
		const point = center(line);
		const key = `${dx.toFixed(4)}/${dy.toFixed(4)}/${(-point.x * dy + point.y * dx).toFixed(3)}`;
		const previous = groups.get(key);
		if (previous)
			previous.weight += size;
		else
			groups.set(key, { line, weight: size });
	}
	return [...groups.values()].sort((a, b) => b.weight - a.weight);
}

export function averageSelectionSpacing(selected: Route[]): number | undefined {
	if (selected.length < 2)
		return undefined;
	const lines = selected.map(bodies);
	if (lines.some(group => !group.length))
		return undefined;
	const directions = new Map<string, Point>();
	for (const { line } of lines.flat()) {
		const size = length(line);
		const sign = line.end.x < line.start.x || (line.end.x === line.start.x && line.end.y < line.start.y) ? -1 : 1;
		const tangent = { x: (line.end.x - line.start.x) / size * sign, y: (line.end.y - line.start.y) / size * sign };
		directions.set(`${tangent.x.toFixed(4)}/${tangent.y.toFixed(4)}`, tangent);
	}
	let best: { positions: number[]; score: number } | undefined;
	for (const tangent of directions.values()) {
		const supports = lines.map(group => group.find(({ line }) => Math.abs((line.end.x - line.start.x) * tangent.y - (line.end.y - line.start.y) * tangent.x) / length(line) < 0.00001));
		if (supports.some(line => !line))
			continue;
		const score = supports.reduce((sum, body) => sum + body!.weight, 0);
		if (!best || score > best.score) {
			best = { score, positions: supports.map((body) => {
				const point = center(body!.line);
				return -point.x * tangent.y + point.y * tangent.x;
			}) };
		}
	}
	const span = (positions: number[]) => Math.max(...positions) - Math.min(...positions);
	// Without a shared direction, use the larger left/right or top/bottom spread
	// of the route bodies. Fixed pad approaches do not enlarge that measurement.
	const centers = lines.map(group => center(group[0].line));
	const extent = best ? span(best.positions) : Math.max(span(centers.map(p => p.x)), span(centers.map(p => p.y)));
	const spacing = extent / (selected.length - 1);
	return Number.isFinite(spacing) && spacing > 0.001 ? spacing : undefined;
}
