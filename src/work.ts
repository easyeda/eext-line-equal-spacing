export type Progress = (message: string) => void | Promise<void>;
export type Steps<T> = Generator<string | undefined, T, unknown>;

let serial = 0;
let timerDelay = 0;
const budget = () => Math.max(8, Math.min(32, Math.ceil(timerDelay / 8)));

export function yieldEditor(): Promise<void> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		if (!eda.sys_Timer.setTimeoutTimer(`route-spacing-yield-${serial++}`, 1, () => {
			timerDelay = Date.now() - started;
			resolve();
		})) {
			reject(new Error('无法安排分步计算，未继续写入'));
		}
	});
}

export function finish<T>(steps: Steps<T>): T {
	let next = steps.next();
	while (!next.done)
		next = steps.next();
	return next.value;
}

export function checkpoint() {
	let started = Date.now();
	return async () => {
		if (Date.now() - started >= budget()) {
			await yieldEditor();
			started = Date.now();
		}
	};
}

export async function runCooperatively<T>(steps: Steps<T>, progress?: Progress): Promise<T> {
	let lastMessage = '';
	let lastReport = 0;
	if (progress)
		await yieldEditor();
	let start = Date.now();
	while (true) {
		const next = steps.next();
		if (next.done)
			return next.value;
		if (next.value && next.value !== lastMessage && Date.now() - lastReport >= 150) {
			lastMessage = next.value;
			lastReport = Date.now();
			await progress?.(lastMessage);
		}
		if (Date.now() - start >= budget()) {
			await yieldEditor();
			start = Date.now();
		}
	}
}
