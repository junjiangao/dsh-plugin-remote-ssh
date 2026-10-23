import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRemoteHome, workspaceIdFor } from '../../lib/remote-home.js';

test('prepareRemoteHome links the profile, inherits credentials and seeds the remote workspace', async () => {
	const base = await mkdtemp(join(tmpdir(), 'rssh-home-'));
	const dshHome = join(base, 'dsh');
	const profileDir = join(dshHome, 'profiles', 'dsh-remote');
	const dataDir = join(base, 'data');
	const workspace = join(base, 'remote-workspace');
	await mkdir(profileDir, { recursive: true });
	await mkdir(workspace, { recursive: true });
	await writeFile(join(dshHome, '.credentials.yaml'), 'provider: test\n');

	const result = await prepareRemoteHome({
		dataDir,
		dshHome,
		host: { id: 'host_abc' },
		profileName: 'dsh-remote',
		profileDir,
		workspace,
	});
	assert.equal(result.home, join(dataDir, 'homes', 'host_abc'));
	assert.equal(await readlink(join(result.home, 'profiles', 'dsh-remote')), profileDir);
	assert.equal(await readlink(join(result.home, '.credentials.yaml')), join(dshHome, '.credentials.yaml'));
	const registry = JSON.parse(await readFile(join(result.home, 'storages', 'workspace.json'), 'utf8'));
	const id = workspaceIdFor('host_abc', workspace);
	assert.deepEqual(registry.global.workspaceIds, [id]);
	assert.equal(registry.tables.workspaces[id].path, workspace);
	assert.equal(registry.global.initialized, true);
});

test('prepareRemoteHome preserves an existing remote workspace and additional workspaces', async () => {
	const base = await mkdtemp(join(tmpdir(), 'rssh-home-'));
	const dshHome = join(base, 'dsh');
	const profileDir = join(dshHome, 'profiles', 'dsh-remote');
	const dataDir = join(base, 'data');
	const workspace = join(base, 'remote-workspace');
	await mkdir(profileDir, { recursive: true });
	await mkdir(workspace, { recursive: true });
	const first = await prepareRemoteHome({
		dataDir,
		dshHome,
		host: { id: 'host_abc' },
		profileName: 'dsh-remote',
		profileDir,
		workspace,
	});
	const file = join(first.home, 'storages', 'workspace.json');
	const registry = JSON.parse(await readFile(file, 'utf8'));
	const extraId = '00000000-0000-0000-0000-000000000001';
	registry.global.workspaceIds.push(extraId);
	registry.tables.workspaces[extraId] = {
		path: join(base, 'other'),
		title: 'other',
		sessionIds: [],
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
	await writeFile(file, `${JSON.stringify(registry, null, 2)}\n`);
	await prepareRemoteHome({
		dataDir,
		dshHome,
		host: { id: 'host_abc' },
		profileName: 'dsh-remote',
		profileDir,
		workspace,
	});
	const after = JSON.parse(await readFile(file, 'utf8'));
	assert.equal(after.global.workspaceIds.length, 2);
	assert.equal(after.tables.workspaces[extraId].path, join(base, 'other'));
	assert.equal(existsSync(join(after.tables.workspaces[workspaceIdFor('host_abc', workspace)].path)), true);
});
