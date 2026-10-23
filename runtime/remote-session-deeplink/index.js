/**
 * One-shot Session deeplink, Host half, for the plugin-owned remote window.
 *
 * The remote window is a separate DSH process with its own `DSH_HOME`; the
 * main window cannot pass a Session id through its URL because the one-shot
 * token exchange redirects to a clean `./`, dropping query parameters. The
 * main plugin therefore drops a short-lived marker in the child's isolated
 * home, and this plugin's own Connection route claims it from the browser half
 * exactly once. This file is copied into `<profile>/plugins/remote-session-deeplink/`
 * and loaded by absolute path, so it must stay dependency-free (node builtins
 * only): the profile does not declare this repo as a package.
 *
 * Marker contract, identical to the main plugin's `lib/pending-session.js`:
 * `<DSH_HOME>/storages/pending-session.json` holding
 * `{ version: 1, sessionId: "session-<...>", createdAt: "<ISO-8601>" }`;
 * a read consumes (best-effort deletes) the file, invalid content is discarded,
 * and a marker older than five minutes is ignored so a crashed open cannot
 * hijack a later window.
 * @module @junjiangao/dsh-plugin-remote-ssh-session-deeplink
 */
import { readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

/** Stable Loader identity (the row loads this file by absolute path). */
export const name = 'remote-session-deeplink';
/** The Connection service owns the browser-fetch route registry. */
export const inject = ['connection'];

/** Absolute Connection path the browser half posts to. */
export const CLAIM_ROUTE = '/api/remote-session-deeplink/claim';
/** Accepted Session id shape (the Session store's `session-<uuid>` form). */
const SESSION_ID_RE = /^session-[A-Za-z0-9][A-Za-z0-9-]{0,120}$/;
/** Marker format version; a mismatch is discarded instead of parsed. */
export const PENDING_SESSION_VERSION = 1;
/** Default marker lifetime: long enough for SSH startup, short enough to be stale-proof. */
export const DEFAULT_PENDING_TTL_MS = 5 * 60 * 1000;
/** Largest accepted request body, in bytes. */
const MAX_BODY_BYTES = 64 * 1024;
/** Longest accepted `rpcId` (matches the main plugin's RPC bridge). */
const MAX_RPC_ID_LENGTH = 256;

/** Absolute path of the marker inside one isolated DSH home. */
export function pendingSessionFile(dshHome) {
	return join(dshHome, 'storages', 'pending-session.json');
}

/** The child's isolated DSH home: `DSH_HOME` when the instance set it. */
export function resolveDshHome(env = process.env, home = homedir()) {
	const configured = env?.DSH_HOME;
	if (typeof configured === 'string' && configured !== '') return configured;
	return join(home, '.dsh');
}

/** Validate one Session id coming from the marker. */
export function isSessionId(value) {
	return typeof value === 'string' && SESSION_ID_RE.test(value);
}

/**
 * Read and delete a fresh marker.
 * @param dshHome - the child's isolated DSH home.
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

/** Validate the browser envelope before dispatch. */
function parseClientRequest(value) {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
	if (value.type !== 'client-request' || typeof value.rpcId !== 'string') return undefined;
	if (value.rpcId.length === 0 || value.rpcId.length > MAX_RPC_ID_LENGTH) return undefined;
	return { rpcId: value.rpcId };
}

/** Frame one successful result as the Connection server-response envelope. */
function serverResponse(rpcId, value) {
	return new Response(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value } }), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	});
}

/**
 * Serve one claim request.
 * @param request - the buffered browser request.
 * @param options - `{ dshHome?, now?, maxAgeMs? }` (tests override the home).
 * @returns the Connection response; the value is `{ sessionId }` or `{}`.
 */
export async function handleClaimRequest(request, options = {}) {
	if (request.method !== 'POST') return new Response(null, { status: 405 });
	if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
		return new Response(null, { status: 415 });
	}
	const declaredLength = request.headers.get('content-length');
	if (declaredLength !== null && Number(declaredLength) > MAX_BODY_BYTES) return new Response(null, { status: 413 });
	let text;
	try {
		text = await request.text();
	} catch {
		return new Response(null, { status: 400 });
	}
	if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return new Response(null, { status: 413 });
	let envelope;
	try {
		envelope = JSON.parse(text);
	} catch {
		return new Response(null, { status: 400 });
	}
	const parsed = parseClientRequest(envelope);
	if (parsed === undefined) return new Response(null, { status: 400 });
	const dshHome = options.dshHome ?? resolveDshHome();
	let value = {};
	try {
		const sessionId = await claimPendingSession(dshHome, options);
		if (sessionId !== undefined) value = { sessionId };
	} catch {
		// A claim must never break the remote window: absent/unreadable state is
		// simply "nothing to reveal".
		value = {};
	}
	return serverResponse(parsed.rpcId, value);
}

/**
 * Register the claim route on the Connection fetch surface.
 * @param ctx - Host context with `connection`.
 */
export function apply(ctx) {
	ctx.effect(
		() => ctx.connection.fetch.register({
			path: CLAIM_ROUTE,
			methods: ['POST'],
			requestBody: 'buffered',
			fetch: (request) => handleClaimRequest(request),
		}),
		'remote-session-deeplink: claim route',
	);
}
