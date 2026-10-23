import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	MAX_ENTRIES,
	ancestryCrumbs,
	apply,
	isRemoteAbsolutePath,
	mirrorLocalDirectory,
	normalizeConfig,
} from '../../lib/remote-directory-picker.js';

/**
 * Build one remote-plugin context: a recording fake of the SSH fs/subprocess
 * providers, plus the `ctx.provide` capture the plugin registers on.
 * @param options - fake listings, stats, executable table and command outcomes.
 */
function createContext(options = {}) {
	const provided = new Map();
	const spawns = [];
	const listings = options.listings ?? {};
	const stats = options.stats ?? {};
	const executables = options.executables ?? {};
	const ctx = {
		provide(name, value) {
			provided.set(name, value);
			return () => provided.delete(name);
		},
		fs: {
			async resolve(path, opts) {
				if (opts?.signal?.aborted) throw new Error('aborted');
				if (typeof path !== 'string' || !path.startsWith('/')) throw new Error(`cannot resolve ${String(path)}`);
				return { targetKey: path, displayPath: path };
			},
			processPath(target) {
				return target.targetKey;
			},
			async listDir(target) {
				const entries = listings[target.targetKey];
				if (entries === undefined) throw new Error(`cannot list ${target.targetKey}: not found`);
				return entries;
			},
			async stat(target) {
				return stats[target.targetKey];
			},
		},
		subprocess: {
			async resolveExecutable(command) {
				return executables[command] ?? `/usr/bin/${command}`;
			},
			spawn(spec) {
				spawns.push(spec);
				let exitCode = 0;
				let stdout = '';
				let stderr = '';
				if (spec.argv[1] === '-c') {
					exitCode = options.homeExitCode ?? 0;
					stdout = options.homeOutput ?? '/home/remote\n';
					stderr = options.homeStderr ?? '';
				} else if (spec.argv[0].endsWith('mkdir')) {
					exitCode = options.mkdirExitCode ?? 0;
					stderr = options.mkdirStderr ?? '';
				}
				return {
					done: Promise.resolve({ exitCode, signal: null }),
					collected: {
						stdout: { readFrom: () => ({ text: stdout, nextOffset: stdout.length, lossy: false }) },
						stderr: { readFrom: () => ({ text: stderr, nextOffset: stderr.length, lossy: false }) },
					},
					terminate() {},
				};
			},
		},
	};
	apply(ctx, options.config);
	const service = provided.get('directoryPicker');
	assert.ok(service, 'the plugin must provide ctx.directoryPicker');
	return { capability: service.capability(), spawns, provided };
}

/** One remote directory row. */
function directory(name, parent) {
	return { name, type: 'directory', target: { targetKey: `${parent}/${name}`, displayPath: `${parent}/${name}` } };
}

test('exposes the browse capability shape the Workspace controller consumes', () => {
	const { capability } = createContext({});
	assert.equal(capability.kind, 'browse');
	assert.equal(typeof capability.list, 'function');
	assert.equal(typeof capability.createDirectory, 'function');
	// The capability object must be stable across calls (seam contract).
	const { provided } = createContext({});
	assert.equal(provided.get('directoryPicker').capability(), provided.get('directoryPicker').capability());
});

test('list without a path resolves the remote home once and returns the seam listing', async () => {
	const listing = [
		directory('work', '/home/remote'),
		{ name: 'notes.txt', type: 'file', target: { targetKey: '/home/remote/notes.txt', displayPath: '/home/remote/notes.txt' } },
		{ name: 'fifo', type: 'other', target: { targetKey: '/home/remote/fifo', displayPath: '/home/remote/fifo' } },
		directory('.config', '/home/remote'),
	];
	const { capability, spawns } = createContext({ listings: { '/home/remote': listing } });
	const first = await capability.list();
	assert.equal(first.path, '/home/remote');
	assert.equal(first.home, '/home/remote');
	assert.deepEqual(first.entries.map((entry) => entry.name), ['.config', 'work']);
	assert.deepEqual(first.entries[0], { name: '.config', path: '/home/remote/.config', hidden: true });
	assert.deepEqual(first.crumbs.map((crumb) => crumb.path), ['/', '/home', '/home/remote']);
	assert.equal(first.crumbs[0].name, '/');
	assert.equal(first.truncated, false);
	// Home is cached: a second listing must not probe the remote shell again.
	await capability.list('/home/remote');
	assert.equal(spawns.filter((spec) => spec.argv[1] === '-c').length, 1);
	// The home probe uses the remote subprocess world, never os.homedir().
	assert.deepEqual(spawns[0].argv, ['/usr/bin/sh', '-c', 'printf %s "$HOME"']);
	assert.equal(spawns[0].cwd, '/');
});

test('list uses the remote workspace as the probe cwd and rejects relative paths', async () => {
	const { capability, spawns } = createContext({
		config: { workspace: '/srv/app' },
		listings: { '/home/remote': [] },
	});
	await capability.list();
	assert.equal(spawns[0].cwd, '/srv/app');
	await assert.rejects(capability.list('srv/app'), (error) => error.code === 'directory-unreadable');
	await assert.rejects(capability.list('~/app'), (error) => error.code === 'directory-unreadable');
});

test('list surfaces a missing remote directory with the browse failure code', async () => {
	const { capability } = createContext({ listings: {} });
	await assert.rejects(capability.list('/missing'), (error) => {
		assert.equal(error.name, 'DirectoryPickerError');
		assert.equal(error.code, 'directory-unreadable');
		assert.equal(error.path, '/missing');
		return true;
	});
});

test('list refuses to pretend a local home is the remote home', async () => {
	const { capability } = createContext({ homeExitCode: 1, homeStderr: 'ssh: command not found\n' });
	await assert.rejects(capability.list(), (error) => {
		assert.equal(error.code, 'directory-unreadable');
		assert.match(error.message, /cannot determine the remote home directory/);
		return true;
	});
	const relative = createContext({ homeOutput: 'home/remote\n' });
	await assert.rejects(relative.capability.list(), (error) => error.code === 'directory-unreadable');
});

test('list bounds the rows it materializes and reports truncation', async () => {
	const entries = [];
	for (let index = 0; index <= MAX_ENTRIES; index += 1) entries.push(directory(`dir-${String(index).padStart(4, '0')}`, '/big'));
	const { capability } = createContext({ listings: { '/big': entries } });
	const listing = await capability.list('/big');
	assert.equal(listing.truncated, true);
	assert.equal(listing.entries.length, MAX_ENTRIES);
	assert.equal(listing.entries[0].name, 'dir-0000');
});

test('mirrorWorkspace creates the same local path only when enabled', async () => {
	const root = await mkdtemp(join(tmpdir(), 'rssh-picker-mirror-'));
	const remotePath = join(root, 'project');
	const enabled = createContext({ config: { mirrorWorkspace: true }, listings: { [remotePath]: [] } });
	await enabled.capability.list(remotePath);
	assert.equal((await stat(remotePath)).isDirectory(), true);
	const disabled = createContext({ config: { mirrorWorkspace: false }, listings: { [remotePath]: [] } });
	await disabled.capability.list(remotePath);
	assert.equal((await stat(remotePath)).isDirectory(), true, 'already mirrored by the enabled call');
	const fresh = join(root, 'other');
	const disabledFresh = createContext({ config: { mirrorWorkspace: false }, listings: { [fresh]: [] } });
	await disabledFresh.capability.list(fresh);
	await assert.rejects(stat(fresh));
});

test('mirror failures stay silent so browsing still works', async () => {
	const root = await mkdtemp(join(tmpdir(), 'rssh-picker-mirror-'));
	const blocker = join(root, 'file');
	await writeFile(blocker, 'not a directory');
	const remotePath = join(blocker, 'child');
	const { capability } = createContext({ config: { mirrorWorkspace: true }, listings: { [remotePath]: [] } });
	const listing = await capability.list(remotePath);
	assert.equal(listing.path, remotePath);
	assert.equal(await mirrorLocalDirectory(remotePath, normalizeConfig({ mirrorWorkspace: false })), undefined);
});

test('createDirectory validates the parent path and the child name', async () => {
	const { capability, spawns } = createContext({ listings: {} });
	for (const name of ['', '   ', '.', '..', 'a/b', 'a\\b']) {
		await assert.rejects(capability.createDirectory('/srv/app', name), (error) => error.code === 'directory-create-failed');
	}
	await assert.rejects(capability.createDirectory('srv/app', 'new'), (error) => error.code === 'directory-create-failed');
	assert.deepEqual(spawns, [], 'invalid input must not reach the remote host');
});

test('createDirectory runs remote mkdir -p and reports the created absolute path', async () => {
	const root = await mkdtemp(join(tmpdir(), 'rssh-picker-create-'));
	const parent = join(root, 'app');
	const { capability, spawns } = createContext({ config: { mirrorWorkspace: true }, listings: {} });
	const created = await capability.createDirectory(parent, 'new folder');
	assert.equal(created, `${parent}/new folder`);
	const mkdir = spawns.find((spec) => spec.argv[0].endsWith('mkdir'));
	assert.deepEqual(mkdir.argv, ['/usr/bin/mkdir', '-p', '--', created]);
	assert.equal(mkdir.cwd, '/');
	assert.equal((await stat(created)).isDirectory(), true);
});

test('createDirectory rejects an existing directory before touching the remote host', async () => {
	const { capability, spawns } = createContext({
		stats: { '/srv/app/exists': { version: 'v1', type: 'directory' } },
	});
	await assert.rejects(capability.createDirectory('/srv/app', 'exists'), (error) => {
		assert.equal(error.code, 'directory-exists');
		assert.equal(error.path, '/srv/app/exists');
		return true;
	});
	assert.deepEqual(spawns, []);
	const file = createContext({ stats: { '/srv/app/file': { version: 'v1', type: 'file' } } });
	await assert.rejects(file.capability.createDirectory('/srv/app', 'file'), (error) => error.code === 'directory-create-failed');
});

test('createDirectory surfaces remote mkdir failures with its stderr', async () => {
	const { capability } = createContext({ mkdirExitCode: 1, mkdirStderr: 'mkdir: permission denied\n' });
	await assert.rejects(capability.createDirectory('/srv/app', 'new'), (error) => {
		assert.equal(error.code, 'directory-create-failed');
		assert.match(error.message, /permission denied/);
		return true;
	});
});

test('pure helpers describe the remote path rules', () => {
	assert.equal(isRemoteAbsolutePath('/srv/app'), true);
	assert.equal(isRemoteAbsolutePath('srv/app'), false);
	assert.equal(isRemoteAbsolutePath(undefined), false);
	assert.deepEqual(ancestryCrumbs('/'), [{ name: '/', path: '/', hidden: false }]);
	assert.deepEqual(ancestryCrumbs('/srv/app').map((crumb) => crumb.name), ['/', 'srv', 'app']);
	assert.deepEqual(normalizeConfig(undefined), { mirrorWorkspace: false, workspace: '/' });
	assert.deepEqual(normalizeConfig({ mirrorWorkspace: true, workspace: '/srv/app' }), { mirrorWorkspace: true, workspace: '/srv/app' });
	assert.deepEqual(normalizeConfig({ mirrorWorkspace: 'true', workspace: 'relative' }), { mirrorWorkspace: false, workspace: '/' });
});
