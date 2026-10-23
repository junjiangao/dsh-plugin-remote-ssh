/**
 * Lifecycle of one independent remote-execution Web instance per host.
 *
 * The child is a normal DSH CLI process booting the prepared `dsh-remote`
 * profile with a per-host overlay. Its authenticated URL is kept in memory
 * only: never persisted, never written to logs, and redacted in any status
 * text the browser can read.
 * @module @junjiangao/dsh-plugin-remote-ssh/instance
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { resolveExecutable } from './paths.js';
import { tail } from './helper.js';
import { RemoteSshError, ERROR_CODES } from './errors.js';

/** Cap applied to the retained child log. */
const LOG_LIMIT = 8 * 1024;
/** Grace period before escalating SIGTERM to SIGKILL. */
const KILL_GRACE_MS = 5_000;

/** Strip ANSI styling from child output. */
export function stripAnsi(text) {
	return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
}

/** Extract the authenticated URL from one line of child output. */
export function findWebUrl(text) {
	const clean = stripAnsi(text);
	const match = /dsh web:\s*(https?:\/\/\S+)/i.exec(clean);
	return match === null ? undefined : match[1];
}

/** Redact tokens and credentials from text that may reach the browser. */
export function redactSecrets(text) {
	return String(text)
		.replace(/([?&](?:token|key|secret|auth|t)=)[^&\s"']+/gi, '$1***')
		.replace(/(https?:\/\/[^\s"'?]+)\?[^\s"']*/g, (match, base) => `${base}?<redacted>`)
		.replace(/\b[0-9a-f]{64}\b/gi, (match) => `${match.slice(0, 8)}…`);
}

/** Create the default, idle instance view for one host. */
export function idleInstance() {
	return {
		phase: 'idle',
		running: false,
		message: undefined,
		error: undefined,
		startedAt: undefined,
		logTail: '',
		url: undefined,
		pid: undefined,
	};
}

/** Manages child processes and their in-memory status. */
export class InstanceManager {
	/**
	 * @param config - resolved plugin config.
	 * @param runtime - facts from `resolveRuntime()`.
	 * @param instancesDir - plugin data directory for overlays and pid files.
	 * @param options - `{ envOverrides }` used by tests to isolate HOME/DSH_HOME.
	 */
	constructor(config, runtime, instancesDir, options = {}) {
		this.config = config;
		this.runtime = runtime;
		this.instancesDir = instancesDir;
		this.envOverrides = options.envOverrides ?? {};
		this.entries = new Map();
		this.disposed = false;
	}

	/** Return one state, creating an idle one when absent. */
	ensure(hostId) {
		if (!this.entries.has(hostId)) this.entries.set(hostId, idleInstance());
		return this.entries.get(hostId);
	}

	/** Return the public instance view for one host. */
	view(hostId) {
		const entry = this.entries.get(hostId) ?? idleInstance();
		return {
			phase: entry.phase,
			running: entry.running,
			message: entry.message,
			error: entry.error === undefined ? undefined : redactSecrets(entry.error),
			startedAt: entry.startedAt,
			logTail: entry.logTail === '' ? '' : redactSecrets(entry.logTail),
			hasUrl: entry.url !== undefined,
		};
	}

	/** Return every non-idle state. */
	views() {
		const result = {};
		for (const [hostId, entry] of this.entries) {
			if (entry.phase === 'idle') continue;
			result[hostId] = this.view(hostId);
		}
		return result;
	}

	/** Update the human-readable phase for a host. */
	setPhase(hostId, phase, message) {
		const entry = this.ensure(hostId);
		entry.phase = phase;
		entry.message = message;
		if (phase === 'failed') entry.running = false;
	}

	/** Mark one host failed before a child exists. */
	markFailed(hostId, error) {
		const entry = this.ensure(hostId);
		entry.phase = 'failed';
		entry.running = false;
		entry.error = error instanceof Error ? error.message : String(error);
		entry.message = undefined;
		entry.startedAt = undefined;
		entry.pid = undefined;
		entry.url = undefined;
	}

	/** Stop and reset one host to idle. */
	async stop(hostId) {
		const entry = this.entries.get(hostId);
		if (entry === undefined) return;
		entry.phase = 'stopping';
		entry.message = undefined;
		await this.#terminate(entry);
		entry.phase = 'idle';
		entry.running = false;
		entry.error = undefined;
		entry.startedAt = undefined;
		entry.logTail = '';
		entry.url = undefined;
		entry.pid = undefined;
		await rm(this.#pidFile(hostId), { force: true }).catch(() => undefined);
	}

	/** Stop every child; used by plugin dispose. */
	async stopAll() {
		this.disposed = true;
		await Promise.all([...this.entries.keys()].map((hostId) => this.stop(hostId)));
	}

	/** The authenticated URL for an already-running instance. */
	url(hostId) {
		const entry = this.entries.get(hostId);
		if (entry === undefined || entry.url === undefined) {
			throw new RemoteSshError(ERROR_CODES.notFound, 'remote window is not running');
		}
		return entry.url;
	}

	/**
	 * Spawn one remote Web instance and wait until it prints its URL.
	 * @returns `{ url, pid }`.
	 */
	async start(host, options = {}) {
		if (this.disposed) throw new RemoteSshError(ERROR_CODES.instanceFailed, 'plugin is shutting down');
		const existing = this.entries.get(host.id);
		if (existing?.running) return { url: existing.url, pid: existing.pid, reused: true };
		const entry = this.ensure(host.id);
		entry.phase = 'starting';
		entry.message = undefined;
		entry.error = undefined;
		entry.logTail = '';
		entry.startedAt = Date.now();
		entry.url = undefined;
		entry.pid = undefined;
		const command = this.#resolveCommand();
		const args = [
			...command.prefix,
			'--profile',
			options.profileName ?? this.config.profileName,
		];
		for (const patch of options.patchPaths ?? []) args.push('--patch', patch);
		args.push('--no-open', '--host', '127.0.0.1', '--port', '0');
		const env = this.#childEnv({
			...(options.dshHome === undefined ? {} : { DSH_HOME: options.dshHome }),
			...(options.env ?? {}),
		});
		const child = spawn(command.file, args, {
			cwd: options.cwd ?? homedir(),
			env,
			detached: process.platform !== 'win32',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		entry.child = child;
		let urlSettler;
		let searchBuffer = '';
		const appendLog = (chunk) => {
			const text = stripAnsi(String(chunk));
			entry.logTail = tail(`${entry.logTail}${text}`, LOG_LIMIT);
		};
		child.stdout.on('data', (chunk) => {
			const text = stripAnsi(String(chunk));
			appendLog(text);
			searchBuffer = tail(`${searchBuffer}${text}`, 8_192);
			const url = findWebUrl(searchBuffer);
			if (url !== undefined && urlSettler !== undefined) urlSettler(url);
		});
		child.stderr.on('data', appendLog);
		return await new Promise((resolve, reject) => {
			let settled = false;
			const settleUrl = (url) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				entry.phase = 'running';
				entry.running = true;
				entry.url = url;
				entry.pid = child.pid;
				entry.message = undefined;
				entry.startedAt = Date.now();
				removeAbort();
				this.#writePid(host.id, child.pid, options.overlayPath).catch(() => undefined);
				resolve({ url, pid: child.pid, reused: false });
			};
			urlSettler = settleUrl;
			const fail = (error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				removeAbort();
				entry.phase = 'failed';
				entry.running = false;
				entry.error = error instanceof Error ? error.message : String(error);
				reject(error);
			};
			const onAbort = () => {
				killTree(child);
				fail(new RemoteSshError(ERROR_CODES.cancelled, 'remote window start was cancelled'));
			};
			const removeAbort = () => {
				if (options.signal !== undefined) options.signal.removeEventListener('abort', onAbort);
			};
			if (options.signal !== undefined) {
				if (options.signal.aborted) {
					onAbort();
					return;
				}
				options.signal.addEventListener('abort', onAbort, { once: true });
			}
			const timer = setTimeout(() => {
				killTree(child);
				fail(new RemoteSshError(
					ERROR_CODES.instanceFailed,
					`remote window did not print its URL within ${Math.round(this.config.openTimeoutMs / 1000)}s`,
					{ details: { log: redactSecrets(entry.logTail) } },
				));
			}, this.config.openTimeoutMs);
			child.on('error', (error) => fail(new RemoteSshError(ERROR_CODES.instanceFailed, error.message, { cause: error })));
			child.on('close', (code, signal) => {
				if (entry.url !== undefined && entry.running) {
					entry.running = false;
					entry.phase = 'failed';
					entry.error = `remote window exited (${String(code ?? signal)})`;
					return;
				}
				if (!settled) {
					fail(new RemoteSshError(
						ERROR_CODES.instanceFailed,
						`remote window exited before printing its URL (${String(code ?? signal)})`,
						{ details: { log: redactSecrets(entry.logTail) } },
					));
				}
			});
		});
	}

	/** Remove stale pid files left by a previous process. */
	async cleanupStale() {
		let files;
		try {
			files = readdirSync(this.instancesDir).filter((name) => name.endsWith('.pid'));
		} catch {
			return;
		}
		for (const name of files) {
			const file = join(this.instancesDir, name);
			let record;
			try {
				record = JSON.parse(await readFile(file, 'utf8'));
			} catch {
				await rm(file, { force: true }).catch(() => undefined);
				continue;
			}
			if (typeof record?.pid !== 'number' || !Number.isInteger(record.pid) || record.pid <= 1) {
				await rm(file, { force: true }).catch(() => undefined);
				continue;
			}
			const command = await processCommand(record.pid);
			if (command !== undefined && command.includes(this.config.profileName) && command.includes('dsh')) {
				try {
					process.kill(-record.pid, 'SIGTERM');
				} catch {
					try {
						process.kill(record.pid, 'SIGTERM');
					} catch {
						// Already gone.
					}
				}
			}
			await rm(file, { force: true }).catch(() => undefined);
		}
	}

	/** Build the CLI invocation. */
	#resolveCommand() {
		if (this.runtime.cliPath !== '' && existsSync(this.runtime.cliPath)) {
			return { file: this.runtime.cliPath, prefix: [] };
		}
		if (this.runtime.isDesktop && this.runtime.runtimeDir !== '') {
			const cli = join(
				this.runtime.runtimeDir,
				'node_modules',
				'@deepseek-ai',
				'dsh-desktop-host',
				'lib',
				'cli.js',
			);
			if (existsSync(cli)) return { file: this.runtime.nodePath, prefix: [cli] };
		}
		const dsh = resolveExecutable('dsh');
		if (dsh !== undefined) return { file: dsh, prefix: [] };
		throw new RemoteSshError(
			ERROR_CODES.instanceFailed,
			'cannot locate the DSH CLI executable',
			{ hint: 'Run the plugin from the official DSH installation.' },
		);
	}

	/** Environment for the child: strip the parent session, keep credentials. */
	#childEnv(overrides = {}) {
		const env = { ...process.env, ...this.envOverrides, ...overrides };
		for (const key of [
			'DSH_SESSION_ID',
			'DSH_WEB_URL',
			'DSH_WEB_HOST',
			'DSH_WEB_PORT',
			'DSH_PROFILE',
			'DSH_PROFILE_DIR',
		]) {
			delete env[key];
		}
		if (this.runtime.nodeBinDir !== '') env.PATH = `${this.runtime.nodeBinDir}:${env.PATH ?? ''}`;
		return env;
	}

	/** Write the pid record used for crash cleanup. */
	async #writePid(hostId, pid, overlayPath) {
		if (typeof pid !== 'number') return;
		await writeFile(
			this.#pidFile(hostId),
			`${JSON.stringify({ pid, hostId, overlayPath, startedAt: new Date().toISOString() }, null, 2)}\n`,
			{ encoding: 'utf8', mode: 0o600 },
		);
	}

	/** Path of one pid record. */
	#pidFile(hostId) {
		return join(this.instancesDir, `${hostId}.pid`);
	}

	/** Terminate one child and wait for it. */
	async #terminate(entry) {
		const child = entry.child;
		if (child === undefined || child.exitCode !== null) {
			entry.child = undefined;
			return;
		}
		const exited = new Promise((resolve) => child.once('close', resolve));
		killTree(child, 'SIGTERM');
		const timer = setTimeout(() => killTree(child, 'SIGKILL'), KILL_GRACE_MS);
		timer.unref();
		await exited;
		clearTimeout(timer);
		entry.child = undefined;
	}
}

/** Signal a detached child's process group when possible. */
function killTree(child, signal = 'SIGTERM') {
	if (child === undefined || child.pid === undefined) return;
	try {
		if (process.platform === 'win32') child.kill(signal);
		else process.kill(-child.pid, signal);
	} catch {
		try {
			child.kill(signal);
		} catch {
			// Already gone.
		}
	}
}

/** Read a process command line for stale-pid ownership checks. */
async function processCommand(pid) {
	if (process.platform === 'linux') {
		try {
			return (await readFile(`/proc/${pid}/cmdline`, 'utf8')).replace(/\0/g, ' ').trim();
		} catch {
			return undefined;
		}
	}
	try {
		const { execFile } = await import('node:child_process');
		return await new Promise((resolve) => {
			execFile('ps', ['-p', String(pid), '-o', 'command='], { timeout: 3_000 }, (error, stdout) => {
				resolve(error === null ? stdout.trim() : undefined);
			});
		});
	} catch {
		return undefined;
	}
}

/** Remove one stale pid record without touching the process. */
export async function dropPidRecord(instancesDir, hostId) {
	await rm(join(instancesDir, `${hostId}.pid`), { force: true }).catch(() => undefined);
}

/** Move a pid record aside after an unclean shutdown (diagnostics only). */
export async function archivePidRecord(instancesDir, hostId, suffix = 'stale') {
	const file = join(instancesDir, `${hostId}.pid`);
	if (!existsSync(file)) return;
	await rename(file, `${file}.${suffix}`).catch(() => undefined);
}
