import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostStore } from '../../lib/store.js';

async function tempStore() {
	const dir = await mkdtemp(join(tmpdir(), 'rssh-store-'));
	const store = new HostStore(join(dir, 'hosts.json'));
	await store.load();
	return { dir, store };
}

test('HostStore saves, updates and deletes records atomically', async () => {
	const { dir, store } = await tempStore();
	const created = await store.save({ alias: 'one', hostname: '10.0.0.1', user: 'root' });
	assert.match(created.id, /^host_[0-9a-f]{16}$/);
	assert.equal(created.createdAt, created.updatedAt);
	const updated = await store.save({ ...created, alias: 'one-updated', port: 2222 });
	assert.equal(updated.id, created.id);
	assert.equal(updated.alias, 'one-updated');
	assert.equal(updated.createdAt, created.createdAt);
	assert.notEqual(updated.updatedAt, undefined);
	const reloaded = new HostStore(join(dir, 'hosts.json'));
	await reloaded.load();
	assert.equal(reloaded.list().length, 1);
	assert.equal(reloaded.get(created.id).port, 2222);
	await store.remove(created.id);
	assert.equal(store.list().length, 0);
	const text = await readFile(join(dir, 'hosts.json'), 'utf8');
	assert.equal(JSON.parse(text).hosts.length, 0);
});

test('HostStore rejects duplicate aliases but allows the same id', async () => {
	const { store } = await tempStore();
	const first = await store.save({ alias: 'dup', hostname: 'h1' });
	await assert.rejects(store.save({ alias: 'dup', hostname: 'h2' }), /already used/);
	const same = await store.save({ ...first, hostname: 'h3' });
	assert.equal(same.alias, 'dup');
});

test('HostStore preserves a corrupt file as a timestamped backup', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'rssh-store-'));
	const file = join(dir, 'hosts.json');
	await writeFile(file, '{not json');
	const store = new HostStore(file);
	await store.load();
	assert.equal(store.list().length, 0);
	assert.equal(store.warnings.length, 1);
	assert.match(store.warnings[0], /corrupt/);
});

test('HostStore reports missing ids instead of creating a second record', async () => {
	const { store } = await tempStore();
	await assert.rejects(store.save({ id: 'host_doesnotexist', alias: 'x', hostname: 'h' }), /does not exist/);
});
