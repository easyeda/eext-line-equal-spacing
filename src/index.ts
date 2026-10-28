import { closeController, startController } from './controller';

const TAG = '[LineEqualSpacing]';

export async function openPanel(): Promise<void> {
	try {
		const doc = await eda.dmt_SelectControl.getCurrentDocumentInfo();
		// EDMT_EditorDocumentType.PCB = 3. Ambient SDK enums are absent at runtime.
		if (doc?.documentType !== 3) {
			eda.sys_Dialog.showInformationMessage('请先打开 PCB 文档，再打开线段等距面板。');
			return;
		}
		await startController();
		const opened = await eda.sys_IFrame.openIFrame('/iframe/index.html', 286, 230, 'line-spacing', {
			title: '走线等距',
			maximizeButton: false,
			minimizeButton: true,
			grayscaleMask: false,
			onBeforeCloseCallFn: closeController,
		});
		if (!opened)
			throw new Error('无法打开验证面板');
	}
	catch (error) {
		console.error(TAG, 'openPanel failed', error);
		try {
			eda.sys_Dialog.showInformationMessage(`打开面板失败：${String(error)}`);
		}
		catch (feedbackError) {
			console.error(TAG, 'Feedback failed', feedbackError);
		}
	}
}
