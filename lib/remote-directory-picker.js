/**
 * Remote directory-picker backend for the plugin-owned remote profile.
 *
 * The official Web composition mounts `@deepseek-ai/dsh-host-directory-picker-auto`,
 * which on a Linux/macOS desktop resolves the host's *native* chooser: the
 * operator gets an OS folder dialog on the machine running the child process,
 * not the SSH host. This module is copied into the remote profile and loaded by
 * an absolute path instead; every listing and creation below goes through
 * `ctx.fs` / `ctx.subprocess`, which are the official SSH providers in that
 * composition, so the browser sees the remote filesystem.
 *
 * The seam contract mirrors the official browse backend:
 * `ctx.directoryPicker.capability()` returns a stable `{ kind: 'browse', list,
 * createDirectory }` object; `list` returns `{ path, home, crumbs, entries,
 * truncated }` and `createDirectory` returns the created absolute path. Errors
 * use the seam's closed codes, but this copied module cannot import
 * `@deepseek-ai/dsh-host-directory-picker` (the profile does not depend on it),
 * so the class identity is local and the Host controller reports these as
 * `gateway/internal` with the operator-facing message; the browse dialog shows
 * that message either way.
 *
 * The one local side effect is the workspace mirror: `@deepseek-ai/dsh-workspace`
 * validates an attached directory with the *local* `node:fs` realpath/stat even
 * inside the remote window, so a remote path must also exist as an empty local
 * directory before it can be registered as a Workspace. That mirror is opt-in
 * through the overlay's `mirrorWorkspace` config and is strictly best-effort:
 * it creates directories only (never files or content), never follows a remote
 * symlink, and every failure is ignored — a remote `/root/project` simply cannot
 * be mirrored on a local account, and the registration then fails loudly in the
 * dialog instead of registering a path that does not exist.
 * @module @junjiangao/dsh-plugin-remote-ssh/remote-directory-picker
 */
import { mkdir } from 'node:fs/promises';
import { posix } from 'node:path';

/** Cordis plugin identity; the overlay row loads this file by absolute path. */
export const name = 'remote-directory-picker';
/** The remote filesystem and subprocess worlds must be mounted before listing. */
export const inject = ['fs', 'subprocess'];

/** Bound on the directory rows one listing materializes (the official browse default). */
export const MAX_ENTRIES = 1000;
/** Bound on collected stdout/stderr of the small remote helper commands. */
const PROBE_MAX_BYTES = 16 * 1024;
/** Grace period handed to the provider's process-termination procedure. */
const SPAWN_GRACE_MS = 5_000;

/** Local mirror paths already created by this process (successful mkdir only). */
const mirroredDirectories = new Set();

/**
 * Typed browse failure. Shape-compatible with the seam's
 * `DirectoryPickerError` so a Host controller that later shares the package
 * can classify `code`/`path` unchanged.
 */
export class DirectoryPickerError extends Error {
	/**
	 * @param code - closed browse failure code.
	 * @param path - absolute path the failure is about.
	 * @param message - operator-facing description.
	 */
	constructor(code, path, message) {
		super(message);
		this.name = 'DirectoryPickerError';
		this.code = code;
		this.path = path;
	}
}

/** Whether a value is a fully qualified POSIX path. */
export function isRemoteAbsolutePath(value) {
	return typeof value === 'string' && posix.isAbsolute(value);
}

/** Normalize the overlay row's config into the shape this backend consumes. */
export function normalizeConfig(config) {
	const value = config !== null && typeof config === 'object' ? config : {};
	return {
		// Opt-in: never create local directories unless the overlay asked for it.
		mirrorWorkspace: value.mirrorWorkspace === true,
		// Working directory for the small remote probes; the SSH provider requires
		// one of its own paths. The overlay always passes the remote workspace.
		workspace: isRemoteAbsolutePath(value.workspace) ? value.workspace : '/',
	};
}

/** Ancestor chain from the filesystem root to `target` inclusive (breadcrumbs). */
export function ancestryCrumbs(target) {
	const crumbs = [];
	let current = target;
	for (;;) {
		const parent = posix.dirname(current);
		crumbs.unshift({ name: parent === current ? current : posix.basename(current), path: current, hidden: false });
		if (parent === current) return crumbs;
		current = parent;
	}
}

/** Message text of an unknown thrown value. */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}

/** Resolve one small remote executable, falling back to its common absolute path. */
async function resolveExecutable(ctx, command, fallback, signal) {
	try {
		const resolved = await ctx.subprocess.resolveExecutable(command, undefined, signal);
		if (typeof resolved === 'string' && resolved !== '') return resolved;
	} catch (error) {
		if (signal?.aborted) signal.throwIfAborted();
	}
	return fallback;
}

/** Read one collected output stream from its beginning. */
function collectedText(reader) {
	if (reader === undefined) return '';
	try {
		return String(reader.readFrom(0).text);
	} catch {
		return '';
	}
}

/**
 * Run one small fixed remote command and collect its output.
 * @param ctx - context carrying the remote subprocess provider.
 * @param config - normalized config (the probe's workspace cwd).
 * @param argv - fully resolved argv; never shell-interpreted.
 * @param signal - caller lifetime.
 * @returns exit facts plus collected stdout/stderr text.
 */
async function runProbe(ctx, config, argv, signal) {
	signal?.throwIfAborted();
	const handle = ctx.subprocess.spawn({
		argv,
		cwd: config.workspace,
		stdio: {
			stdin: 'ignore',
			stdout: { maxBytes: PROBE_MAX_BYTES },
			stderr: { maxBytes: PROBE_MAX_BYTES },
		},
		graceMs: SPAWN_GRACE_MS,
		...(signal === undefined ? {} : { signal }),
	});
	let outcome;
	try {
		outcome = await handle.done;
	} catch (error) {
		if (signal?.aborted) signal.throwIfAborted();
		throw error;
	}
	return {
		outcome,
		stdout: collectedText(handle.collected?.stdout),
		stderr: collectedText(handle.collected?.stderr),
	};
}

/**
 * Create the local same-path empty directory the Workspace registry needs.
 * Best-effort only: every failure is swallowed so a browsing session still
 * lists the remote directory. See the module doc for the safety limits.
 * @param localPath - absolute path to mirror on the local machine.
 * @param config - normalized config; the mirror runs only with `mirrorWorkspace`.
 */
export async function mirrorLocalDirectory(localPath, config) {
	if (config.mirrorWorkspace !== true) return;
	if (!isRemoteAbsolutePath(localPath)) return;
	if (mirroredDirectories.has(localPath)) return;
	try {
		await mkdir(localPath, { recursive: true, mode: 0o700 });
		mirroredDirectories.add(localPath);
	} catch {
		// Denied, read-only, or an existing non-directory: the registration will
		// report the real failure; browsing must not depend on this mirror.
	}
}

/** Remote `$HOME` of the SSH account, probed once per plugin life. */
async function ensureRemoteHome(ctx, config, state, signal) {
	if (state.home !== undefined) return state.home;
	state.homePromise ??= probeRemoteHome(ctx, config, signal).finally(() => {
		state.homePromise = undefined;
	});
	let home;
	try {
		home = await state.homePromise;
	} catch (error) {
		if (signal?.aborted) signal.throwIfAborted();
		if (error instanceof DirectoryPickerError) throw error;
		throw new DirectoryPickerError(
			'directory-unreadable',
			'/',
			`cannot determine the remote home directory: ${messageOf(error)}`,
		);
	}
	state.home = home;
	return home;
}

/** Probe `$HOME` through the remote shell; never falls back to the local home. */
async function probeRemoteHome(ctx, config, signal) {
	const shell = await resolveExecutable(ctx, 'sh', '/bin/sh', signal);
	const result = await runProbe(ctx, config, [shell, '-c', 'printf %s "$HOME"'], signal);
	const home = result.stdout.trim();
	if (result.outcome.exitCode !== 0 || !isRemoteAbsolutePath(home)) {
		const detail = result.stderr.trim() === '' ? `exit ${String(result.outcome.exitCode)}` : result.stderr.trim();
		throw new DirectoryPickerError(
			'directory-unreadable',
			'/',
			`cannot determine the remote home directory: ${detail}`,
		);
	}
	return home;
}

/**
 * List one remote directory level for the official browse surface.
 * @param ctx - context carrying the remote fs/subprocess providers.
 * @param config - normalized config.
 * @param state - per-plugin home cache.
 * @param path - fully qualified remote directory; absent lists the remote home.
 * @param signal - caller lifetime; aborts the remote scan.
 * @returns the seam's DirectoryListing shape.
 */
async function listRemoteDirectory(ctx, config, state, path, signal) {
	signal?.throwIfAborted();
	if (path !== undefined && !isRemoteAbsolutePath(path)) {
		throw new DirectoryPickerError(
			'directory-unreadable',
			String(path),
			`cannot list "${String(path)}": not a fully qualified path`,
		);
	}
	const home = await ensureRemoteHome(ctx, config, state, signal);
	const requested = path ?? home;
	let target;
	try {
		target = await ctx.fs.resolve(requested, { signal });
	} catch (error) {
		if (signal?.aborted) signal.throwIfAborted();
		throw new DirectoryPickerError('directory-unreadable', requested, `cannot list ${requested}: ${messageOf(error)}`);
	}
	const resolvedPath = ctx.fs.processPath(target);
	let entries;
	try {
		entries = await ctx.fs.listDir(target, signal);
	} catch (error) {
		if (signal?.aborted) signal.throwIfAborted();
		throw new DirectoryPickerError('directory-unreadable', resolvedPath, `cannot list ${resolvedPath}: ${messageOf(error)}`);
	}
	// The remote list follows symlinks to directories (the helper probes with
	// stat), so a plain type filter already matches the official browse policy.
	const directories = entries
		.filter((entry) => entry.type === 'directory')
		.map((entry) => ({
			name: entry.name,
			path: ctx.fs.processPath(entry.target),
			hidden: entry.name.startsWith('.'),
		}))
		.sort((left, right) => left.name.localeCompare(right.name));
	signal?.throwIfAborted();
	const truncated = directories.length > MAX_ENTRIES;
	// The Workspace registry validates the *selected* directory locally; mirror
	// the level the operator is looking at so "Add workspace" can accept it.
	await mirrorLocalDirectory(resolvedPath, config);
	return {
		path: resolvedPath,
		home,
		crumbs: ancestryCrumbs(resolvedPath),
		entries: directories.slice(0, MAX_ENTRIES),
		truncated,
	};
}

/**
 * Create one remote child directory for the official browse surface.
 * @param ctx - context carrying the remote fs/subprocess providers.
 * @param config - normalized config.
 * @param path - fully qualified existing remote parent.
 * @param directoryName - single non-blank path segment.
 * @returns the created remote absolute path.
 */
async function createRemoteDirectory(ctx, config, path, directoryName) {
	if (!isRemoteAbsolutePath(path)) {
		throw new DirectoryPickerError(
			'directory-create-failed',
			String(path),
			`cannot create under "${String(path)}": not a fully qualified parent path`,
		);
	}
	const name = typeof directoryName === 'string' ? directoryName : String(directoryName);
	if (name.trim() === '' || name === '.' || name === '..' || /[/\\]/.test(name)) {
		throw new DirectoryPickerError(
			'directory-create-failed',
			posix.join(path, name),
			`"${name}" is not a single path segment`,
		);
	}
	let parent;
	try {
		parent = await ctx.fs.resolve(path);
	} catch (error) {
		throw new DirectoryPickerError('directory-create-failed', path, `cannot create under ${path}: ${messageOf(error)}`);
	}
	const childPath = posix.join(ctx.fs.processPath(parent), name);
	// Reject an existing child with the seam's own code. The stat is a probe
	// only; mkdir -p below still owns the real outcome (and its error text).
	let existing;
	try {
		existing = await ctx.fs.stat(await ctx.fs.resolve(childPath));
	} catch {
		existing = undefined;
	}
	if (existing !== undefined) {
		if (existing.type === 'directory') {
			throw new DirectoryPickerError('directory-exists', childPath, `${childPath} already exists`);
		}
		throw new DirectoryPickerError(
			'directory-create-failed',
			childPath,
			`cannot create ${childPath}: the path exists and is not a directory`,
		);
	}
	let result;
	try {
		const mkdirExecutable = await resolveExecutable(ctx, 'mkdir', '/bin/mkdir');
		result = await runProbe(ctx, config, [mkdirExecutable, '-p', '--', childPath]);
	} catch (error) {
		throw new DirectoryPickerError('directory-create-failed', childPath, `cannot create ${childPath}: ${messageOf(error)}`);
	}
	if (result.outcome.exitCode !== 0) {
		const detail = result.stderr.trim() === '' ? `exit ${String(result.outcome.exitCode)}` : result.stderr.trim();
		throw new DirectoryPickerError('directory-create-failed', childPath, `cannot create ${childPath}: ${detail}`);
	}
	await mirrorLocalDirectory(childPath, config);
	return childPath;
}

/**
 * Install the browse backend as `ctx.directoryPicker`.
 * @param ctx - context where the official SSH fs/subprocess providers are mounted.
 * @param config - the overlay row's config (`{ mirrorWorkspace, workspace }`).
 */
export function apply(ctx, config) {
	const settings = normalizeConfig(config);
	const state = { home: undefined, homePromise: undefined };
	const capability = {
		kind: 'browse',
		list: (path, signal) => listRemoteDirectory(ctx, settings, state, path, signal),
		createDirectory: (path, directoryName) => createRemoteDirectory(ctx, settings, path, directoryName),
	};
	ctx.provide('directoryPicker', { capability: () => capability });
}

export default { name, inject, apply };
