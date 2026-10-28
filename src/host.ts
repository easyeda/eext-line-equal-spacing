import type { Line } from './geometry';
import { equalLine, planSpacing, POSITION_TOLERANCE } from './geometry';

const TAG = '[LineEqualSpacing]';
// Verified EDMT_EditorDocumentType.PCB value.
// These SDK enums have ambient declarations, but no runtime globals in 4.1.71.
const PCB = 3;

export interface Selection {
	doc: IDMT_EditorDocumentItem;
	selectedIds: string[];
	lines: Line[];
	ignored: number;
}

export async function assertDocument(expected?: IDMT_EditorDocumentItem) {
	try {
		const doc = await eda.dmt_SelectControl.getCurrentDocumentInfo();
		if (!doc || doc.documentType !== PCB)
			throw new Error('请先激活 PCB 画布');
		if (expected && (expected.uuid !== doc.uuid || expected.parentProjectUuid !== doc.parentProjectUuid))
			throw new Error('PCB 已切换，请重新读取');
		return doc;
	}
	catch (error) {
		console.error(TAG, 'Document check failed', error);
		throw error;
	}
}

export function lineData(p: IPCB_PrimitiveLine): Line {
	return {
		id: p.getState_PrimitiveId(),
		layer: p.getState_Layer(),
		net: p.getState_Net(),
		width: p.getState_LineWidth(),
		locked: p.getState_PrimitiveLock(),
		start: { x: p.getState_StartX(), y: p.getState_StartY() },
		end: { x: p.getState_EndX(), y: p.getState_EndY() },
	};
}

export async function readSelection(): Promise<Selection> {
	try {
		const doc = await assertDocument();
		const selectedIds = (await eda.pcb_SelectControl.getAllSelectedPrimitives_PrimitiveId()).sort();
		// Concrete line.get(array) omits unmatched IDs, including pads and ratlines.
		const primitives = selectedIds.length ? await eda.pcb_PrimitiveLine.get(selectedIds) : [];
		const lines = primitives.map(lineData);
		await assertDocument(doc);
		const currentIds = (await eda.pcb_SelectControl.getAllSelectedPrimitives_PrimitiveId()).sort();
		if (JSON.stringify(currentIds) !== JSON.stringify(selectedIds))
			throw new Error('读取期间选中集发生变化，请重试');
		return { doc, selectedIds, lines, ignored: selectedIds.length - lines.length };
	}
	catch (error) {
		console.error(TAG, 'Read selected lines failed', error);
		throw error;
	}
}

export async function writeLine(doc: IDMT_EditorDocumentItem, target: Line, expected: Line | undefined, onWrite?: () => void) {
	try {
		await assertDocument(doc);
		const primitive = await eda.pcb_PrimitiveLine.get(target.id);
		if (!primitive)
			throw new Error(`线段 ${target.id} 已不存在`);
		if (expected && !equalLine(expected, lineData(primitive)))
			throw new Error('线段已被编辑，请重新读取');
		const asyncLine = primitive.toAsync();
		asyncLine.setState_StartX(target.start.x).setState_StartY(target.start.y).setState_EndX(target.end.x).setState_EndY(target.end.y);
		onWrite?.();
		await asyncLine.done();
		await assertDocument(doc);
		const written = await eda.pcb_PrimitiveLine.get(target.id);
		if (!written || !equalLine(target, lineData(written), POSITION_TOLERANCE))
			throw new Error('宿主写入的坐标与目标不一致');
	}
	catch (error) {
		console.error(TAG, 'Write line failed', error);
		throw error;
	}
}

export async function applySpacing(snapshot: Selection, spacing: number) {
	try {
		await assertDocument(snapshot.doc);
		const current = await readSelection();
		await assertDocument(snapshot.doc);
		if (JSON.stringify(current.selectedIds) !== JSON.stringify(snapshot.selectedIds)
			|| current.lines.length !== snapshot.lines.length
			|| snapshot.lines.some(l => !current.lines.some(c => equalLine(l, c)))) {
			throw new Error('选中线段已变化，请先重新读取');
		}
		const plan = planSpacing(current.lines, spacing);
		const attempted: typeof plan = [];
		try {
			for (const step of plan) {
				if (!step.moved)
					continue;
				await writeLine(snapshot.doc, step.after, step.before, () => attempted.push(step));
			}
			return { moved: attempted.length, count: plan.length };
		}
		catch (error) {
			const failed: string[] = [];
			for (const step of [...attempted].reverse()) {
				try {
					await writeLine(snapshot.doc, step.before, undefined);
				}
				catch (rollbackError) {
					console.error(TAG, 'Rollback failed', rollbackError);
					failed.push(step.before.id);
				}
			}
			throw new Error(`${error instanceof Error ? error.message : String(error)}；${failed.length ? `部分线段未恢复：${failed.join('、')}` : '已恢复原位置'}`);
		}
	}
	catch (error) {
		console.error(TAG, 'Apply spacing failed', error);
		throw error;
	}
}
