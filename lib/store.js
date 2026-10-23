/**
 * Durable host list for the plugin-owned SSH configuration.
 *
 * The store owns `hosts.json` only. The generated OpenSSH fragment is derived
 * from it by `ssh-config.js`; keeping the two files separate makes recovery
 * simple when `~/.ssh/config` is edited by hand or the plugin crashes mid-write.
 * @module @junjiangao/dsh-plugin-remote-ssh/store
 */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { RemoteSshError, ERROR_CODES } from './errors.js';
import { validateHostDraft } from './validate.js';

/** Current on-disk format version. */
export const STORE_VERSION = 1;

/** One host record persisted in `hosts.json`. */
export function createHostRecord(draft, now = new Date()) {
	const timestamp = now.toISOString();
	return {
		id: draft.id ?? `host_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
		alias: draft.alias,
		displayName: draft.displayName,
		description: draft.description,
		hostname: draft.hostname,
		user: draft.user,
		port: draft.port,
		identityFile: draft.identityFile,
		proxyJump: draft.proxyJump,
		proxyCommand: draft.proxyCommand,
		identitiesOnly: draft.identitiesOnly,
		forwardAgent: draft.forwardAgent,
		serverAliveInterval: draft.serverAliveInterval,
		serverAliveCountMax: draft.serverAliveCountMax,
		strictHostKeyChecking: draft.strictHostKeyChecking,
		userKnownHostsFile: draft.userKnownHostsFile,
		connectionAttempts: draft.connectionAttempts,
		connectTimeout: draft.connectTimeout,
		extraOptions: draft.extraOptions ?? [],
		remoteWorkspace: draft.remoteWorkspace ?? '~',
		remoteHelperRoot: draft.remoteHelperRoot,
		createdAt: timestamp,
		updatedAt: timestamp,
	};
}

/** In-memory view of `hosts.json` with serialized atomic writes. */
export class HostStore {
	/**
	 * @param hostsFile - absolute path to `hosts.json`.
	 */
	constructor(hostsFile) {
		this.file = hostsFile;
		this.hosts = [];
		this.warnings = [];
		this.loaded = false;
		this.queue = Promise.resolve();
	}

	/** Read the file once. Corrupt content is preserved under a timestamped name. */
	async load() {
		if (this.loaded) return this;
		await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
		let raw;
		try {
			raw = await readFile(this.file, 'utf8');
		} catch (error) {
			if (error?.code !== 'ENOENT') throw error;
			this.loaded = true;
			return this;
		}
		try {
			const parsed = JSON.parse(raw);
			const hosts = Array.isArray(parsed?.hosts) ? parsed.hosts : [];
			const valid = [];
			for (const candidate of hosts) {
				try {
					const draft = validateHostDraft(candidate);
					if (draft.id === undefined) throw new Error('missing id');
					valid.push(createHostRecord(draft, new Date(candidate.createdAt ?? Date.now())));
					valid[valid.length - 1].createdAt = candidate.createdAt ?? valid[valid.length - 1].createdAt;
					valid[valid.length - 1].updatedAt = candidate.updatedAt ?? valid[valid.length - 1].updatedAt;
				} catch (error) {
					this.warnings.push(`ignored invalid host record: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			this.hosts = valid;
		} catch (error) {
			const backup = `${this.file}.corrupt-${Date.now()}`;
			try {
				await rename(this.file, backup);
			} catch {
				// Best effort; the original file stays in place.
			}
			this.warnings.push(
				`host store was corrupt and has been reset (${error instanceof Error ? error.message : String(error)})`,
			);
			this.hosts = [];
		}
		this.loaded = true;
		return this;
	}

	/** Return a deep-enough copy of every managed host. */
	list() {
		return this.hosts.map((host) => structuredClone(host));
	}

	/** Find one host by id. */
	get(id) {
		const host = this.hosts.find((candidate) => candidate.id === id);
		return host === undefined ? undefined : structuredClone(host);
	}

	/** Find one host by its ssh alias. */
	findByAlias(alias) {
		const host = this.hosts.find((candidate) => candidate.alias === alias);
		return host === undefined ? undefined : structuredClone(host);
	}

	/** Create or update one host and persist the whole list atomically. */
	save(draft) {
		return this.#enqueue(async () => {
			const normalized = validateHostDraft(draft);
			const existingIndex = normalized.id === undefined
				? -1
				: this.hosts.findIndex((candidate) => candidate.id === normalized.id);
			const duplicateAlias = this.hosts.find(
				(candidate, index) => candidate.alias === normalized.alias && index !== existingIndex,
			);
			if (duplicateAlias !== undefined) {
				throw new RemoteSshError(
					ERROR_CODES.conflict,
					`alias "${normalized.alias}" is already used by "${duplicateAlias.displayName ?? duplicateAlias.alias}"`,
					{ details: { field: 'alias' } },
				);
			}
			if (normalized.id !== undefined && existingIndex === -1) {
				throw new RemoteSshError(ERROR_CODES.notFound, `host "${normalized.id}" does not exist`);
			}
			let record;
			if (existingIndex === -1) {
				record = createHostRecord({ ...normalized, id: undefined });
				this.hosts.push(record);
			} else {
				const previous = this.hosts[existingIndex];
				record = createHostRecord(
					{ ...normalized, id: previous.id },
					new Date(),
				);
				record.createdAt = previous.createdAt;
				this.hosts[existingIndex] = record;
			}
			await this.#persist();
			return structuredClone(record);
		});
	}

	/** Delete one host by id. */
	remove(id) {
		return this.#enqueue(async () => {
			const index = this.hosts.findIndex((candidate) => candidate.id === id);
			if (index === -1) throw new RemoteSshError(ERROR_CODES.notFound, `host "${id}" does not exist`);
			const [removed] = this.hosts.splice(index, 1);
			await this.#persist();
			return structuredClone(removed);
		});
	}

	/** Atomically replace every record (used by tests and recovery tooling). */
	replaceAll(hosts) {
		return this.#enqueue(async () => {
			const records = hosts.map((candidate) => {
				const draft = validateHostDraft(candidate);
				if (draft.id === undefined) throw new RemoteSshError(ERROR_CODES.validation, 'host id is required');
				return createHostRecord(draft, new Date(candidate.createdAt ?? Date.now()));
			});
			const aliases = new Set();
			for (const record of records) {
				if (aliases.has(record.alias)) {
					throw new RemoteSshError(ERROR_CODES.conflict, `duplicate alias ${record.alias}`);
				}
				aliases.add(record.alias);
			}
			this.hosts = records;
			await this.#persist();
			return this.list();
		});
	}

	/** Serialize one mutation after every earlier mutation. */
	#enqueue(action) {
		const next = this.queue.then(action, action);
		this.queue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	/** Write the full list through a private temporary file and rename. */
	async #persist() {
		await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
		const body = `${JSON.stringify({ version: STORE_VERSION, hosts: this.hosts }, null, 2)}\n`;
		const temporary = `${this.file}.tmp-${process.pid}-${Date.now()}`;
		await writeFile(temporary, body, { encoding: 'utf8', mode: 0o600 });
		await chmod(temporary, 0o600).catch(() => undefined);
		await rename(temporary, this.file);
	}
}
