import type { Line } from './geometry';

type RecordValue = Record<string, unknown>;
export type RuleObject = 'Track' | 'SMD Pad' | 'TH Pad' | 'Via' | 'Fill Region/Teardrop' | 'Slot Region' | 'Board Outline';
export interface RuleSnapshot {
	configuration: RecordValue;
	nets: RecordValue[];
	pairs: RecordValue;
	regions: RecordValue[];
	classes: { name: string; nets: string[] }[];
}
export interface SpacingPolicy {
	max: number;
	summary: string;
	gap: (a: string, b: string, layer: number, object: RuleObject) => number;
}
export type Clearance = number | SpacingPolicy;

function fail(message: string): never {
	throw new Error(`无法自动读取 PCB 净距规则：${message}`);
}
const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : fail('规则格式无法识别');
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : fail('规则列表格式无法识别');

export async function readRuleSnapshot(): Promise<RuleSnapshot> {
	const [configuration, nets, pairs, regions, classes] = await Promise.all([
		eda.pcb_Drc.getCurrentRuleConfiguration(),
		eda.pcb_Drc.getNetRules(),
		eda.pcb_Drc.getNetByNetRules(),
		eda.pcb_Drc.getRegionRules(),
		eda.pcb_Drc.getAllNetClasses(),
	]);
	return JSON.parse(JSON.stringify({ configuration: record(configuration), nets: array(nets).map(record), pairs: record(pairs), regions: array(regions).map(record), classes: array(classes) })) as RuleSnapshot;
}

export const clearanceStep = (clearance: Clearance) => typeof clearance === 'number' ? clearance : clearance.max;
export function clearanceGap(clearance: Clearance, line: Line, other: { net: string }, object: RuleObject = 'Track') {
	return typeof clearance === 'number'
		? clearance
		: clearance.gap(line.net, other.net, line.layer, object);
}

export function createSpacingPolicy(snapshot: RuleSnapshot, layers: number[]): SpacingPolicy {
	const config = record(snapshot.configuration.config);
	const definitions = record(record(config.Spacing)['Safe Spacing']);
	const defaults = Object.entries(definitions).filter(([, value]) => record(value).isSetDefault === true);
	if (defaults.length !== 1)
		fail('没有唯一的默认安全间距规则');
	const defaultName = defaults[0][0];
	const resolve = (value: unknown): string => {
		if (value === undefined || value === null || value === 'default')
			return defaultName;
		if (typeof value !== 'string' || !definitions[value])
			return fail(`找不到安全间距规则 ${String(value)}`);
		return value;
	};
	const assignments = new Map<string, string>();
	const explicit = new Map<string, string>();
	for (const item of snapshot.nets) {
		if (item.type === 'netClass') {
			const name = resolve(item['Safe Spacing']);
			const members = snapshot.classes.find(c => c.name === item.name)?.nets ?? [];
			for (const net of members)
				assignments.set(net, name);
			for (const child of array(item.sub ?? []).map(record)) {
				if (child.type !== 'net' || typeof child.name !== 'string')
					fail('网络类成员格式无法识别');
				assignments.set(child.name as string, child['Safe Spacing'] === undefined ? name : resolve(child['Safe Spacing']));
			}
		}
		else if (item.type === 'net' && typeof item.name === 'string') {
			explicit.set(item.name, resolve(item['Safe Spacing']));
		}
		else {
			fail('网络规则类型无法识别');
		}
	}
	for (const [net, name] of explicit)
		assignments.set(net, name);

	// Public APIs leave scoped-rule selectors untyped. Until those selectors
	// are verified, enforce their referenced spacing templates everywhere rather
	// than silently ignoring a potentially stricter net-pair/region requirement.
	const scoped = new Set<string>();
	let scopedPresent = false;
	const visit = (value: unknown) => {
		if (typeof value === 'string') {
			if (definitions[value])
				scoped.add(value);
		}
		else if (Array.isArray(value)) {
			value.forEach(visit);
		}
		else if (value && typeof value === 'object') {
			Object.values(value).forEach(visit);
		}
	};
	const pairSpacing = array(snapshot.pairs['Safe Spacing'] ?? []);
	if (pairSpacing.length || snapshot.regions.length) {
		scopedPresent = true;
		visit(pairSpacing);
		visit(snapshot.regions);
		if (!scoped.size)
			Object.keys(definitions).forEach(name => scoped.add(name));
	}
	const cache = new Map<string, number>();
	const cell = (name: string, layer: number, object: RuleObject) => {
		const key = `${name}/${layer}/${object}`;
		if (cache.has(key))
			return cache.get(key)!;
		const definition = record(definitions[name]);
		const factor = definition.unit === 'mil' ? 1 : definition.unit === 'mm' ? 1 / 0.0254 : fail('规则单位不是 mil 或 mm');
		const tables = record(definition.tables);
		if (definition.status !== 0 && definition.status !== 1)
			fail('安全间距分层格式无法识别');
		const table = record(tables[definition.status === 0 ? '1' : String(layer)]);
		const rows = array(definition.row);
		const columns = array(definition.column);
		const ri = rows.indexOf(object);
		const ci = columns.indexOf('Track');
		if (ri < 0 || ci < 0)
			fail(`缺少导线到 ${object} 的规则`);
		const contents = array(table.content);
		const value = Array.isArray(contents[ri]) ? contents[ri][ci] : undefined;
		if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
			fail(`规则 ${name} 第 ${layer} 层 ${object} 净距无效`);
		const gap = (value as number) * factor;
		cache.set(key, gap);
		return gap;
	};
	const gap = (a: string, b: string, layer: number, object: RuleObject) => {
		const names = new Set([assignments.get(a) ?? defaultName, assignments.get(b) ?? defaultName, ...scoped]);
		return Math.max(...[...names].map(name => cell(name, layer, object)));
	};
	const names = new Set([defaultName, ...assignments.values(), ...scoped]);
	const max = Math.max(...layers.flatMap(layer => [...names].map(name => cell(name, layer, 'Track'))));
	if (!Number.isFinite(max))
		fail('没有可用铜层');
	return { max, gap, summary: `${String(snapshot.configuration.name ?? '当前 PCB')} · ${defaultName}${scopedPresent ? ' · 区域/网络对按引用规则较大值避让' : ''}` };
}

export function summarizeRules(snapshot: RuleSnapshot, lines: Line[]) {
	lines = [...new Map(lines.map(line => [`${line.layer}/${line.net}`, line])).values()];
	const layer = lines[0]?.layer ?? 1;
	const policy = createSpacingPolicy(snapshot, [layer]);
	const gaps = lines.flatMap((a, i) => lines.slice(i + 1).map(b => policy.gap(a.net, b.net, layer, 'Track')));
	return { min: gaps.length ? Math.min(...gaps) : policy.max, max: gaps.length ? Math.max(...gaps) : policy.max, description: policy.summary };
}
