/**
 * Mixed workspace registry: path mapping, idempotent registration, corruption.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
	MIXED_REGISTRY_VERSION,
	MixedRegistry,
	mountPathFor,
	remotePathAt,
	trimPath,
} from '../../lib/mixed-registry.js';

/** Create one temporary plugin data directory. */
async function sandbox() {
	const dir = await mkdtemp(join(tmpdir(), 'rssh-mixed-registry-'));
	return { dir, file: join(dir, 'mixed', 'workspaces.json'), mounts: join(dir, 'mixed', 'mounts') };
}

test('adds, lists and finds mounts by longest prefix', async () => {
	const area = await sandbox();
	try {
		const registry = new MixedRegistry(area.file);
		await registry.load();
		const mountPath = mountPathFor(area.mounts, 'host_a', '/home/me/project', '0123456789abcdef');
		const entry = await registry.add({
			hostId: 'host_a',
			hostAlias: 'alpha',
			remotePath: '/home/me/project',
			mountPath,
		});
		assert.equal(entry.remotePath, '/home/me/project');
		assert.equal(entry.mountPath, mountPath);
		assert.equal(registry.mountFor(mountPath + '/src/a.ts')?.id, entry.id);
		assert.equal(registry.mountFor('/home/me/project/src/a.ts'), undefined);

		const nested = await registry.add({
			hostId: 'host_a',
			hostAlias: 'alpha',
			remotePath: '/home/me/project/vendor',
			mountPath: mountPath + '/vendor',
		});
		assert.equal(registry.mountFor(mountPath + '/vendor/lib.js')?.id, nested.id);
		assert.equal(registry.mountFor(mountPath + '/other/lib.js')?.id, entry.id);
	} finally {
		await rm(area.dir, { recursive: true, force: true });
	}
});

test('registration is idempotent per host and remote path', async () => {
	const area = await sandbox();
	try {
		const registry = new MixedRegistry(area.file);
		const first = await registry.add({
			hostId: 'host_a',
			hostAlias: 'alpha',
			remotePath: '/home/me/project/',
			mountPath: join(area.mounts, 'one'),
		});
		const second = await registry.add({
			hostId: 'host_a',
			hostAlias: 'alpha-renamed',
			remotePath: '/home/me/project',
			mountPath: join(area.mounts, 'two'),
		});
		assert.equal(second.id, first.id);
		assert.equal(second.mountPath, join(area.mounts, 'two'));
		assert.equal(registry.list().length, 1);
		const document = JSON.parse(await readFile(area.file, 'utf8'));
		assert.equal(document.version, MIXED_REGISTRY_VERSION);
		assert.equal(document.workspaces.length, 1);
	} finally {
		await rm(area.dir, { recursive: true, force: true });
	}
});

test('removes entries by id and host', async () => {
	const area = await sandbox();
	try {
		const registry = new MixedRegistry(area.file);
		const one = await registry.add({ hostId: 'host_a', hostAlias: 'a', remotePath: '/p1', mountPath: join(area.mounts, 'p1') });
		await registry.add({ hostId: 'host_a', hostAlias: 'a', remotePath: '/p2', mountPath: join(area.mounts, 'p2') });
		const three = await registry.add({ hostId: 'host_b', hostAlias: 'b', remotePath: '/p3', mountPath: join(area.mounts, 'p3') });
		assert.equal(await registry.remove(one.id), true);
		assert.equal(await registry.remove(one.id), false);
		assert.equal(await registry.removeHost('host_a'), 1);
		assert.deepEqual(registry.list().map((entry) => entry.id), [three.id]);
	} finally {
		await rm(area.dir, { recursive: true, force: true });
	}
});

test('a corrupt registry is backed up and reset', async () => {
	const area = await sandbox();
	try {
		await writeFile(area.file, '{not json', 'utf8').catch(async () => {
			await import('node:fs/promises').then(({ mkdir }) => mkdir(join(area.dir, 'mixed'), { recursive: true }));
			await writeFile(area.file, '{not json', 'utf8');
		});
		const registry = new MixedRegistry(area.file);
		await registry.load();
		assert.deepEqual(registry.list(), []);
	} finally {
		await rm(area.dir, { recursive: true, force: true });
	}
});

test('mount path derivation is readable and maps back to the remote path', () => {
	const mount = mountPathFor('/data/mixed/mounts', 'host_1', '/home/me/My Project', 'abcdef0123456789');
	assert.match(mount, /^\/data\/mixed\/mounts\/host_1\/home-me-My-Project-abcdef01$/u);
	const entry = { mountPath: mount, remotePath: '/home/me/My Project' };
	assert.equal(remotePathAt(entry, mount), '/home/me/My Project');
	assert.equal(remotePathAt(entry, mount + '/src/a.ts'), '/home/me/My Project/src/a.ts');
	assert.throws(() => remotePathAt(entry, '/elsewhere'), /outside the mount/u);
	assert.equal(trimPath('/'), '/');
	assert.equal(trimPath('/a/b/'), '/a/b');
});
