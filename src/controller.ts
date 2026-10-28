import type { Point } from './geometry';
import type { LayerChoice, RouteSelection, Scene } from './route-host';
import type { SelectionScope } from './routes';
import { assertDocument } from './host';
import { applyRoutes, choose, readScene } from './route-host';
import { summarizeRules } from './rules';
import { averageSelectionSpacing } from './selection-spacing';
import { matchLayout } from './transaction';

export const COMMAND_KEY = 'route-spacing-command-v3';
export const STATE_KEY = 'route-spacing-state-v3';
const TIMER = 'route-spacing-poll';
const LISTENER = 'route-spacing-clicks';
const TAG = '[RouteSpacing]';
let snapshot: RouteSelection | undefined;
let busy = false;
let lastCommand = '';
let first: Point | undefined;
let picking: { doc: IDMT_EditorDocumentItem; layer: LayerChoice; scope: SelectionScope; deadline: number } | undefined;
let detectedLayer: { id: number; name: string } | undefined;
let captureBusy = false;
let scope: SelectionScope = 'segment';
let defaultSpacingMil: number | undefined;
let selectionRevision = 0;
let needsRefresh = false;
const scopeLabel = (value: SelectionScope) => value === 'segment' ? '线段' : '完整路径';

function ruleInfo(scene: Scene) {
	try {
		return scene.rules && snapshot
			? { ruleSummary: summarizeRules(scene.rules, snapshot.chosen.flatMap(route => route.lines)), ruleError: null }
			: { ruleSummary: null, ruleError: scene.ruleError ?? '未读取到 PCB 规则' };
	}
	catch (error) {
		return { ruleSummary: null, ruleError: String(error) };
	}
}

async function publish(message: string, extra: Record<string, unknown> = {}) {
	try {
		await eda.sys_Storage.setExtensionUserConfig(STATE_KEY, { message, ...extra, defaultSpacingMil: defaultSpacingMil ?? null, selectionRevision, detectedLayer: detectedLayer ?? null, busy, picking: !!picking, count: snapshot?.chosen.length ?? 0, valid: !!snapshot, scope: snapshot?.scope ?? picking?.scope ?? scope, ack: lastCommand, revision: Date.now() });
	}
	catch (error) {
		console.error(TAG, 'Publish state failed', error);
	}
}

async function stopPicking() {
	try {
		picking = undefined;
		first = undefined;
		eda.pcb_Event.removeEventListener(LISTENER);
	}
	catch (error) {
		console.error(TAG, 'Remove picker listener failed', error);
	}
}

async function updateScene(scene: Scene, layer: LayerChoice, selectionScope: SelectionScope, box?: { minX: number; minY: number; maxX: number; maxY: number }, updateDefault = true) {
	try {
		snapshot = choose(scene, layer, box, selectionScope);
		const ids = snapshot.chosen.flatMap(route => route.lines.map(line => line.id));
		if (!await eda.pcb_SelectControl.clearSelected() || !await eda.pcb_SelectControl.doSelectPrimitives(ids))
			throw new Error('目标已识别，但画布选中失败，请重新读取');
		detectedLayer = scene.layers.find(l => l.id === snapshot!.chosen[0].layer);
		needsRefresh = false;
		if (updateDefault) {
			defaultSpacingMil = averageSelectionSpacing(snapshot.chosen);
			selectionRevision++;
		}
	}
	catch (error) {
		console.error(TAG, 'Select complete paths failed', error);
		throw error;
	}
}

export function pickerEvent(type: string): boolean {
	// Same confirmation events as eext-balance-copper; MOVE never confirms a point.
	return type === 'selected' || type === 'clearSelected';
}

async function beginPicking(layer: LayerChoice, selectionScope: SelectionScope) {
	try {
		await stopPicking();
		snapshot = undefined;
		detectedLayer = undefined;
		picking = { doc: await assertDocument(), layer, scope: selectionScope, deadline: Date.now() + 30000 };
		eda.pcb_Event.addMouseEventListener(LISTENER, 'all', async (type) => {
			if (!picking || captureBusy || !pickerEvent(type))
				return;
			captureBusy = true;
			try {
				await assertDocument(picking.doc);
				const p = await eda.pcb_SelectControl.getCurrentMousePosition();
				if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y))
					return;
				if (!first) {
					first = { ...p };
					await publish('已取第一角，请单击第二角');
					return;
				}
				if (Math.abs(p.x - first.x) < 10 || Math.abs(p.y - first.y) < 10)
					return;
				const target = picking;
				const box = { minX: Math.min(first.x, p.x), maxX: Math.max(first.x, p.x), minY: Math.min(first.y, p.y), maxY: Math.max(first.y, p.y) };
				await stopPicking();
				busy = true;
				await publish(`正在识别区域经过的${scopeLabel(target.scope)}…`);
				const scene = await readScene();
				await assertDocument(target.doc);
				await updateScene(scene, target.layer, target.scope, box);
				await publish(`已读取 ${snapshot!.chosen.length} 条${scopeLabel(target.scope)}`, { layers: scene.layers, ...ruleInfo(scene) });
			}
			catch (error) {
				console.error(TAG, 'Canvas picker failed', error);
				await stopPicking();
				snapshot = undefined;
				await publish(String(error), { error: true });
			}
			finally {
				busy = false;
				captureBusy = false;
				await publishCurrent();
			}
		});
		await publish('依次单击画布矩形的两个角，空白处也可');
	}
	catch (error) {
		await stopPicking();
		console.error(TAG, 'Start picker failed', error);
		throw error;
	}
}

async function publishCurrent() {
	try {
		const state = eda.sys_Storage.getExtensionUserConfig(STATE_KEY);
		await publish(state?.message ?? '请取区或读取选中走线', { ...state, busy, picking: !!picking, valid: !!snapshot });
	}
	catch (error) {
		console.error(TAG, 'Refresh state failed', error);
	}
}

async function tick() {
	if (busy || captureBusy)
		return;
	let handled = false;
	let retryable = false;
	try {
		if (picking && Date.now() > picking.deadline) {
			await stopPicking();
			await publish('选点超时，请重新取区', { error: true });
		}
		const command = eda.sys_Storage.getExtensionUserConfig(COMMAND_KEY);
		if (!command || command.id === lastCommand)
			return;
		lastCommand = command.id;
		handled = true;
		busy = true;
		scope = command.scope === 'segment' ? 'segment' : 'route';
		const targetLayer: LayerChoice = command.layer === 'auto' ? 'auto' : Number(command.layer);
		if (command.action === 'pick') {
			await beginPicking(targetLayer, scope);
		}
		else if (command.action === 'cancel') {
			await stopPicking();
			snapshot = undefined;
			detectedLayer = undefined;
			await publish('已取消取区');
		}
		else if (command.action === 'read') {
			await stopPicking();
			snapshot = undefined;
			detectedLayer = undefined;
			await publish(`正在读取${scopeLabel(scope)}…`);
			const scene = await readScene();
			await updateScene(scene, targetLayer, scope);
			await publish(`已读取 ${snapshot!.chosen.length} 条${scopeLabel(scope)}`, { layers: scene.layers, ...ruleInfo(scene) });
		}
		else if (command.action === 'apply') {
			if (!snapshot)
				throw new Error('请先取区或读取走线');
			if (targetLayer !== 'auto' && snapshot.chosen[0].layer !== targetLayer)
				throw new Error('铜层已改变，请重新取区/读取');
			if (snapshot.scope !== scope)
				throw new Error('取区范围已改变，请重新取区/读取');
			retryable = true;
			if (needsRefresh) {
				const previous = snapshot;
				await publish('正在重新读取并核对走线…');
				const scene = await readScene();
				await assertDocument(previous.scene.doc);
				const mapped = matchLayout(previous.scene.lines, scene.lines);
				if (mapped.missing.length || mapped.extra.length)
					throw new Error('画布走线已变化，请重新取区/读取');
				const ids = [...new Set(previous.chosen.flatMap(route => route.lines.map(line => mapped.pairs.get(line.id)!.id)))];
				await updateScene({ ...scene, selectedIds: ids }, targetLayer, scope, undefined, false);
				await publish('已重新核对走线', ruleInfo(scene));
			}
			await stopPicking();
			await publish(`正在计算并调整${scopeLabel(scope)}…`);
			const result = await applyRoutes(snapshot, Number(command.spacing), command.mode === 'push' ? 'push' : 'direct', command.clearanceSource === 'rules' ? 'rules' : Number(command.clearance), message => publish(message), command.compatible === true);
			snapshot = undefined;
			await publish(`已调整 ${result.targets} 条，推挤 ${result.pushed} 条；再次调整请重新读取`, { ruleSummary: result.ruleSummary });
		}
	}
	catch (error) {
		console.error(TAG, 'Command failed', error);
		if (retryable)
			needsRefresh = true;
		else
			snapshot = undefined;
		await publish(String(error), { error: true });
	}
	finally {
		busy = false;
		if (handled)
			await publishCurrent();
	}
}

export async function startController() {
	try {
		if (busy || captureBusy)
			throw new Error('正在处理路径，请稍候');
		await stopPicking();
		snapshot = undefined;
		detectedLayer = undefined;
		busy = false;
		lastCommand = '';
		scope = 'segment';
		defaultSpacingMil = undefined;
		needsRefresh = false;
		await eda.sys_Storage.setExtensionUserConfig(COMMAND_KEY, undefined);
		await publish('请取区或读取选中的走线', { ruleSummary: null, ruleError: null });
		if (!eda.sys_Timer.setIntervalTimer(TIMER, 200, () => {
			void tick();
		})) {
			throw new Error('无法启动走线控制器');
		}
	}
	catch (error) {
		console.error(TAG, 'Start controller failed', error);
		throw error;
	}
}

export async function closeController() {
	try {
		if (busy || captureBusy)
			return false;
		await stopPicking();
		eda.sys_Timer.clearIntervalTimer(TIMER);
		return true;
	}
	catch (error) {
		console.error(TAG, 'Close controller failed', error);
		return false;
	}
}
