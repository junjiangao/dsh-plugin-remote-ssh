import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeHomeKey } from '../../lib/remote-home.js';
import { scanRemoteWorkspaces } from '../../lib/remote-workspaces.js';

/** Build one workspace registry document. */
function registry({ workspaceIds, workspaces, archivedSessionIds = [], pinnedSessionIds = [] }) {
	return {
		unit: { name: 'workspace', version: 2 },
		global: { initialized: true, workspaceIds, archivedSessionIds, pinnedSessionIds },
		tables: { workspaces },
	};
}

/** Build one workspace record. */
function workspaceRecord(path, sessionIds = [], title = undefined) {
	return {
		path,
		title: title ?? path.split('/').filter(Boolean).pop() ?? path,
		sessionIds,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-02T00:00:00.000Z',
	};
}

/** Build one session projection cache document. */
function sessionCache(input = {}) {
	const {
		title = null,
		cwd = '/home/test',
		createdAt = 1_700_000_000_000,
		lastPromptAt = null,
		blank = false,
		titleInput,
		workingDirectory,
	} = input;
	const rows = {
		title: { ver: 1, seq: 2, val: title },
		timeContext: { ver: 2, seq: 2, val: { lastMessageTime: null } },
		sessionListMetadata: { ver: 1, seq: 2, val: { blank, lastPromptAt } },
	};
	if (titleInput !== undefined) rows.titleInput = { ver: 3, seq: 2, val: { first: { seq: 1, text: titleInput }, count: 1, lastSeq: 1 } };
	if (workingDirectory !== undefined) rows.workingDirectory = { ver: 1, seq: 2, val: workingDirectory };
	return {
		version: 7,
		record: {
			identity: { formatVersion: 4, createdAt, cwd, isSeeded: false, inheritedEventCount: 0 },
			rows,
		},
	};
}

/** Build one host record as the controller passes it. */
function host(id, alias = id, extra = {}) {
	return { id, alias, displayName: `${alias} display`, remoteWorkspace: '~', ...extra };
}

/** Write one isolated host home (registry and/or session cache). */
async function writeHome(dataDir, hostId, input = {}) {
	const home = join(dataDir, 'homes', safeHomeKey(hostId));
	const cacheDir = join(home, 'storages', 'session_projcache', 'sessions');
	await mkdir(cacheDir, { recursive: true });
	if (input.registry !== undefined) {
		await mkdir(join(home, 'storages'), { recursive: true });
		const body = typeof input.registry === 'string' ? input.registry : `${JSON.stringify(input.registry, null, 2)}\n`;
		await writeFile(join(home, 'storages', 'workspace.json'), body);
	}
	for (const [id, content] of Object.entries(input.sessions ?? {})) {
		const body = typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`;
		await writeFile(join(cacheDir, `${id}.json`), body);
	}
	return { home, cacheDir };
}

/** Create one temporary data directory and clean it up after the test. */
async function withDataDir(fn) {
	const dataDir = await mkdtemp(join(tmpdir(), 'rssh-workspaces-'));
	try {
		return await fn(dataDir);
	} finally {
		await rm(dataDir, { recursive: true, force: true });
	}
}

test('scan joins registry and session cache, orders workspaces and sessions, and flags metadata', async () => {
	await withDataDir(async (dataDir) => {
		const registryDoc = registry({
			workspaceIds: ['ws-alpha', 'ws-beta'],
			workspaces: {
				'ws-alpha': workspaceRecord('/home/me/alpha', ['s-alpha']),
				'ws-beta': workspaceRecord('/home/me/beta', ['s-beta', 's-archived']),
			},
			pinnedSessionIds: ['s-blank'],
			archivedSessionIds: ['s-archived'],
		});
		await writeHome(dataDir, 'host_one', {
			registry: registryDoc,
			sessions: {
				's-alpha': sessionCache({ title: 'Fix the parser', cwd: '/home/me/alpha', lastPromptAt: 1_700_000_300_000 }),
				's-beta': sessionCache({ title: 'Beta refactor', cwd: '/home/me/beta', lastPromptAt: 1_700_000_200_000 }),
				// Not listed in the registry: it must be attributed by cwd containment.
				's-by-cwd': sessionCache({ titleInput: 'cwd attributed', cwd: '/home/me/alpha/src', lastPromptAt: 1_700_000_100_000 }),
				's-blank': sessionCache({ cwd: '/home/me/beta', blank: true, lastPromptAt: 1_700_000_400_000 }),
				's-archived': sessionCache({ title: 'Old work', cwd: '/home/me/beta', lastPromptAt: 1_699_000_000_000 }),
			},
		});

		const result = await scanRemoteWorkspaces({
			dataDir,
			hosts: [host('host_one', 'alpha-machine')],
			instanceOf: () => ({ phase: 'running', running: true }),
		});

		assert.equal(result.hosts.length, 1);
		const entry = result.hosts[0];
		assert.equal(entry.id, 'host_one');
		assert.equal(entry.alias, 'alpha-machine');
		assert.equal(entry.displayName, 'alpha-machine display');
		assert.equal(entry.phase, 'running');
		assert.equal(entry.running, true);
		assert.equal(entry.remoteWorkspace, '~');
		assert.match(result.generatedAt, /^\d{4}-\d{2}-\d{2}T/);

		assert.deepEqual(entry.workspaces.map((workspace) => workspace.path), ['/home/me/alpha', '/home/me/beta']);
		const [alpha, beta] = entry.workspaces;
		// Alpha: explicit id first, then the cwd-attributed session; newest activity first.
		assert.deepEqual(alpha.sessions.map((session) => session.id), ['s-alpha', 's-by-cwd']);
		assert.equal(alpha.sessions[1].title, 'cwd attributed');
		// Beta: explicit ids keep registry order only for ties; activity order wins.
		assert.deepEqual(beta.sessions.map((session) => session.id), ['s-blank', 's-beta', 's-archived']);
		assert.equal(beta.sessions[0].blank, true);
		assert.equal(beta.sessions[0].pinned, true);
		assert.equal(beta.sessions[0].lastActiveAt, new Date(1_700_000_400_000).toISOString());
		assert.equal(beta.sessions[2].archived, true);
		assert.equal(beta.sessions[1].archived, false);
		assert.deepEqual(result.warnings, []);
	});
});

test('cwd containment picks the most specific workspace', async () => {
	await withDataDir(async (dataDir) => {
		await writeHome(dataDir, 'host_nested', {
			registry: registry({
				workspaceIds: ['ws-root', 'ws-project'],
				workspaces: {
					'ws-root': workspaceRecord('/home/me'),
					'ws-project': workspaceRecord('/home/me/project'),
				},
			}),
			sessions: {
				's-deep': sessionCache({ cwd: '/home/me/project/src/app', lastPromptAt: 1_700_000_000_000 }),
			},
		});
		const result = await scanRemoteWorkspaces({ dataDir, hosts: [host('host_nested')], instanceOf: () => ({ phase: 'idle', running: false }) });
		const workspaces = result.hosts[0].workspaces;
		assert.deepEqual(workspaces.map((workspace) => workspace.path), ['/home/me', '/home/me/project']);
		assert.deepEqual(workspaces[0].sessions, []);
		assert.deepEqual(workspaces[1].sessions.map((session) => session.id), ['s-deep']);
	});
});

test('unmatched sessions fall back to a derived cwd workspace, including an unknown cwd', async () => {
	await withDataDir(async (dataDir) => {
		await writeHome(dataDir, 'host_derived', {
			registry: registry({ workspaceIds: ['ws-known'], workspaces: { 'ws-known': workspaceRecord('/home/me/known') } }),
			sessions: {
				's-elsewhere': sessionCache({ title: 'Elsewhere', cwd: '/opt/app', lastPromptAt: 1_700_000_200_000 }),
				's-no-cwd': sessionCache({ title: 'No cwd', cwd: '', lastPromptAt: 1_700_000_100_000 }),
			},
		});
		const result = await scanRemoteWorkspaces({ dataDir, hosts: [host('host_derived')], instanceOf: () => ({}) });
		const workspaces = result.hosts[0].workspaces;
		assert.deepEqual(workspaces.map((workspace) => workspace.path), ['/home/me/known', '/opt/app', '']);
		assert.equal(workspaces[1].title, 'app');
		assert.deepEqual(workspaces[1].sessions.map((session) => session.id), ['s-elsewhere']);
		assert.deepEqual(workspaces[2].sessions.map((session) => session.id), ['s-no-cwd']);
	});
});

test('registry workspaces missing from workspaceIds are appended, and uncached ids stay openable', async () => {
	await withDataDir(async (dataDir) => {
		await writeHome(dataDir, 'host_extra', {
			registry: registry({
				workspaceIds: ['ws-first'],
				workspaces: {
					'ws-first': workspaceRecord('/home/me/first', ['s-cached', 's-uncached']),
					'ws-extra': workspaceRecord('/home/me/extra'),
				},
			}),
			sessions: { 's-cached': sessionCache({ title: 'Cached', cwd: '/home/me/first', lastPromptAt: 1_700_000_000_000 }) },
		});
		const result = await scanRemoteWorkspaces({ dataDir, hosts: [host('host_extra')], instanceOf: () => ({}) });
		const workspaces = result.hosts[0].workspaces;
		assert.deepEqual(workspaces.map((workspace) => workspace.path), ['/home/me/first', '/home/me/extra']);
		const sessions = workspaces[0].sessions;
		assert.deepEqual(sessions.map((session) => session.id), ['s-cached', 's-uncached']);
		assert.equal(sessions[1].title, '');
		assert.equal(sessions[1].blank, false);
	});
});

test('corrupt registry and session files become warnings while valid data survives', async () => {
	await withDataDir(async (dataDir) => {
		await writeHome(dataDir, 'host_broken', {
			registry: '{ this is not json',
			sessions: {
				's-good': sessionCache({ title: 'Good', cwd: '/srv/ok', lastPromptAt: 1_700_000_000_000 }),
				's-bad': '{ also broken',
			},
		});
		const result = await scanRemoteWorkspaces({ dataDir, hosts: [host('host_broken', 'broken')], instanceOf: () => ({}) });
		assert.equal(result.hosts.length, 1);
		assert.equal(result.hosts[0].workspaces.length, 1);
		assert.deepEqual(result.hosts[0].workspaces[0].sessions.map((session) => session.id), ['s-good']);
		assert.equal(result.hosts[0].workspaces[0].path, '/srv/ok');
		assert.equal(result.warnings.length, 2);
		assert(result.warnings.some((warning) => warning.includes('workspace registry')), 'registry warning');
		assert(result.warnings.some((warning) => warning.includes('s-bad')), 'session warning');
	});
});

test('a missing home directory and an unreadable home are both tolerated', async () => {
	await withDataDir(async (dataDir) => {
		// No home at all: normal before the first open.
		const absent = await scanRemoteWorkspaces({ dataDir, hosts: [host('host_never_opened')], instanceOf: () => ({}) });
		assert.deepEqual(absent.hosts[0].workspaces, []);
		assert.deepEqual(absent.warnings, []);

		// A regular file where a directory is expected: both readers warn but the
		// host entry is still returned for the other hosts.
		const home = join(dataDir, 'homes', safeHomeKey('host_not_a_dir'));
		await mkdir(join(dataDir, 'homes'), { recursive: true });
		await writeFile(home, 'not a directory');
		const result = await scanRemoteWorkspaces({
			dataDir,
			hosts: [host('host_not_a_dir'), host('host_never_opened')],
			instanceOf: () => ({ phase: 'idle', running: false }),
		});
		assert.equal(result.hosts.length, 2);
		assert.deepEqual(result.hosts[0].workspaces, []);
		assert.deepEqual(result.hosts[1].workspaces, []);
		assert.equal(result.warnings.length, 2);
		assert.equal(result.hosts[1].phase, 'idle');
	});
});

test('instanceOf state is passed through and a throwing instanceOf degrades to idle', async () => {
	await withDataDir(async (dataDir) => {
		await writeHome(dataDir, 'host_a');
		await writeHome(dataDir, 'host_b');
		const result = await scanRemoteWorkspaces({
			dataDir,
			hosts: [host('host_a'), host('host_b')],
			instanceOf: (hostId) => {
				if (hostId === 'host_b') throw new Error('instance manager is gone');
				return { phase: 'running', running: true, message: 'ignored' };
			},
		});
		assert.equal(result.hosts[0].phase, 'running');
		assert.equal(result.hosts[0].running, true);
		assert.equal(result.hosts[1].phase, 'idle');
		assert.equal(result.hosts[1].running, false);
	});
});

test('input validation keeps the scan total and preserves host order', async () => {
	await withDataDir(async (dataDir) => {
		await writeHome(dataDir, 'host_1');
		const result = await scanRemoteWorkspaces({
			dataDir,
			hosts: [host('host_2'), null, { alias: 'no-id' }, host('host_1'), host('host_2'), 'nope'],
			instanceOf: () => ({ phase: 'idle', running: false }),
		});
		assert.deepEqual(result.hosts.map((entry) => entry.id), ['host_2', 'host_1']);
		assert(result.warnings.some((warning) => warning.includes('without an id')), 'missing id warning');
	});
});

test('a scan without a data directory returns an empty, warned inventory instead of throwing', async () => {
	const result = await scanRemoteWorkspaces({ hosts: [host('host_x')], instanceOf: () => ({}) });
	assert.deepEqual(result.hosts, []);
	assert.equal(result.warnings.length, 1);
});
