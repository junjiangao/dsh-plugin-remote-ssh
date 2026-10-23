/**
 * Pending remote-session marker shared with the remote window.
 *
 * The main window cannot pass a Session id through the remote window URL: the
 * one-shot token exchange redirects to a clean `./`, dropping query
 * parameters. Instead the Host drops a short-lived marker in the child's
 * isolated DSH home, and the copied `remote-session-deeplink` client plugin
 * claims it through its own Connection route before selecting the Session.
 *
 * The marker carries no credentials and is ignored after a short TTL, so a
 * crashed or failed open cannot hijack the next window.
 * @module @junjiangao/dsh-plugin-remote-ssh/pending-session
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import process from 'node:process';

/** Accepted Session id shape (the Session store's `session-<uuid>` form). */
const SESSION_ID_RE = /^session-[A-Za-z0-9][A-Za-z0-9-]{0,120}$/;
/** Marker format version; a mismatch is discarded instead of parsed. */
export const PENDING_SESSION_VERSION = 1;
/** Default lifetime: long enough for SSH startup, short enough to be stale-proof. */
export const DEFAULT_PENDING_TTL_MS = 5 * 60 * 1000;

/** Absolute path of the marker inside one isolated DSH home. */
export function pendingSessionFile(dshHome) {
	return join(dshHome, 'storages', 'pending-session.json');
}

/** Validate one Session id coming from the browser. */
export function isSessionId(value) {
	return typeof value === 'string' && SESSION_ID_RE.test(value);
}

/**
 * Write the marker atomically for the next remote window of one host.
 * @param dshHome - the host's isolated DSH home (child `DSH_HOME`).
 * @param sessionId - Session to reveal after the remote window finishes booting.
 */
export async function writePendingSession(dshHome, sessionId) {
	if (!isSessionId(sessionId)) throw new Error(`invalid Session id: ${String(sessionId)}`);
	const file = pendingSessionFile(dshHome);
	await mkdir(dirname(file), { recursive: true, mode: 0o700 });
	const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
	const body = {
		version: PENDING_SESSION_VERSION,
		sessionId,
		createdAt: new Date().toISOString(),
	};
	await writeFile(temporary, `${JSON.stringify(body, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
	await rename(temporary, file);
}

/**
 * Read and delete a fresh marker.
 * @param dshHome - the host's isolated DSH home.
 * @param options - `{ now?, maxAgeMs? }` for deterministic tests.
 * @returns the Session id, or `undefined` when absent, malformed or stale.
 */
export async function claimPendingSession(dshHome, options = {}) {
	const file = pendingSessionFile(dshHome);
	let raw;
	try {
		raw = JSON.parse(await readFile(file, 'utf8'));
	} catch {
		return undefined;
	}
	await rm(file, { force: true }).catch(() => undefined);
	if (raw === null || typeof raw !== 'object' || raw.version !== PENDING_SESSION_VERSION) return undefined;
	if (!isSessionId(raw.sessionId)) return undefined;
	const createdAt = Date.parse(raw.createdAt);
	const now = options.now ?? Date.now();
	const maxAge = options.maxAgeMs ?? DEFAULT_PENDING_TTL_MS;
	if (!Number.isFinite(createdAt) || now - createdAt > maxAge) return undefined;
	return raw.sessionId;
}

/** Remove a marker without claiming it (used when an open flow fails). */
export async function clearPendingSession(dshHome) {
	await rm(pendingSessionFile(dshHome), { force: true }).catch(() => undefined);
}
