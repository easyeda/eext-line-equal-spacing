export {};

const COMMAND = 'route-spacing-command-v3';
const STATE = 'route-spacing-state-v3';
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const unit = byId<HTMLSelectElement>('unit');
const layer = byId<HTMLSelectElement>('layer');
const mode = byId<HTMLSelectElement>('mode');
const scope = byId<HTMLSelectElement>('scope');
const spacing = byId<HTMLInputElement>('spacing');
const compatible = byId<HTMLInputElement>('compatible');
const clearance = byId<HTMLInputElement>('clearance');
const clearanceSource = byId<HTMLSelectElement>('clearanceSource');
let busy = false;
let picking = false;
let valid = false;
let polling = false;
let previousFactor = 1;
let serial = 0;
let pending = '';
let layerList = '';
let manualClearanceMil = 6;
let ruleSummary: { min: number; max: number; description: string } | undefined;
let ruleError: string | undefined;
let spacingRevision = -1;
document.body.dataset.started = 'true';

let readingTheme = false;
async function refreshTheme() {
	if (readingTheme)
		return;
	readingTheme = true;
	try {
		if (typeof eda !== 'undefined' && typeof eda.sys_Window?.getCurrentTheme === 'function') {
			const theme = await eda.sys_Window.getCurrentTheme();
			if (theme === 'light' || theme === 'dark')
				document.documentElement.dataset.theme = theme;
		}
	}
	catch { /* Keep the last host theme; before the first result CSS follows the system. */ }
	finally {
		readingTheme = false;
	}
}
void refreshTheme();
setInterval(() => void refreshTheme(), 1000);
window.addEventListener('focus', () => void refreshTheme());
document.addEventListener('visibilitychange', () => {
	if (!document.hidden)
		void refreshTheme();
});

function factor() {
	return unit.value === 'mm' ? 1 / 0.0254 : 1;
}
function status(message: string, error = false) {
	byId('status').textContent = message;
	byId('status').classList.toggle('error', error);
}
function renderRules() {
	if (clearanceSource.value !== 'rules')
		return;
	clearance.type = 'text';
	clearance.readOnly = true;
	const format = (value: number) => String(Number((value / factor()).toFixed(5)));
	clearance.value = !ruleError && ruleSummary ? `${format(ruleSummary.min)}${ruleSummary.max === ruleSummary.min ? '' : `–${format(ruleSummary.max)}`}` : '';
	clearance.placeholder = ruleError ? '规则读取失败' : '读取后显示';
	clearance.title = ruleError ?? (ruleSummary ? `${ruleSummary.description}；此处为目标导线间净距，焊盘/过孔/板边按对象规则分别避让` : '读取选中或两点取区时自动读取 PCB 设计规则');
}
function controls() {
	byId<HTMLButtonElement>('apply').disabled = busy || picking || !valid;
	byId<HTMLButtonElement>('read').disabled = busy || picking;
	byId<HTMLButtonElement>('pick').disabled = busy;
	byId('pick').textContent = picking ? '取消取区' : '两点取区';
	for (const field of [spacing, unit, layer, scope, mode, clearance, clearanceSource, compatible])
		field.disabled = busy || picking;
	clearance.disabled ||= mode.value !== 'push' || clearanceSource.value === 'rules';
	clearanceSource.disabled ||= mode.value !== 'push';
	renderRules();
	byId('strategy').textContent = compatible.checked ? '仅展开间距不足区域' : '严格等距';
	byId('hint').textContent = scope.value === 'segment'
		? '联动两端连接段 · 45°过渡 · 固定焊盘/过孔'
		: compatible.checked ? '局部展开 · 联动转角 · 固定端点' : '首条参考偏移 · 固定端点 · 45°过渡';
}
async function send(action: string) {
	if (busy)
		return;
	const pitch = spacing.valueAsNumber * factor();
	const gap = clearanceSource.value === 'rules' ? 0 : clearance.valueAsNumber * factor();
	if (action === 'apply' && (!Number.isFinite(pitch) || pitch <= 0 || !Number.isFinite(gap) || gap < 0)) {
		status('中心距须大于 0，避让净距不得小于 0', true);
		return;
	}
	try {
		busy = true;
		controls();
		status(action === 'pick' ? '请依次单击画布的两个角' : '正在处理…');
		pending = `${Date.now()}-${serial++}`;
		if (!await eda.sys_Storage.setExtensionUserConfig(COMMAND, { id: pending, action, layer: layer.value === 'auto' ? 'auto' : Number(layer.value), scope: scope.value, spacing: pitch, clearance: gap, clearanceSource: clearanceSource.value, mode: mode.value, compatible: compatible.checked })) {
			throw new Error('命令发送失败');
		}
	}
	catch (error) {
		console.error('[RouteSpacing]', error);
		busy = false;
		status(String(error), true);
		controls();
	}
}
async function poll() {
	if (polling)
		return;
	polling = true;
	try {
		const state = await eda.sys_Storage.getExtensionUserConfig(STATE);
		if (!state)
			return;
		if (pending && state.ack !== pending)
			return;
		pending = '';
		busy = !!state.busy;
		picking = !!state.picking;
		valid = !!state.valid;
		if (valid && !busy && typeof state.selectionRevision === 'number' && spacingRevision !== state.selectionRevision
			&& typeof state.defaultSpacingMil === 'number' && Number.isFinite(state.defaultSpacingMil) && state.defaultSpacingMil > 0) {
			spacing.value = String(Number((state.defaultSpacingMil / factor()).toFixed(5)));
			spacingRevision = state.selectionRevision;
		}
		if ('ruleSummary' in state)
			ruleSummary = state.ruleSummary ?? undefined;
		if ('ruleError' in state)
			ruleError = typeof state.ruleError === 'string' ? state.ruleError : undefined;
		byId('count').textContent = `${Number(state.count) || 0} 条${state.scope === 'segment' ? '线段' : '完整路径'}`;
		status(state.message ?? '请取区或读取', !!state.error);
		if (Array.isArray(state.layers) && JSON.stringify(state.layers) !== layerList) {
			layerList = JSON.stringify(state.layers);
			const old = layer.value;
			const options = state.layers as { id: number; name: string }[];
			layer.replaceChildren(new Option('自动识别', 'auto'), ...options.map(l => new Option(l.name, String(l.id))));
			if (old === 'auto' || options.some(l => String(l.id) === old))
				layer.value = old;
		}
		const automatic = layer.querySelector<HTMLOptionElement>('option[value="auto"]');
		if (automatic) {
			const detected = state.detectedLayer;
			const name = detected?.id === 1 ? '顶层' : detected?.id === 2 ? '底层' : detected?.name;
			automatic.textContent = name ? `自动·${name}` : '自动识别';
			layer.title = name ? `已按导线图层属性识别：${detected.name}；重新读取时重新识别` : '自动读取所选导线的图层属性；也可手动指定铜层';
		}
		controls();
	}
	catch (error) {
		console.error('[RouteSpacing]', error);
		status(`控制器连接失败：${String(error)}`, true);
	}
	finally {
		polling = false;
	}
}
byId('pick').onclick = () => void send(picking ? 'cancel' : 'pick');
byId('read').onclick = () => void send('read');
byId('apply').onclick = () => void send('apply');
layer.onchange = scope.onchange = () => {
	valid = false;
	controls();
	void send('cancel');
};
mode.onchange = controls;
compatible.onchange = controls;
clearanceSource.onchange = () => {
	if (clearanceSource.value === 'manual') {
		clearance.type = 'number';
		clearance.readOnly = false;
		clearance.value = String(Number((manualClearanceMil / factor()).toFixed(5)));
		clearance.title = '手动覆盖 PCB 净距规则，单位同中心距';
	}
	else if (Number.isFinite(clearance.valueAsNumber)) {
		manualClearanceMil = clearance.valueAsNumber * factor();
	}
	controls();
};
unit.onchange = () => {
	for (const field of clearanceSource.value === 'manual' ? [spacing, clearance] : [spacing]) {
		if (Number.isFinite(field.valueAsNumber))
			field.value = String(Number((field.valueAsNumber * previousFactor / factor()).toFixed(5)));
	}
	previousFactor = factor();
	renderRules();
};
controls();
void poll();
setInterval(() => {
	void poll();
}, 250);
