import type { Line } from './geometry';
import type { Obstacle } from './routes';
import type { Progress, Steps } from './work';
import { assertConnectionsSteps } from './connectivity';
import { sameLineGeometry } from './geometry';
import { assertDocument, lineData } from './host';
import { dist } from './routes';
import { checkpoint, finish, runCooperatively } from './work';

export const JOURNAL_KEY = 'route-spacing-journal-v1';
export const PROGRESS_KEY = 'route-spacing-journal-progress-v1';
const TAG = '[RouteSpacingTransaction]';
const EPS = 0.001;

function interval(line: Line, axis: Line): [number, number] | undefined {
	if (line.net !== axis.net || line.layer !== axis.layer || Math.abs(line.width - axis.width) > EPS || line.locked !== axis.locked)
		return undefined;
	const length = dist(axis.start, axis.end);
	if (length < EPS)
		return undefined;
	const dx = (axis.end.x - axis.start.x) / length;
	const dy = (axis.end.y - axis.start.y) / length;
	if ([line.start, line.end].some(p => Math.abs((p.x - axis.start.x) * dy - (p.y - axis.start.y) * dx) > EPS))
		return undefined;
	const positions = [line.start, line.end].map(p => (p.x - axis.start.x) * dx + (p.y - axis.start.y) * dy);
	return [Math.min(...positions), Math.max(...positions)];
}

function overlap(a: Line, b: Line) {
	const span = interval(b, a);
	return span && Math.min(dist(a.start, a.end), span[1]) - Math.max(0, span[0]) > EPS;
}

function equalCoverage(expected: Line[], actual: Line[]) {
	const axis = expected[0];
	const left = expected.map(l => interval(l, axis)!);
	const right = actual.map(l => interval(l, axis)!);
	if ([...left, ...right].some(span => !span))
		return false;
	const knots = [...left, ...right].flat().sort((a, b) => a - b);
	return knots.slice(1).every((end, i) => {
		if (end - knots[i] <= EPS)
			return true;
		const middle = (end + knots[i]) / 2;
		const count = (spans: [number, number][]) => spans.filter(([a, b]) => middle > a && middle < b).length;
		return count(left) === count(right);
	});
}

function coveredBy(line: Line, context: Line[]) {
	const spans = context.map(l => interval(l, line)).filter((span): span is [number, number] => !!span).sort((a, b) => a[0] - b[0]);
	let end = 0;
	for (const span of spans) {
		if (span[0] > end + EPS)
			break;
		end = Math.max(end, span[1]);
	}
	return end >= dist(line.start, line.end) - EPS;
}

export function matchLayout(expected: Line[], actual: Line[]) {
	return finish(matchLayoutSteps(expected, actual));
}

export function* matchLayoutSteps(expected: Line[], actual: Line[]): Steps<{ pairs: Map<string, Line>; missing: Line[]; extra: Line[] }> {
	const available = new Map(actual.map(l => [l.id, l]));
	const pairs = new Map<string, Line>();
	const missing: Line[] = [];
	for (const line of expected) {
		yield;
		const original = available.get(line.id);
		const found = original && sameLineGeometry(line, original) ? original : [...available.values()].find(l => sameLineGeometry(line, l));
		if (found) {
			pairs.set(line.id, found);
			available.delete(found.id);
		}
		else {
			missing.push(line);
		}
	}
	// Native copper can merge adjacent collinear primitives or subdivide them.
	// Compare interval coverage with multiplicity, retaining strict metadata and
	// duplicate counts. Mere endpoint contact cannot hide a gap or extra copper.
	const pending = new Map(missing.map(l => [l.id, l]));
	for (const seed of missing) {
		yield;
		if (!pending.has(seed.id))
			continue;
		const left = new Map([[seed.id, seed]]);
		const right = new Map<string, Line>();
		let growing = true;
		while (growing) {
			yield;
			growing = false;
			for (const line of available.values()) {
				if (!right.has(line.id) && [...left.values()].some(l => overlap(l, line))) {
					right.set(line.id, line);
					growing = true;
				}
			}
			for (const line of pending.values()) {
				if (!left.has(line.id) && [...right.values()].some(l => overlap(l, line))) {
					left.set(line.id, line);
					growing = true;
				}
			}
		}
		if (!right.size || !equalCoverage([...left.values()], [...right.values()]))
			continue;
		for (const line of left.values()) {
			pairs.set(line.id, [...right.values()].find(l => overlap(l, line))!);
			pending.delete(line.id);
		}
		for (const line of right.values())
			available.delete(line.id);
	}
	return { pairs, missing: [...pending.values()], extra: [...available.values()] };
}

async function readLines(doc: IDMT_EditorDocumentItem, layers: Set<number>) {
	await assertDocument(doc);
	const lines = (await eda.pcb_PrimitiveLine.getAll()).map(lineData).filter(l => layers.has(l.layer));
	await assertDocument(doc);
	return lines;
}

async function createLine(doc: IDMT_EditorDocumentItem, line: Line, created: Set<string>) {
	await assertDocument(doc);
	const p = await eda.pcb_PrimitiveLine.create(line.net, line.layer as TPCB_LayersOfLine, line.start.x, line.start.y, line.end.x, line.end.y, line.width, line.locked);
	if (!p)
		throw new Error('创建目标线段失败');
	created.add(p.getState_PrimitiveId());
	// getAll() is authoritative; returned IDs can already have been rebuilt.
}

export async function replaceLayout(doc: IDMT_EditorDocumentItem, before: Line[], target: Line[], obstacles: Obstacle[], connectionReference = before, progress?: Progress) {
	const layers = new Set([...before, ...target].map(l => l.layer));
	const pause = checkpoint();
	const delta = await runCooperatively(matchLayoutSteps(target, before));
	const remove = delta.extra;
	const insert = delta.missing;
	const created = new Set<string>();
	const journal = { version: 1, doc, before, target, phase: 'prepared', created: [] as string[], error: '', timestamp: Date.now() };
	const persist = async (full = false) => {
		journal.created = [...created];
		const { before: _before, target: _target, ...status } = journal;
		if (!await eda.sys_Storage.setExtensionUserConfig(full ? JOURNAL_KEY : PROGRESS_KEY, full ? journal : status))
			throw new Error('无法保存走线恢复快照，未继续写入');
	};
	const removeLines = async (lines: Line[]) => {
		for (let i = 0; i < lines.length; i += 16) {
			await assertDocument(doc);
			if (!await eda.pcb_PrimitiveLine.delete(lines.slice(i, i + 16).map(l => l.id)))
				throw new Error('移除待替换线段失败');
			await pause();
		}
	};
	try {
		const current = await readLines(doc, layers);
		const start = await runCooperatively(matchLayoutSteps(before, current));
		if (start.missing.length || start.extra.length)
			throw new Error('写入前走线已变化，请重新读取');
		// Persist all original geometry before the first destructive API call.
		await persist(true);
		try {
			journal.phase = 'writing';
			await persist();
			// Remove all changing junctions together. Extending a diagonal while its
			// old trunk is still present makes the host split it at the obsolete vertex.
			await progress?.('正在替换走线…');
			await removeLines(remove);
			for (let i = 0; i < insert.length; i++) {
				await createLine(doc, insert[i], created);
				await persist();
				if (i % 4 === 3) {
					await progress?.(`正在写入走线 ${i + 1}/${insert.length}…`);
				}
				await pause();
			}
			await progress?.('正在回读并核对连接…');
			const actual = await readLines(doc, layers);
			const matched = await runCooperatively(matchLayoutSteps(target, actual));
			if (matched.missing.length || matched.extra.length)
				throw new Error(`宿主提交结果不一致：缺少 ${matched.missing.length} 段、多出 ${matched.extra.length} 段`);
			await runCooperatively(assertConnectionsSteps(connectionReference.map(l => ({ ...l, id: matched.pairs.get(l.id)?.id ?? l.id })), actual, obstacles));
			journal.phase = 'committed';
			await persist(true);
			return { modified: remove.length, added: Math.max(0, insert.length - remove.length), actual, aliases: matched.pairs };
		}
		catch (error) {
			journal.error = error instanceof Error ? error.message : String(error);
			journal.phase = 'restoring';
			await progress?.('正在恢复原走线…');
			try {
				await persist();
			}
			catch (storageError) {
				console.error(TAG, 'Journal update failed; original snapshot remains', storageError);
			}
			try {
				const current = await readLines(doc, layers);
				const restore = await runCooperatively(matchLayoutSteps(before, current));
				const context = [...before, ...target];
				const changed = [...remove, ...insert];
				const unknown = restore.extra.filter(l => !created.has(l.id)
					&& !(changed.some(c => overlap(c, l)) && coveredBy(l, context)));
				if (unknown.length)
					throw new Error(`存在无法归属本次操作的图元：${unknown.map(l => l.id).join('、')}`);
				await removeLines(restore.extra);
				for (let i = 0; i < restore.missing.length; i++) {
					await createLine(doc, restore.missing[i], created);
					await pause();
				}
				const final = await runCooperatively(matchLayoutSteps(before, await readLines(doc, layers)));
				if (final.missing.length || final.extra.length)
					throw new Error(`恢复核对失败：${[...new Set([...final.missing, ...final.extra].map(l => l.id))].join('、')}`);
				journal.phase = 'restored';
			}
			catch (restoreError) {
				console.error(TAG, 'Restore failed', restoreError);
				journal.phase = 'restore-failed';
				journal.error += `；${restoreError instanceof Error ? restoreError.message : String(restoreError)}`;
			}
			try {
				await persist(true);
			}
			catch (storageError) {
				console.error(TAG, 'Unable to save final journal', storageError);
			}
			throw new Error(`${journal.error}；${journal.phase === 'restored' ? '已恢复原位置（图元 ID 可能重建）' : '恢复未完成，原坐标快照已保留'}`);
		}
	}
	catch (error) {
		console.error(TAG, 'Group replacement failed', error);
		throw error;
	}
}
