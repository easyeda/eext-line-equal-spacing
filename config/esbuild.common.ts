import type esbuild from 'esbuild';
import { buildPanel } from './build-panel.ts';

export default {
	entryPoints: {
		index: './src/index',
	},
	entryNames: '[name]',
	assetNames: '[name]',
	bundle: true, // 用于内部方法调用，请勿修改
	minify: false, // 用于内部方法调用，请勿修改
	loader: {},
	outdir: './dist/',
	sourcemap: undefined,
	platform: 'browser', // 用于内部方法调用，请勿修改
	format: 'iife', // 用于内部方法调用，请勿修改
	globalName: 'edaEsbuildExportName', // 用于内部方法调用，请勿修改
	treeShaking: true,
	ignoreAnnotations: true,
	define: {},
	external: [],
	plugins: [{
		name: 'inline-iframe-panel',
		setup(build) {
			build.onEnd(async (result) => {
				if (!result.errors.length)
					await buildPanel();
			});
		},
	}],
} satisfies Parameters<(typeof esbuild)['build']>[0];
