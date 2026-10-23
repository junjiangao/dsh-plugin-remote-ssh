/**
 * Isolated DSH home for one remote-execution window.
 *
 * The child must not reuse the desktop workspace/session registry: those paths
 * name local projects, while the child's `fs` service is the remote SSH
 * filesystem. A fresh home keeps the remote window on its own state, seeds one
 * workspace that points at the remote workspace, and inherits only the files
 * that carry credentials and user preferences.
 *
 * The profile itself stays in the normal `$DSH_HOME/profiles/<name>` directory
 * and is linked into the isolated home; the official SSH packages therefore
 * remain shared and are not installed twice.
 * @module @junjiangao/dsh-plugin-remote-ssh/remote-home
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, readlink, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import process from 'node:process';
import { resolveDshHome } from './paths.js';

/** Files inherited from the real DSH home by symlink, in precedence order. */
const INHERITED_FILES = ['.credentials.yaml', '.env', 'settings.yaml', 'AGENTS.md'];

/** Filesystem-safe identity for one host directory. */
export function safeHomeKey(hostId) {
	return String(hostId).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'host';
}

/** Stable workspace id derived from the host and its remote path. */
export function workspaceIdFor(hostId, workspace) {
	const words = createHash('sha256')
		.update(`${hostId}\0${workspace}`)
		.digest('hex')
		.slice(0, 32)
		.match(/.{8}/g);
	return `${words[0]}-${words[1]}-${words[2]}-${words[3]}-${words[4]}`;
}

/** Build the one-workspace registry used on a fresh isolated home. */
function freshWorkspaceState(id, workspace) {
	const now = new Date().toISOString();
	return {
		unit: { name: 'workspace', version: 2 },
		global: {
			initialized: true,
			workspaceIds: [id],
			archivedSessionIds: [],
			pinnedSessionIds: [],
		},
		tables: {
			workspaces: {
				[id]: {
					path: workspace,
					title: basename(workspace) || workspace,
					sessionIds: [],
					createdAt: now,
					updatedAt: now,
				},
			},
		},
	};
}

/**
 * Ensure the isolated workspace registry contains the remote workspace.
 *
 * Existing sessions and additional workspaces are kept; an older registry that
 * only points at a local default workspace is repaired in place.
 * @param file - path of `storages/workspace.json`.
 * @param hostId - plugin host identity.
 * @param workspace - absolute remote workspace path.
 */
export async function ensureWorkspaceRegistry(file, hostId, workspace) {
	let state;
	try {
		state = JSON.parse(await readFile(file, 'utf8'));
	} catch {
		state = undefined;
	}
	if (
		state === null ||
		typeof state !== 'object' ||
		state.global === null ||
		typeof state.global !== 'object' ||
		state.tables === null ||
		typeof state.tables !== 'object' ||
		!Array.isArray(state.global.workspaceIds) ||
		state.tables.workspaces === null ||
		typeof state.tables.workspaces !== 'object'
	) {
		state = freshWorkspaceState(workspaceIdFor(hostId, workspace), workspace);
	} else {
		const workspaces = state.tables.workspaces;
		let existingId;
		for (const [id, record] of Object.entries(workspaces)) {
			if (record?.path === workspace) {
				existingId = id;
				break;
			}
		}
		const id = existingId ?? workspaceIdFor(hostId, workspace);
		if (existingId === undefined) {
			const now = new Date().toISOString();
			workspaces[id] = {
				path: workspace,
				title: basename(workspace) || workspace,
				sessionIds: [],
				createdAt: now,
				updatedAt: now,
			};
		}
		state.global.initialized = true;
		if (!state.global.workspaceIds.includes(id)) state.global.workspaceIds.unshift(id);
		if (!Array.isArray(state.global.archivedSessionIds)) state.global.archivedSessionIds = [];
		if (!Array.isArray(state.global.pinnedSessionIds)) state.global.pinnedSessionIds = [];
		if (
			state.global.defaultWorkspaceId !== undefined &&
			workspaces[state.global.defaultWorkspaceId]?.path !== workspace
		) {
			state.global.defaultWorkspaceId = id;
		}
	}
	await mkdir(join(file, '..'), { recursive: true, mode: 0o700 });
	const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
	await rename(temporary, file);
	return state;
}

/** Link one inherited credential/preference file when both sides are present. */
async function inheritFile(source, destination) {
	if (!existsSync(source)) return;
	let existing;
	try {
		existing = await lstat(destination);
	} catch {
		existing = undefined;
	}
	if (existing !== undefined) {
		if (!existing.isSymbolicLink()) return;
		try {
			if ((await readlink(destination)) === source) return;
		} catch {
			// Replace a broken link below.
		}
		await unlink(destination).catch(() => undefined);
	}
	await symlink(source, destination).catch(() => undefined);
}

/**
 * Prepare the isolated DSH home for one host.
 * @param input - data directory, host, prepared profile and remote workspace.
 * @returns absolute paths used by the child process.
 */
export async function prepareRemoteHome(input) {
	const { dataDir, host, profileName, profileDir, workspace } = input;
	if (!workspace.startsWith('/')) throw new Error('remote workspace must be an absolute POSIX path');
	const dshHome = input.dshHome ?? resolveDshHome();
	const home = join(dataDir, 'homes', safeHomeKey(host.id));
	await mkdir(join(home, 'profiles'), { recursive: true, mode: 0o700 });
	await mkdir(join(home, 'storages'), { recursive: true, mode: 0o700 });
	for (const name of INHERITED_FILES) await inheritFile(join(dshHome, name), join(home, name));
	const profileLink = join(home, 'profiles', profileName);
	let profileLinkInfo;
	try {
		profileLinkInfo = await lstat(profileLink);
	} catch {
		profileLinkInfo = undefined;
	}
	if (profileLinkInfo?.isSymbolicLink() === true) {
		const target = await readlink(profileLink).catch(() => undefined);
		if (target !== profileDir) {
			await unlink(profileLink).catch(() => undefined);
			await symlink(profileDir, profileLink).catch(() => undefined);
		}
	} else if (profileLinkInfo === undefined) {
		await symlink(profileDir, profileLink).catch(() => undefined);
	}
	await ensureWorkspaceRegistry(join(home, 'storages', 'workspace.json'), host.id, workspace);
	return { home, profileDir, workspace };
}

/** Remove the isolated state for one host (used by tests and explicit reset). */
export async function removeRemoteHome(dataDir, hostId) {
	const { rm } = await import('node:fs/promises');
	await rm(join(dataDir, 'homes', safeHomeKey(hostId)), { recursive: true, force: true });
}
