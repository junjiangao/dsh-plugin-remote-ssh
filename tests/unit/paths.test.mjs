import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { resolveRuntime } from '../../lib/paths.js';

test('resolveRuntime treats desktop argv[6] as the Node bin directory', async () => {
	const root = await mkdtemp(join(tmpdir(), 'rssh-paths-'));
	const runtimeDir = join(root, 'app.asar.unpacked', 'dsh');
	const resources = join(root);
	const wrapper = join(resources, 'runtime', 'cli', 'bin', 'dsh');
	const binDir = join(resources, 'runtime', 'bin');
	const pnpm = join(root, 'pnpm.mjs');
	await mkdir(runtimeDir, { recursive: true });
	await mkdir(join(resources, 'runtime', 'cli', 'bin'), { recursive: true });
	await mkdir(binDir, { recursive: true });
	await writeFile(join(runtimeDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' }));
	await writeFile(wrapper, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
	await writeFile(join(binDir, basename(process.execPath)), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
	await writeFile(pnpm, '// pnpm\n');
	const argv = [process.execPath, 'entry', runtimeDir, join(root, 'profile'), join(root, 'primary'), pnpm, binDir];
	const runtime = resolveRuntime({ PATH: '' }, argv);
	assert.equal(runtime.isDesktop, true);
	assert.equal(runtime.cliPath, wrapper);
	assert.equal(runtime.nodePath, join(binDir, basename(process.execPath)));
	assert.equal(runtime.nodeBinDir, binDir);
	assert.deepEqual(runtime.pnpmArgs, [pnpm]);
	assert.equal(runtime.pnpmPath, join(binDir, basename(process.execPath)));
});

test('resolveRuntime still accepts an explicit Node file in argv[6]', async () => {
	const root = await mkdtemp(join(tmpdir(), 'rssh-paths-'));
	const runtimeDir = join(root, 'dsh');
	const pnpm = join(root, 'pnpm.mjs');
	const node = join(root, 'custom-node');
	await mkdir(runtimeDir, { recursive: true });
	await writeFile(join(runtimeDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' }));
	await writeFile(pnpm, '// pnpm\n');
	await writeFile(node, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
	const argv = [process.execPath, 'entry', runtimeDir, join(root, 'profile'), join(root, 'primary'), pnpm, node];
	const runtime = resolveRuntime({ PATH: '' }, argv);
	assert.equal(runtime.nodePath, node);
	assert.equal(runtime.nodeBinDir, root);
});
