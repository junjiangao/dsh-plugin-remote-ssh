/**
 * Remote-aware `@file` completion provider for the official SSH filesystem.
 *
 * The shipped `dsh-file-reference-local` scans `node:fs` directly, so a remote
 * window would list local paths that do not exist on the SSH host. This module
 * is copied into the plugin-owned remote profile and loaded as a Cordis plugin;
 * every listing below goes through `ctx.fs`, which is the official `dsh-fs-ssh`
 * provider in that composition.
 *
 * It lists immediate children only (plus one explicitly typed directory) so a
 * completion costs one remote round trip instead of a full workspace crawl.
 * @module @junjiangao/dsh-plugin-remote-ssh/remote-reference
 */

/** Torpor/Cordis plugin identity used by the generated overlay row. */
export const name = 'remote-file-reference';

/** Services that must be available before this provider can list anything. */
export const inject = ['agents', 'workingDirectory', 'fs'];

/** Directory basenames skipped during completion, mirroring the local provider. */
const EXCLUDED_DIRECTORIES = new Set([
	'.git',
	'node_modules',
	'dist',
	'build',
	'out',
	'coverage',
	'target',
	'.next',
	'.nuxt',
	'.turbo',
	'.venv',
	'__pycache__',
	'.pytest_cache',
	'.mypy_cache',
	'.gradle',
]);

/** Maximum candidates returned for one query. */
const MAX_RESULTS = 20;

/** Map one remote entry to the browser's path-only candidate shape. */
function candidateKind(entry) {
	return entry.type === 'directory' ? 'directory' : 'file';
}

/** Return `target` relative to `root`, preserving an absolute path when outside. */
function relativeTo(root, target) {
	if (target === root) return '';
	return target.startsWith(`${root}/`) ? target.slice(root.length + 1) : target;
}

/** Directories first, then stable path order. */
function compareCandidates(left, right) {
	const leftDirectory = left.kind === 'directory';
	const rightDirectory = right.kind === 'directory';
	if (leftDirectory !== rightDirectory) return leftDirectory ? -1 : 1;
	return left.path.localeCompare(right.path);
}

/** List the immediate children of the session's remote working directory. */
async function immediateChildren(ctx, cwd, signal) {
	const target = await ctx.fs.resolve(cwd, { signal });
	if (target === undefined) return [];
	const entries = await ctx.fs.listDir(target, signal);
	return entries
		.filter((entry) => !EXCLUDED_DIRECTORIES.has(entry.name))
		.map((entry) => ({
			path: relativeTo(cwd, ctx.fs.processPath(entry.target)),
			kind: candidateKind(entry),
		}));
}

/** List one explicitly typed directory and filter its children by fragment. */
async function childrenWithPrefix(ctx, cwd, query, signal) {
	const slash = query.lastIndexOf('/');
	const prefix = query.slice(0, slash + 1);
	const fragment = query.slice(slash + 1).toLowerCase();
	const target = await ctx.fs.resolve(prefix === '' ? cwd : prefix, { cwd, signal });
	if (target === undefined) return [];
	const entries = await ctx.fs.listDir(target, signal);
	const results = [];
	for (const entry of entries) {
		if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
		if (fragment !== '' && !entry.name.toLowerCase().startsWith(fragment)) continue;
		if (entry.name.startsWith('.') && !fragment.startsWith('.')) continue;
		results.push({
			path: `${prefix}${entry.name}`,
			kind: candidateKind(entry),
		});
	}
	return results;
}

/**
 * Install the remote file-reference provider.
 * @param ctx - Cordis context with the official SSH filesystem mounted.
 */
export function apply(ctx) {
	/** Resolve completion candidates for one agent's `@` query. */
	const list = async (agent, query, signal) => {
		if (typeof query !== 'string') return [];
		signal?.throwIfAborted();
		const cwd = await ctx.workingDirectory.ensure(agent, signal);
		const normalized = query.replaceAll('\\', '/');
		const candidates = normalized.includes('/')
			? await childrenWithPrefix(ctx, cwd, normalized, signal)
			: (await immediateChildren(ctx, cwd, signal)).filter((candidate) => {
					if (!normalized.startsWith('.') && candidate.path.split('/').some((segment) => segment.startsWith('.'))) {
						return false;
					}
					return normalized === '' || candidate.path.toLowerCase().startsWith(normalized.toLowerCase());
				});
		signal?.throwIfAborted();
		return candidates.sort(compareCandidates).slice(0, MAX_RESULTS);
	};
	ctx.provide('fileReferences', { list });
}

export default { name, inject, apply };
