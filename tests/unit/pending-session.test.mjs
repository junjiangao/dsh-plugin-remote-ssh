import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	DEFAULT_PENDING_TTL_MS,
	PENDING_SESSION_VERSION,
	claimPendingSession,
	clearPendingSession,
	isSessionId,
	pendingSessionFile,
	writePendingSession,
} from '../../lib/pending-session.js';

const SESSION = 'session-c853a673-4d9b-4251-94fb-74ed231f6033';

test('isSessionId accepts the Session store form only', () => {
	assert.equal(isSessionId(SESSION), true);
	assert.equal(isSessionId('session-'), false);
	assert.equal(isSessionId('session-a/../b'), false);
	assert.equal(isSessionId(''), false);
	assert.equal(isSessionId(undefined), false);
});

test('writePendingSession writes an atomic private marker and claim consumes it once', async () => {
	const home = await mkdtemp(join(tmpdir(), 'rssh-pending-'));
	await writePendingSession(home, SESSION);
	const raw = JSON.parse(await readFile(pendingSessionFile(home), 'utf8'));
	assert.deepEqual(Object.keys(raw).sort(), ['createdAt', 'sessionId', 'version']);
	assert.equal(raw.version, PENDING_SESSION_VERSION);
	assert.equal(raw.sessionId, SESSION);
	assert.equal(await claimPendingSession(home), SESSION);
	assert.equal(await claimPendingSession(home), undefined, 'second claim is empty');
});

test('claimPendingSession discards stale, malformed and unknown markers', async () => {
	const home = await mkdtemp(join(tmpdir(), 'rssh-pending-'));
	const file = pendingSessionFile(home);
	await mkdir(join(home, 'storages'), { recursive: true });
	await writeFile(file, JSON.stringify({ version: PENDING_SESSION_VERSION, sessionId: SESSION, createdAt: new Date(0).toISOString() }));
	assert.equal(await claimPendingSession(home, { now: DEFAULT_PENDING_TTL_MS + 1 }), undefined);
	await writeFile(file, JSON.stringify({ version: PENDING_SESSION_VERSION, sessionId: SESSION, createdAt: new Date().toISOString() }));
	assert.equal(await claimPendingSession(home), SESSION);
	await writeFile(file, 'not json');
	assert.equal(await claimPendingSession(home), undefined);
	await writeFile(file, JSON.stringify({ version: 99, sessionId: SESSION, createdAt: new Date().toISOString() }));
	assert.equal(await claimPendingSession(home), undefined);
});

test('writePendingSession rejects unsafe ids and clearPendingSession removes the marker', async () => {
	const home = await mkdtemp(join(tmpdir(), 'rssh-pending-'));
	await assert.rejects(writePendingSession(home, '../../../etc/passwd'), /invalid Session id/);
	await assert.rejects(writePendingSession(home, 'session-'), /invalid Session id/);
	await writePendingSession(home, SESSION);
	await clearPendingSession(home);
	assert.equal(await claimPendingSession(home), undefined);
});
