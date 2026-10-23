/**
 * Read-only inventory of remote workspaces and their sessions for the main UI.
 *
 * Every managed host owns an isolated DSH home under
 * `<dataDir>/homes/<safeHomeKey(host.id)>` (see `remote-home.js`). The remote
 * window keeps its own workspace registry (`storages/workspace.json`) and a
 * session projection cache (`storages/session_projcache/sessions/*.json`).
 * This module joins the two so the desktop panel can list remote machines,
 * workspaces and sessions without contacting the remote host.
 *
 * Ownership rules, in order:
 * 1. a session id listed in `workspace.sessionIds` belongs to that workspace;
 * 2. otherwise a session belongs to the workspace with the longest `path` that
 *    equals, or is a POSIX parent directory of, the session's recorded `cwd`;
 * 3. remaining sessions are grouped into a derived workspace whose `path` is
 *    the session `cwd` (an empty path when the cache has no cwd), so a user can
 *    still see and reopen them.
 *
 * `lastActiveAt` is the last prompt time, falling back to the creation time for
 * a blank session, so the list still has a stable order. Everything is strictly
 * read-only and never throws: one broken file only adds a warning, and every
 * other host/workspace/session is still returned.
 * @module @junjiangao/dsh-plugin-remote-ssh/remote-workspaces
 */
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { safeHomeKey } from './remote-home.js';

/** Workspace registry, relative to one isolated host home. */
const WORKSPACE_FILE = ['storages', 'workspace.json'];
/** Session projection cache, relative to one isolated host home. */
const SESSION_CACHE_DIR = ['storages', 'session_projcache', 'sessions'];
/** Maximum length of a rendered title kept in the payload. */
const MAX_TITLE_LENGTH = 400;
/** Maximum length of a path kept in the payload. */
const MAX_PATH_LENGTH = 4096;
/** Longest accepted session id (a file name without the `.json` suffix). */
const MAX_SESSION_ID_LENGTH = 256;

/** Whether a value is a plain object. */
function isRecord(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Read a string field, trimmed to the payload limit. */
function text(value, limit = MAX_TITLE_LENGTH) {
	return typeof value === 'string' ? value.slice(0, limit) : '';
}

/** Read one stored timestamp as an ISO string; accepts epoch millis or ISO text. */
function isoTime(value) {
	if (typeof value === 'number' && Number.isFinite(value)) {
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
	}
	if (typeof value === 'string' && value.length > 0) {
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
	}
	return undefined;
}

/** Read the `val` of one projection row, or `undefined`. */
function rowValue(rows, name) {
	if (!isRecord(rows)) return undefined;
	const row = rows[name];
	return isRecord(row) ? row.val : undefined;
}

/** Normalize a remote path for display and prefix matching. */
function normalizePath(value) {
	let path = text(value, MAX_PATH_LENGTH);
	if (path === '') return '';
	while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
	return path;
}

/** The readable title of one workspace record. */
function workspaceTitle(record) {
	const title = text(record?.title);
	if (title.length > 0) return title;
	const path = normalizePath(record?.path);
	return path === '' ? '' : basename(path) || path;
}

/** A session id accepted from a cache file name. */
function sessionIdFromFile(name) {
	if (typeof name !== 'string' || !name.endsWith('.json')) return undefined;
	const id = name.slice(0, -'.json'.length);
	if (id.length === 0 || id.length > MAX_SESSION_ID_LENGTH) return undefined;
	if (/[\u0000-\u001f]/.test(id)) return undefined;
	return id;
}

/**
 * Read one host's workspace registry.
 *
 * A missing registry is normal (the host was never opened), so it is silent.
 * Invalid JSON or an invalid shape is reported once and treated as empty.
 * @returns normalized registry, or `undefined`.
 */
async function readRegistry(file, warnings, label) {
	let parsed;
	try {
		parsed = JSON.parse(await readFile(file, 'utf8'));
	} catch (error) {
		if (error?.code === 'ENOENT') return undefined;
		warnings.push(`${label}: cannot read workspace registry: ${messageOf(error)}`);
		return undefined;
	}
	if (!isRecord(parsed)) {
		warnings.push(`${label}: workspace registry is not an object`);
		return undefined;
	}
	const global = isRecord(parsed.global) ? parsed.global : {};
	const tables = isRecord(parsed.tables) ? parsed.tables : {};
	const workspaces = isRecord(tables.workspaces) ? tables.workspaces : {};
	const workspaceIds = Array.isArray(global.workspaceIds)
		? global.workspaceIds.filter((id) => typeof id === 'string' && id !== '')
		: [];
	if (!Array.isArray(global.workspaceIds) && global.initialized === true) {
		warnings.push(`${label}: workspace registry has no workspaceIds list`);
	}
	return {
		workspaceIds,
		archivedSessionIds: stringSet(global.archivedSessionIds),
		pinnedSessionIds: stringSet(global.pinnedSessionIds),
		workspaces,
	};
}

/** Build a string set from a tolerant array field. */
function stringSet(value) {
	const result = new Set();
	if (!Array.isArray(value)) return result;
	for (const entry of value) {
		if (typeof entry === 'string' && entry !== '') result.add(entry);
	}
	return result;
}

/** Render one thrown value as a short warning fragment. */
function messageOf(error) {
	if (error instanceof Error && typeof error.message === 'string') return error.message;
	return typeof error === 'string' ? error : 'unknown error';
}

/** Read one session projection cache record, or `undefined`. */
function projectSession(id, parsed, registry) {
	if (!isRecord(parsed)) return undefined;
	const record = isRecord(parsed.record) ? parsed.record : {};
	const identity = isRecord(record.identity) ? record.identity : {};
	const rows = isRecord(record.rows) ? record.rows : {};
	const metadata = rowValue(rows, 'sessionListMetadata');
	const metadataRecord = isRecord(metadata) ? metadata : {};
	const timeContext = rowValue(rows, 'timeContext');
	const timeRecord = isRecord(timeContext) ? timeContext : {};
	const createdAt = isoTime(identity.createdAt);
	const lastPromptAt = isoTime(metadataRecord.lastPromptAt);
	const lastMessageAt = isoTime(timeRecord.lastMessageTime);
	const titleRow = text(rowValue(rows, 'title'));
	const titleInput = rowValue(rows, 'titleInput');
	const firstTitle = isRecord(titleInput) && isRecord(titleInput.first) ? text(titleInput.first.text) : '';
	const cwd = normalizePath(identity.cwd) || normalizePath(rowValue(rows, 'workingDirectory'));
	return {
		id,
		title: titleRow || firstTitle,
		cwd,
		createdAt,
		lastActiveAt: lastPromptAt ?? lastMessageAt ?? createdAt,
		blank: metadataRecord.blank === true,
		pinned: registry?.pinnedSessionIds.has(id) === true,
		archived: registry?.archivedSessionIds.has(id) === true,
	};
}

/** Read every session projection cache file of one host. */
async function readSessions(dir, warnings, label, registry) {
	let names;
	try {
		names = await readdir(dir);
	} catch (error) {
		if (error?.code === 'ENOENT') return new Map();
		warnings.push(`${label}: cannot list session cache: ${messageOf(error)}`);
		return new Map();
	}
	const sessions = new Map();
	for (const name of names) {
		const id = sessionIdFromFile(name);
		if (id === undefined) continue;
		let parsed;
		try {
			parsed = JSON.parse(await readFile(join(dir, name), 'utf8'));
		} catch (error) {
			warnings.push(`${label}: cannot read session ${id}: ${messageOf(error)}`);
			continue;
		}
		const session = projectSession(id, parsed, registry);
		if (session === undefined) {
			warnings.push(`${label}: session ${id} has an invalid cache record`);
			continue;
		}
		sessions.set(id, session);
	}
	return sessions;
}

/** Whether `cwd` is `root` or lives below it. */
function isUnder(cwd, root) {
	if (cwd === root) return true;
	const prefix = root.endsWith('/') ? root : `${root}/`;
	return cwd.startsWith(prefix);
}

/** The most specific workspace that contains one cwd. */
function workspaceByCwd(workspaces, cwd) {
	if (cwd === '') return undefined;
	let best;
	for (const workspace of workspaces) {
		if (workspace.path === '') continue;
		if (!isUnder(cwd, workspace.path)) continue;
		if (best === undefined || workspace.path.length > best.path.length) best = workspace;
	}
	return best;
}

/** Session ordering: last activity descending, then creation, then id. */
function compareSessions(left, right) {
	const leftActivity = left.lastActiveAt === undefined ? 0 : Date.parse(left.lastActiveAt);
	const rightActivity = right.lastActiveAt === undefined ? 0 : Date.parse(right.lastActiveAt);
	if (leftActivity !== rightActivity) return rightActivity - leftActivity;
	const leftCreated = left.createdAt === undefined ? 0 : Date.parse(left.createdAt);
	const rightCreated = right.createdAt === undefined ? 0 : Date.parse(right.createdAt);
	if (leftCreated !== rightCreated) return rightCreated - leftCreated;
	return left.id.localeCompare(right.id);
}

/** Public session shape (internal flags dropped, timestamps kept as ISO text). */
function publicSession(session) {
	const value = { id: session.id, title: session.title, blank: session.blank, pinned: session.pinned, archived: session.archived };
	if (session.lastActiveAt !== undefined) value.lastActiveAt = session.lastActiveAt;
	if (session.createdAt !== undefined) value.createdAt = session.createdAt;
	return value;
}

/** Attach sessions to the workspace list, adding derived workspaces when needed. */
function buildWorkspaces(registry, sessions) {
	const workspaces = [];
	const seen = new Set();
	if (registry !== undefined) {
		for (const id of registry.workspaceIds) {
			const record = registry.workspaces[id];
			if (!isRecord(record) || seen.has(id)) continue;
			seen.add(id);
			workspaces.push({ id, path: normalizePath(record.path), title: workspaceTitle(record), sessionIds: record.sessionIds, sessions: [] });
		}
		// Records created between two registry writes still carry sessions.
		for (const [id, record] of Object.entries(registry.workspaces)) {
			if (seen.has(id) || !isRecord(record)) continue;
			seen.add(id);
			workspaces.push({ id, path: normalizePath(record.path), title: workspaceTitle(record), sessionIds: record.sessionIds, sessions: [] });
		}
	}
	const pool = new Map(sessions);
	// Registry ids without a projection cache are still real sessions: keep a
	// minimal entry so they remain openable from the panel.
	for (const workspace of workspaces) {
		if (!Array.isArray(workspace.sessionIds)) continue;
		for (const id of workspace.sessionIds) {
			if (typeof id !== 'string' || id === '' || pool.has(id)) continue;
			pool.set(id, { id, title: '', cwd: '', createdAt: undefined, lastActiveAt: undefined, blank: false, pinned: false, archived: false });
		}
	}
	const assigned = new Set();
	// Explicit registry membership wins over path heuristics.
	for (const workspace of workspaces) {
		if (!Array.isArray(workspace.sessionIds)) continue;
		for (const id of workspace.sessionIds) {
			const session = pool.get(id);
			if (session === undefined || assigned.has(id)) continue;
			workspace.sessions.push(session);
			assigned.add(id);
		}
	}
	const real = workspaces.filter((workspace) => workspace.path !== '');
	// Then fall back to cwd containment, most specific workspace first.
	for (const [id, session] of pool) {
		if (assigned.has(id)) continue;
		const workspace = workspaceByCwd(real, session.cwd);
		if (workspace === undefined) continue;
		workspace.sessions.push(session);
		assigned.add(id);
	}
	// Anything left becomes a derived workspace keyed by cwd.
	const derived = new Map();
	for (const [id, session] of pool) {
		if (assigned.has(id)) continue;
		const key = session.cwd;
		let workspace = derived.get(key);
		if (workspace === undefined) {
			workspace = { id: `derived:${key || 'unknown'}`, path: key, title: key === '' ? '' : basename(key) || key, sessionIds: [], sessions: [] };
			derived.set(key, workspace);
			workspaces.push(workspace);
		}
		workspace.sessions.push(session);
	}
	for (const workspace of workspaces) workspace.sessions.sort(compareSessions);
	return workspaces.map((workspace) => ({
		path: workspace.path,
		title: workspace.title,
		sessions: workspace.sessions.map(publicSession),
	}));
}

/** Normalize the controller-provided instance state for one host. */
function instanceState(instanceOf, hostId) {
	let view;
	try {
		view = typeof instanceOf === 'function' ? instanceOf(hostId) : undefined;
	} catch {
		view = undefined;
	}
	const record = isRecord(view) ? view : {};
	const phase = typeof record.phase === 'string' && record.phase !== '' ? record.phase : 'idle';
	return { phase, running: record.running === true || phase === 'running' };
}

/** Scan one host home and return its browser-facing entry. */
async function scanHost(host, dataDir, instanceOf, warnings) {
	const hostId = text(host.id, MAX_SESSION_ID_LENGTH);
	const alias = text(host.alias, MAX_SESSION_ID_LENGTH);
	const displayName = text(host.displayName, MAX_SESSION_ID_LENGTH);
	const label = `host "${alias || hostId}"`;
	const home = join(dataDir, 'homes', safeHomeKey(hostId));
	const registry = await readRegistry(join(home, ...WORKSPACE_FILE), warnings, label);
	const sessions = await readSessions(join(home, ...SESSION_CACHE_DIR), warnings, label, registry);
	const state = instanceState(instanceOf, hostId);
	return {
		id: hostId,
		alias,
		displayName,
		remoteWorkspace: normalizePath(host.remoteWorkspace),
		phase: state.phase,
		running: state.running,
		workspaces: buildWorkspaces(registry, sessions),
	};
}

/**
 * Build the read-only remote workspace inventory for every managed host.
 *
 * @param input - `{ dataDir, hosts, instanceOf }`.
 * @param input.dataDir - plugin data directory that owns `homes/`.
 * @param input.hosts - managed host records: `{ id, alias, displayName, remoteWorkspace }`.
 * @param input.instanceOf - `(hostId) => ({ phase, running })` from the controller.
 * @returns `{ generatedAt, warnings, hosts }`, where every host entry carries
 *   `workspaces: [{ path, title, sessions: [{ id, title, lastActiveAt, createdAt, blank, pinned, archived }] }]`.
 */
export async function scanRemoteWorkspaces(input = {}) {
	const generatedAt = new Date().toISOString();
	const warnings = [];
	const dataDir = text(input?.dataDir, MAX_PATH_LENGTH);
	const hostsInput = Array.isArray(input?.hosts) ? input.hosts : [];
	const instanceOf = input?.instanceOf;
	if (dataDir === '') {
		warnings.push('remote workspace scan has no data directory');
		return { generatedAt, warnings, hosts: [] };
	}
	const hosts = [];
	const seen = new Set();
	for (const candidate of hostsInput) {
		if (!isRecord(candidate)) continue;
		const id = text(candidate.id, MAX_SESSION_ID_LENGTH);
		if (id === '') {
			warnings.push('remote workspace scan ignored a host without an id');
			continue;
		}
		if (seen.has(id)) continue;
		seen.add(id);
		try {
			hosts.push(await scanHost(candidate, dataDir, instanceOf, warnings));
		} catch (error) {
			// The per-host readers already tolerate every expected file error;
			// this is the last line of defence so one host cannot sink the scan.
			warnings.push(`host "${text(candidate.alias) || id}": scan failed: ${messageOf(error)}`);
			const state = instanceState(instanceOf, id);
			hosts.push({
				id,
				alias: text(candidate.alias, MAX_SESSION_ID_LENGTH),
				displayName: text(candidate.displayName, MAX_SESSION_ID_LENGTH),
				remoteWorkspace: normalizePath(candidate.remoteWorkspace),
				phase: state.phase,
				running: state.running,
				workspaces: [],
			});
		}
	}
	return { generatedAt, warnings, hosts };
}
