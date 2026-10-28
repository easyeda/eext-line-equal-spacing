import fs from 'node:fs/promises';
import { build } from 'esbuild';

export async function buildPanel() {
	const result = await build({ entryPoints: ['src/panel.ts'], bundle: true, write: false, format: 'iife', target: 'es2020', charset: 'utf8' });
	const template = await fs.readFile('iframe/panel.template.html', 'utf8');
	const css = await fs.readFile('iframe/style.css', 'utf8');
	const watchdog = `<script>window.addEventListener('error',function(e){var s=document.getElementById('status');if(s){s.textContent='面板启动失败：'+e.message;s.classList.add('error');}});window.addEventListener('unhandledrejection',function(e){var s=document.getElementById('status');if(s){s.textContent='操作失败：'+String(e.reason);s.classList.add('error');}});setTimeout(function(){if(!document.body.dataset.started){var s=document.getElementById('status');s.textContent='面板脚本未启动，请重新导入最新扩展包。';s.classList.add('error');}},4000);</script>`;
	const html = template.replace('<link rel="stylesheet" href="/iframe/style.css">', `<style>${css}</style>`)
		.replace('<script src="/iframe/app.js"></script>', () => `${watchdog}<script>${result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}</script>`)
		;
	if (html.includes('src="/iframe/app.js"') || !html.includes('document.body.dataset.started'))
		throw new Error('iframe inline build validation failed');
	await fs.writeFile('iframe/index.html', html);
}
