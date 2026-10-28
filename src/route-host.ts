import type { Line } from './geometry';
import type { Box, Obstacle, Route, SelectionScope } from './routes';
import type { RuleSnapshot } from './rules';
import type { Progress } from './work';
import { assertConnectionsSteps } from './connectivity';
import { equalLine } from './geometry';
import { assertDocument, lineData } from './host';
import { planLocalSpacingSteps } from './local-spacing';
import { buildRoutesSteps, materialize, outlinePoints, planRoutesSteps, planSegmentsSteps, selectRoutes, selectSegments, touchesBox } from './routes';
import { createSpacingPolicy, readRuleSnapshot, summarizeRules } from './rules';
import { replaceLayout } from './transaction';
import { checkpoint, runCooperatively } from './work';

const TAG = '[RouteSpacing]';
export interface Scene {
	doc: IDMT_EditorDocumentItem;
	lines: Line[];
	boundaries: Line[];
	obstacles: Obstacle[];
	routes: Route[];
	layers: { id: number; name: string }[];
	selectedIds: string[];
	boundaryError?: string;
	rules?: RuleSnapshot;
	ruleError?: string;
}
export interface RouteSelection { scene: Scene; chosen: Route[]; scope: SelectionScope }
export type LayerChoice = number | 'auto';

export async function readScene(progress?: Progress, withRoutes = true): Promise<Scene> {
	try {
		const pause = checkpoint();
		const doc = await assertDocument();
		const layers = (await eda.pcb_Layer.getAllLayers()).filter(l => l.type === 'SIGNAL' && l.layerStatus !== 0).map(l => ({ id: l.id, name: l.name }));
		const signals = new Set<number>(layers.map(l => l.id));
		const rawLines = await eda.pcb_PrimitiveLine.getAll();
		const allLines = rawLines.map(lineData).sort((a, b) => a.id.localeCompare(b.id));
		const lines = allLines.filter(l => signals.has(l.layer));
		// EPCB_LayerId.BOARD_OUTLINE = 11, MULTI = 12 (verified official enum values).
		const boundaries = allLines.filter(l => l.layer === 11);
		let boundaryError: string | undefined;
		const polylines = await eda.pcb_PrimitivePolyline.getAll();
		for (const polyline of polylines.filter(p => p.getState_Layer() === 11)) {
			try {
				const points = outlinePoints(polyline.getState_Polygon().getSource());
				for (let i = 0; i < points.length; i++) {
					boundaries.push({ id: `${polyline.getState_PrimitiveId()}/${i}`, net: '', layer: 11, width: 0, locked: true, start: points[i], end: points[(i + 1) % points.length] });
				}
			}
			catch (error) {
				console.error(TAG, 'Unsupported board outline', error);
				boundaryError = String(error);
			}
		}
		const pads = await eda.pcb_PrimitivePad.getAll();
		const components = await eda.pcb_PrimitiveComponent.getAll();
		const componentPads: IPCB_PrimitiveComponentPad[] = [];
		for (let i = 0; i < components.length; i += 12) {
			const groups = await Promise.all(components.slice(i, i + 12).map(c => c.getAllPins()));
			componentPads.push(...groups.flat());
			await pause();
		}
		const vias = await eda.pcb_PrimitiveVia.getAll();
		const arcs = await eda.pcb_PrimitiveArc.getAll();
		const fills = await eda.pcb_PrimitiveFill.getAll();
		const keepouts = (await eda.pcb_PrimitiveRegion.getAll()).filter(p => p.getState_RuleType().includes(5));
		const descriptors = [
			...[...pads, ...componentPads].map(p => ({ id: p.getState_PrimitiveId(), net: p.getState_Net() ?? '', layer: p.getState_Layer(), terminal: true, kind: p.getState_Layer() === 12 ? 'TH Pad' as const : 'SMD Pad' as const })),
			...vias.map(p => ({ id: p.getState_PrimitiveId(), net: p.getState_Net(), layer: 12, terminal: true, kind: 'Via' as const, circle: { center: { x: p.getState_X(), y: p.getState_Y() }, radius: p.getState_Diameter() / 2 } })),
			...arcs.map(p => ({ id: p.getState_PrimitiveId(), net: p.getState_Net(), layer: p.getState_Layer(), terminal: false, kind: 'Track' as const })),
			...fills.map((p) => {
				let polygon;
				try {
					if (p.getState_FillMode() === 0)
						polygon = outlinePoints(p.getState_ComplexPolygon().getSource());
				}
				catch { /* Unsupported source retains conservative native bounds. */ }
				return { id: p.getState_PrimitiveId(), net: p.getState_Net() ?? '', layer: p.getState_Layer(), terminal: false, kind: 'Fill Region/Teardrop' as const, polygon, stroke: p.getState_LineWidth() };
			}),
			// EPCB_PrimitiveRegionRuleType.NO_WIRES = 5. Keepout boxes block every net.
			...keepouts.map(p => ({ id: p.getState_PrimitiveId(), net: '', layer: p.getState_Layer(), terminal: false, kind: 'Slot Region' as const })),
			...polylines.filter(p => signals.has(p.getState_Layer())).map(p => ({ id: p.getState_PrimitiveId(), net: p.getState_Net(), layer: p.getState_Layer(), terminal: true, arc: true, kind: 'Track' as const })),
		].filter(p => signals.has(p.layer) || p.layer === 12 || p.layer === 11);
		const unique = [...new Map(descriptors.map(p => [p.id, p])).values()];
		const obstacles: Obstacle[] = [];
		for (let i = 0; i < unique.length; i += 16) {
			const group = await Promise.all(unique.slice(i, i + 16).map(async (p) => {
				const box = await eda.pcb_Primitive.getPrimitivesBBox([p.id]);
				if (!box || !Object.values(box).every(Number.isFinite))
					throw new Error(`无法读取障碍 ${p.id} 的边界，已停止`);
				return { ...p, layer: p.layer === 11 ? 12 : p.layer, box: { ...box } };
			}));
			obstacles.push(...group);
			await pause();
		}
		for (const arc of arcs) {
			const connection = arc.getState_PrimitiveId();
			const points = [{ x: arc.getState_StartX(), y: arc.getState_StartY() }, { x: arc.getState_EndX(), y: arc.getState_EndY() }];
			for (const [index, point] of points.entries()) {
				obstacles.push({ id: `${connection}/${index ? 'end' : 'start'}`, connection, anchor: point, radius: arc.getState_LineWidth() / 2, kind: 'Track', net: arc.getState_Net(), layer: arc.getState_Layer(), terminal: true, arc: true, box: { minX: point.x - 0.001, minY: point.y - 0.001, maxX: point.x + 0.001, maxY: point.y + 0.001 } });
			}
		}
		const selectedIds = await eda.pcb_SelectControl.getAllSelectedPrimitives_PrimitiveId();
		let rules: RuleSnapshot | undefined;
		let ruleError: string | undefined;
		try {
			rules = await readRuleSnapshot();
		}
		catch (error) {
			ruleError = `PCB 规则读取失败：${String(error)}`;
		}
		await assertDocument(doc);
		const routes = withRoutes ? await runCooperatively(buildRoutesSteps(lines, obstacles), progress) : [];
		return { doc, lines, boundaries, obstacles, routes, layers, selectedIds, boundaryError, rules, ruleError };
	}
	catch (error) {
		console.error(TAG, 'Read routing scene failed', error);
		throw error;
	}
}

export function resolveSelectionLayer(scene: Scene, choice: LayerChoice, box?: Box, scope: SelectionScope = 'route'): number {
	if (choice !== 'auto') {
		if (!scene.layers.some(l => l.id === choice))
			throw new Error('指定铜层不可用，请重新选择');
		return choice;
	}
	const selected = new Set(scene.selectedIds);
	const lines = scene.lines.filter(l => box ? touchesBox(l.start, l.end, box, l.width / 2) : selected.has(l.id));
	let ids = [...new Set(lines.map(l => l.layer))];
	if (box) {
		const touched = new Set(lines.map(l => l.id));
		ids = ids.filter(id => scope === 'segment'
			? lines.filter(l => l.layer === id).length >= 2
			: scene.routes.filter(r => r.layer === id && r.lines.some(l => touched.has(l.id))).length >= 2);
	}
	if (!ids.length)
		throw new Error(box ? '区域内没有足够的走线，请重新取区' : '请先选中至少两条同层导线，再读取选中');
	if (ids.length !== 1)
		throw new Error(box ? '区域内存在多个铜层的走线，请手动指定铜层' : '所选导线跨多个铜层，请手动指定铜层');
	return ids[0];
}

export function choose(scene: Scene, layer: LayerChoice, box?: Box, scope: SelectionScope = 'route'): RouteSelection {
	layer = resolveSelectionLayer(scene, layer, box, scope);
	const chosen = scope === 'segment'
		? selectSegments(scene.lines.filter(l => l.layer === layer), box, scene.selectedIds)
		: selectRoutes(scene.routes.filter(r => r.layer === layer), box, scene.selectedIds);
	return { scene, chosen, scope };
}

function fingerprint(scene: Scene) {
	return JSON.stringify({ lines: scene.lines, boundaries: scene.boundaries, obstacles: [...scene.obstacles].sort((a, b) => a.id.localeCompare(b.id)) });
}

export async function applyRoutes(snapshot: RouteSelection, spacing: number, mode: 'direct' | 'push', clearance: number | 'rules', progress?: Progress, compatible = false) {
	try {
		await assertDocument(snapshot.scene.doc);
		const fresh = snapshot.scene;
		const selectedIds = snapshot.chosen.flatMap(route => route.lines.map(l => l.id)).sort();
		if (JSON.stringify((await eda.pcb_SelectControl.getAllSelectedPrimitives_PrimitiveId()).sort()) !== JSON.stringify(selectedIds))
			throw new Error('画布选中路径已改变，请重新取区/读取');
		if (mode === 'push' && fresh.boundaryError)
			throw new Error(fresh.boundaryError);
		const usedRules = mode === 'push' && clearance === 'rules' ? await readRuleSnapshot() : undefined;
		const policy = usedRules ? createSpacingPolicy(usedRules, [...new Set(snapshot.chosen.map(route => route.layer))]) : typeof clearance === 'number' ? clearance : 0;
		const planner = compatible ? planLocalSpacingSteps : snapshot.scope === 'segment' ? planSegmentsSteps : planRoutesSteps;
		const plans = await runCooperatively(planner(fresh.routes, snapshot.chosen, spacing, mode, policy, fresh.obstacles, fresh.boundaries, snapshot.scope), progress);
		const changes = plans.flatMap(materialize).filter(step => !step.before || !equalLine(step.before, step.after));
		const planned = new Map(fresh.lines.map(l => [l.id, l]));
		let temporaryId = 0;
		for (const step of changes) {
			let id = step.after.id;
			if (!step.before) {
				do {
					id = `planned-connector/${temporaryId++}`;
				} while (planned.has(id));
			}
			planned.set(id, { ...step.after, id });
		}
		await progress?.('正在检查端点与连接…');
		await runCooperatively(assertConnectionsSteps(fresh.lines, [...planned.values()], fresh.obstacles));
		// The editor can process input between slices. Recheck copper AND fixed
		// obstacles after planning, immediately before starting the transaction.
		await progress?.('正在核对画布是否变化…');
		const current = await readScene(undefined, false);
		if (fingerprint(current) !== fingerprint(snapshot.scene))
			throw new Error('画布走线或障碍已变化，请重新取区/读取');
		if (usedRules && JSON.stringify(usedRules) !== JSON.stringify(current.rules))
			throw new Error(current.ruleError ?? 'PCB 设计规则已变化，请重新读取');
		if (JSON.stringify([...current.selectedIds].sort()) !== JSON.stringify(selectedIds))
			throw new Error('画布选中路径已改变，请重新取区/读取');
		const result = await replaceLayout(snapshot.scene.doc, fresh.lines, [...planned.values()], fresh.obstacles, fresh.lines, progress);
		return { targets: snapshot.chosen.length, pushed: plans.filter(p => p.pushed).length, modified: result.modified, added: result.added, ruleSummary: usedRules ? summarizeRules(usedRules, snapshot.chosen.flatMap(route => route.lines)) : undefined };
	}
	catch (error) {
		console.error(TAG, 'Route spacing failed', error);
		throw error;
	}
}
