import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import {
	CLAIM_ROUTE,
	DEFAULT_PENDING_TTL_MS,
	PENDING_SESSION_VERSION,
	apply,
	claimPendingSession,
	handleClaimRequest,
	isSessionId,
	pendingSessionFile,
	resolveDshHome,
} from '../../runtime/remote-session-deeplink/index.js';
import { RuntimeProfile } from '../../lib/runtime-profile.js';

const SESSION = 'session-c853a673-4d9b-4251-94fb-74ed231f6033';
const repoRoot = resolve(import.meta.dirname, '../..');
const deeplinkDir = join(repoRoot, 'runtime', 'remote-session-deeplink');

/** One browser-shaped claim request. */
function claimRequest(rpcId = 'rpc-1', overrides = {}) {
	return new Request('http://127.0.0.1:1/api/remote-session-deeplink/claim', {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...(overrides.headers ?? {}) },
		body: JSON.stringify({ type: 'client-request', rpcId, method: 'remote-session-deeplink/claim', payload: {} }),
	});
}

/** Write one marker file under an isolated home. */
async function writeMarker(home, body) {
	const file = pendingSessionFile(home);
	await mkdir(join(home, 'storages'), { recursive: true });
	await writeFile(file, typeof body === 'string' ? body : JSON.stringify(body));
	return file;
}

/** Fresh marker body. */
function freshMarker(sessionId = SESSION) {
	return { version: PENDING_SESSION_VERSION, sessionId, createdAt: new Date().toISOString() };
}

test('claim accepts only the Session store id shape', () => {
	assert.equal(isSessionId(SESSION), true);
	assert.equal(isSessionId('session-'), false);
	assert.equal(isSessionId('session-a/../b'), false);
	assert.equal(isSessionId('session-' + 'a'.repeat(122)), false);
	assert.equal(isSessionId(''), false);
	assert.equal(isSessionId(undefined), false);
});

test('resolveDshHome prefers the instance DSH_HOME over the local ~/.dsh', () => {
	assert.equal(resolveDshHome({ DSH_HOME: '/tmp/child-home' }, '/home/me'), '/tmp/child-home');
	assert.equal(resolveDshHome({}, '/home/me'), join('/home/me', '.dsh'));
	assert.equal(resolveDshHome({ DSH_HOME: '' }, '/home/me'), join('/home/me', '.dsh'));
	assert.equal(pendingSessionFile('/tmp/child-home'), join('/tmp/child-home', 'storages', 'pending-session.json'));
});

test('claimPendingSession consumes a fresh marker exactly once', async () => {
	const home = await mkdtemp(join(tmpdir(), 'rssh-deeplink-'));
	const file = await writeMarker(home, freshMarker());
	assert.equal(await claimPendingSession(home), SESSION);
	assert.equal(existsSync(file), false, 'the marker is deleted after the claim');
	assert.equal(await claimPendingSession(home), undefined, 'a second claim is empty');
});

test('claimPendingSession discards stale, malformed and unknown markers', async () => {
	const home = await mkdtemp(join(tmpdir(), 'rssh-deeplink-'));
	await writeMarker(home, { ...freshMarker(), createdAt: new Date(0).toISOString() });
	assert.equal(await claimPendingSession(home, { now: DEFAULT_PENDING_TTL_MS + 1 }), undefined);
	assert.equal(existsSync(pendingSessionFile(home)), false, 'stale marker removed');
	await writeMarker(home, 'not json');
	assert.equal(await claimPendingSession(home), undefined);
	// Unparseable content is discarded as a value; the file itself is left to
	// the next fresh write (same contract as the main plugin's module).
	assert.equal(existsSync(pendingSessionFile(home)), true);
	await writeMarker(home, { ...freshMarker(), version: 99 });
	assert.equal(await claimPendingSession(home), undefined);
	await writeMarker(home, { ...freshMarker(), sessionId: '../../etc/passwd' });
	assert.equal(await claimPendingSession(home), undefined);
	assert.equal(existsSync(pendingSessionFile(home)), false);
});

test('handleClaimRequest answers with the Connection server-response envelope', async () => {
	const home = await mkdtemp(join(tmpdir(), 'rssh-deeplink-'));
	await writeMarker(home, freshMarker());
	const response = await handleClaimRequest(claimRequest('rpc-42'), { dshHome: home });
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('content-type'), 'application/json');
	assert.deepEqual(await response.json(), {
		type: 'server-response',
		rpcId: 'rpc-42',
		result: { ok: true, value: { sessionId: SESSION } },
	});
	const empty = await handleClaimRequest(claimRequest('rpc-43'), { dshHome: home });
	assert.deepEqual(await empty.json(), { type: 'server-response', rpcId: 'rpc-43', result: { ok: true, value: {} } });
});

test('handleClaimRequest rejects malformed requests before reading the marker', async () => {
	const home = await mkdtemp(join(tmpdir(), 'rssh-deeplink-'));
	const wrongType = new Request('http://127.0.0.1:1/api/remote-session-deeplink/claim', {
		method: 'POST',
		headers: { 'content-type': 'text/plain' },
		body: '{}',
	});
	assert.equal((await handleClaimRequest(wrongType, { dshHome: home })).status, 415);
	const wrongMethod = new Request('http://127.0.0.1:1/api/remote-session-deeplink/claim', {
		method: 'GET',
		headers: { 'content-type': 'application/json' },
	});
	assert.equal((await handleClaimRequest(wrongMethod, { dshHome: home })).status, 405);
	const invalidEnvelope = new Request('http://127.0.0.1:1/api/remote-session-deeplink/claim', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ type: 'server-response', rpcId: 'rpc-1' }),
	});
	assert.equal((await handleClaimRequest(invalidEnvelope, { dshHome: home })).status, 400);
	const oversized = new Request('http://127.0.0.1:1/api/remote-session-deeplink/claim', {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'content-length': String(10 * 1024 * 1024) },
		body: '{}',
	});
	assert.equal((await handleClaimRequest(oversized, { dshHome: home })).status, 413);
});

test('apply registers the exact claim route and the handler reads DSH_HOME', async () => {
	const registered = [];
	const ctx = {
		effect: (effect) => effect(),
		connection: {
			fetch: {
				register(route) {
					registered.push(route);
					return () => undefined;
				},
			},
		},
	};
	apply(ctx);
	assert.equal(registered.length, 1);
	const route = registered[0];
	assert.equal(route.path, CLAIM_ROUTE);
	assert.equal(CLAIM_ROUTE, '/api/remote-session-deeplink/claim');
	assert.deepEqual(route.methods, ['POST']);
	assert.equal(route.requestBody, 'buffered');
	const home = await mkdtemp(join(tmpdir(), 'rssh-deeplink-'));
	await writeMarker(home, freshMarker());
	const previous = process.env.DSH_HOME;
	process.env.DSH_HOME = home;
	try {
		const response = await route.fetch(claimRequest('rpc-env'));
		assert.deepEqual((await response.json()).result, { ok: true, value: { sessionId: SESSION } });
	} finally {
		if (previous === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = previous;
	}
});

test('the copied browser half stays a dependency-free ModuleLoader bundle', async () => {
	const client = await readFile(join(deeplinkDir, 'client.js'), 'utf8');
	assert.match(client, /window\.__ModuleLoader__\.load\(\{/);
	assert.match(client, /id: '@junjiangao\/dsh-plugin-remote-ssh-session-deeplink'/);
	assert.match(client, /remote-session-deeplink\/claim/);
	assert.match(client, /uiWorkspace\.openSession\(/);
	assert.match(client, /dsh\.sessions\.current/);
	assert.doesNotMatch(client, /require\(/);
	assert.doesNotMatch(client, /document\.cookie/);
	const checked = spawnSync(process.execPath, ['--check', join(deeplinkDir, 'client.js')], { encoding: 'utf8' });
	assert.equal(checked.status, 0, checked.stderr);
	const manifest = JSON.parse(await readFile(join(deeplinkDir, 'package.json'), 'utf8'));
	assert.equal(manifest.type, 'module');
	assert.equal(manifest.main, 'index.js');
	assert.equal(manifest.exports['./client'], './client.js');
	assert.equal(manifest.dsh.client.platform, 'web');
});

test('RuntimeProfile copies the picker backend and the Session deeplink package', async () => {
	const dshHome = await mkdtemp(join(tmpdir(), 'rssh-profile-'));
	const config = {
		profileName: 'dsh-remote-test',
		sshPackageVersion: '0.2.1-rc.2',
		inheritDesktopSettings: false,
		installTimeoutMs: 1_000,
	};
	const runtime = { version: '0.2.1-rc.2', pnpmPath: '' };
	const profile = new RuntimeProfile(config, runtime, { dshHome, dryRun: true });
	await assert.rejects(profile.ensure(), /dry-run mode/);
	const picker = profile.remoteDirectoryPickerPath();
	assert.equal(picker, join(profile.dir, 'remote-directory-picker.mjs'));
	assert.equal(await readFile(picker, 'utf8'), await readFile(join(repoRoot, 'lib', 'remote-directory-picker.js'), 'utf8'));
	const entry = profile.remoteSessionDeeplinkEntryPath();
	assert.equal(entry, join(profile.dir, 'plugins', 'remote-session-deeplink', 'index.js'));
	assert.equal(profile.remoteSessionDeeplinkDir(), join(profile.dir, 'plugins', 'remote-session-deeplink'));
	for (const file of ['package.json', 'index.js', 'client.js']) {
		assert.equal(
			await readFile(join(profile.remoteSessionDeeplinkDir(), file), 'utf8'),
			await readFile(join(deeplinkDir, file), 'utf8'),
			`${file} copied verbatim`,
		);
	}
	// The preparation marker still proves the directory is plugin-owned.
	assert.equal((await stat(join(profile.dir, '.dsh-remote-ssh-profile.json'))).isFile(), true);
	// A second preparation is idempotent and leaves the copied files in place.
	await assert.rejects(profile.ensure(), /dry-run mode/);
	assert.equal(existsSync(entry), true);
});
