/**
 * Persisted registry of remote workspaces mounted into the local desktop
 * window (\u201cmixed mode\u201d).
 *
 * Every entry records one mapping between a **local mirror directory** and the
 * remote directory it represents. The execution router uses the mapping to
 * decide whether a path belongs to the local execution world or to a remote
 * SSH world; the desktop workspace service only ever sees the local mirror
 * path, which is why the mirror directory has to exist on disk.
 *
 * The file is a small JSON document owned by the plugin data directory. Writes
 * are serialized and atomic (write to a sibling temporary file, then rename), so
 * a concurrent RPC or crash cannot leave a half-written registry behind.
 * @module @junjiangao/dsh-plugin-remote-ssh/mixed-registry
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix } from 'node:path';
import process from 'node:process';

/** Registry format version written into the file. */
export const MIXED_REGISTRY_VERSION = 1;

/** Stable error for registry misuse. */
export class MixedRegistryError extends Error {
	/**
	 * @param message - human-readable diagnostic.
	 * @param options - optional cause.
	 */
	constructor(message, options = {}) {
		super(message, options);
		this.name = 'MixedRegistryError';
	}
}

/** Whether a value is an absolute POSIX path. */
function isAbsolutePosix(value) {
	return typeof value === 'string' && value.startsWith('/') && !value.includes('\u0000');
}

/** Trim trailing slashes from an absolute POSIX path, keeping the root. */
export function trimPath(value) {
	if (value === '/') return '/';
	return value.replace(/\/+$/u, '') || '/';
}

/** Validate one persisted entry and return its normalized form. */
function normalizeEntry(candidate) {
	if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
		throw new MixedRegistryError('mixed workspace entry must be an object');
	}
	const { hostId, hostAlias, remotePath, mountPath, title } = candidate;
	if (typeof hostId !== 'string' || hostId === '') throw new MixedRegistryError('hostId is required');
	if (typeof hostAlias !== 'string' || hostAlias === '') throw new MixedRegistryError('hostAlias is required');
	if (!isAbsolutePosix(remotePath)) throw new MixedRegistryError(`remotePath must be absolute: ${String(remotePath)}`);
	if (typeof mountPath !== 'string' || !isAbsolute(mountPath)) {
		throw new MixedRegistryError(`mountPath must be absolute: ${String(mountPath)}`);
	}
	const createdAt = typeof candidate.createdAt === 'string' ? candidate.createdAt : new Date().toISOString();
	const id = typeof candidate.id === 'string' && candidate.id !== '' ? candidate.id : randomUUID();
	return {
		id,
		hostId,
		hostAlias,
		remotePath: trimPath(remotePath),
		mountPath: trimPath(mountPath),
		...(typeof title === 'string' && title !== '' ? { title } : {}),
		createdAt,
	};
}

/** Case-sensitive host+path identity used for idempotent registration. */
function keyOf(entry) {
	return `${entry.hostId}\u0000${entry.remotePath}`;
}

/**
 * One on-disk registry. Reads are lazily loaded once; mutations are queued.
 */
export class MixedRegistry {
	/**
	 * @param file - absolute path to `workspaces.json`.
	 */
	constructor(file) {
		this.file = file;
		this.entries = [];
		this.loaded = false;
		this.queue = Promise.resolve();
	}

	/** Read the registry once, ignoring individual malformed entries. */
	async load() {
		if (this.loaded) return this;
		try {
			const raw = await readFile(this.file, 'utf8');
			const parsed = JSON.parse(raw);
			if (parsed?.version !== MIXED_REGISTRY_VERSION) {
				throw new MixedRegistryError(`unsupported mixed registry version: ${String(parsed?.version)}`);
			}
			const list = Array.isArray(parsed.workspaces) ? parsed.workspaces : [];
			const seen = new Set();
			this.entries = [];
			for (const candidate of list) {
				try {
					const entry = normalizeEntry(candidate);
					const key = keyOf(entry);
					if (seen.has(key)) continue;
					seen.add(key);
					this.entries.push(entry);
				} catch {
					// Ignore one malformed row; registration rewrites the file.
				}
			}
		} catch (error) {
			if (error?.code !== 'ENOENT') {
				// A corrupt registry is a recoverable failure: keep the broken
				// document beside the new one so the user can inspect it.
				const backup = `${this.file}.corrupt-${Date.now()}`;
				await rename(this.file, backup).catch(() => undefined);
			}
			this.entries = [];
		}
		this.loaded = true;
		return this;
	}

	/** Return deep copies of every entry. */
	list() {
		return this.entries.map((entry) => ({ ...entry }));
	}

	/** Find one entry by its stable id. */
	get(id) {
		const entry = this.entries.find((candidate) => candidate.id === id);
		return entry === undefined ? undefined : { ...entry };
	}

	/** Find every entry registered for one host. */
	forHost(hostId) {
		return this.entries.filter((entry) => entry.hostId === hostId).map((entry) => ({ ...entry }));
	}

	/**
	 * The longest registered mount path containing `path`, or undefined for a
	 * local path. Longest-prefix wins so nested registrations stay precise.
	 * @param path - absolute local path (already resolved relative to a cwd).
	 */
	mountFor(path) {
		let best;
		for (const entry of this.entries) {
			if (path === entry.mountPath || path.startsWith(`${entry.mountPath}/`)) {
				if (best === undefined || entry.mountPath.length > best.mountPath.length) best = entry;
			}
		}
		return best === undefined ? undefined : { ...best };
	}

	/**
	 * Register one mapping; an existing host+remotePath pair is updated in place.
	 * @param draft - fields of a new entry.
	 * @returns the persisted entry.
	 */
	add(draft) {
		return this.#enqueue(async () => {
			await this.load();
			const normalized = normalizeEntry(draft);
			const key = keyOf(normalized);
			const existingIndex = this.entries.findIndex((entry) => keyOf(entry) === key);
			if (existingIndex === -1) this.entries.push(normalized);
			else this.entries[existingIndex] = { ...normalized, id: this.entries[existingIndex].id };
			await this.#write();
			return { ...this.entries[existingIndex === -1 ? this.entries.length - 1 : existingIndex] };
		});
	}

	/** Remove one entry by id. */
	remove(id) {
		return this.#enqueue(async () => {
			await this.load();
			const index = this.entries.findIndex((entry) => entry.id === id);
			if (index === -1) return false;
			this.entries.splice(index, 1);
			await this.#write();
			return true;
		});
	}

	/** Remove every entry of one host. */
	removeHost(hostId) {
		return this.#enqueue(async () => {
			await this.load();
			const before = this.entries.length;
			this.entries = this.entries.filter((entry) => entry.hostId !== hostId);
			if (this.entries.length === before) return 0;
			await this.#write();
			return before - this.entries.length;
		});
	}

	/** Serialize one mutation behind the previous one. */
	#enqueue(operation) {
		const run = this.queue.then(operation, operation);
		this.queue = run.then(() => undefined, () => undefined);
		return run;
	}

	/** Atomically persist the whole registry. */
	async #write() {
		await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
		const temporary = join(dirname(this.file), `.workspaces-${process.pid}-${Date.now()}.tmp`);
		const document = {
			version: MIXED_REGISTRY_VERSION,
			workspaces: this.entries,
		};
		await writeFile(temporary, `${JSON.stringify(document, undefined, 2)}\n`, { mode: 0o600 });
		await rename(temporary, this.file);
	}
}

/**
 * Derive the local mirror directory for one remote path.
 *
 * The directory is deliberately readable and stable: it appears in the
 * workspace list, and the desktop workspace service realpaths it. A readable
 * path component plus a short SHA-256 suffix keeps different remote paths from
 * colliding while staying recognizable.
 * @param mountsDir - plugin-owned parent directory.
 * @param hostId - managed host id.
 * @param remotePath - absolute remote path.
 * @param digest - SHA-256 hex digest of `hostId + remotePath`.
 * @returns the absolute mount path.
 */
export function mountPathFor(mountsDir, hostId, remotePath, digest) {
	const readable = trimPath(remotePath)
		.replace(/^\/+/, '')
		.replace(/[^A-Za-z0-9._-]+/gu, '-')
		.slice(-120) || 'root';
	return join(mountsDir, hostId, `${readable}-${digest.slice(0, 8)}`);
}

/** Compose the remote path addressed by a local mount path. */
export function remotePathAt(entry, localPath) {
	if (localPath === entry.mountPath) return entry.remotePath;
	if (!localPath.startsWith(`${entry.mountPath}/`)) {
		throw new MixedRegistryError(`${localPath} is outside the mount ${entry.mountPath}`);
	}
	const suffix = localPath.slice(entry.mountPath.length + 1);
	return posix.join(entry.remotePath, suffix);
}
