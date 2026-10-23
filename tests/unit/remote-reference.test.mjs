import test from 'node:test';
import assert from 'node:assert/strict';
import { posix } from 'node:path';
import { apply } from '../../lib/remote-reference.js';

function targetFor(path, cwd) {
	const normalized = posix.normalize(path.startsWith('/') ? path : posix.join(cwd, path));
	return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

function providerFor(cwd, listing) {
	const provided = {};
	const fs = {
		async resolve(path, options = {}) {
			return { targetKey: targetFor(path, options.cwd ?? cwd), displayPath: path };
		},
		async listDir(target) {
			return listing[target.targetKey] ?? [];
		},
		processPath(target) {
			return target.targetKey;
		},
	};
	apply({
		fs,
		workingDirectory: { ensure: async () => cwd },
		provide(name, value) {
			provided[name] = value;
		},
	});
	return provided.fileReferences;
}

const cwd = '/home/me';
const entries = (dir, children) => children.map(([name, type]) => ({
	name,
	type,
	target: { targetKey: posix.join(dir, name), displayPath: name },
}));

const listing = {
	'/home/me': [
		...entries('/home/me', [['Work', 'directory'], ['README.md', 'file'], ['.zshrc', 'file'], ['node_modules', 'directory']]),
	],
	'/home/me/Work': entries('/home/me/Work', [['axonhub', 'directory'], ['notes.txt', 'file']]),
	'/etc': entries('/etc', [['hosts', 'file']]),
};

test('remote file references list immediate remote children and skip excluded dirs', async () => {
	const service = providerFor(cwd, listing);
	const all = await service.list({}, '');
	assert.deepEqual(all.map((entry) => entry.path), ['Work', 'README.md']);
	assert.equal(all[0].kind, 'directory');
});

test('remote file references filter by prefix and descend one typed directory', async () => {
	const service = providerFor(cwd, listing);
	assert.deepEqual((await service.list({}, 'READ')).map((entry) => entry.path), ['README.md']);
	assert.deepEqual((await service.list({}, 'Work/')).map((entry) => entry.path), ['Work/axonhub', 'Work/notes.txt']);
	assert.deepEqual((await service.list({}, 'Work/ax')).map((entry) => entry.path), ['Work/axonhub']);
	assert.deepEqual((await service.list({}, '.z')).map((entry) => entry.path), ['.zshrc']);
});

test('remote file references support absolute paths without touching the local filesystem', async () => {
	const service = providerFor(cwd, listing);
	assert.deepEqual((await service.list({}, '/etc/ho')).map((entry) => entry.path), ['/etc/hosts']);
});
