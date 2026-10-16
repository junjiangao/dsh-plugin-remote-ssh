/**
 * OpenSSH argv construction and bounded process execution.
 *
 * This module owns the exact ssh/scp command lines and one hardened spawn
 * helper: every child gets a hard timeout, a SIGTERM-then-SIGKILL escalation,
 * and per-stream output caps, so a tool call can never hang on a stuck remote
 * session.
 * @module @local/dsh-plugin-remote-ssh/shell
 */
import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

/** Grace period between SIGTERM and SIGKILL for a timed-out child. */
export const KILL_GRACE_MS = 2000;
/** Final wait after SIGKILL before resolving with whatever output was captured. */
export const KILL_FINAL_MS = 2000;
/** POSIX environment variable name accepted for `ssh_exec`'s `env` argument. */
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Human-readable message for an arbitrary thrown value. */
export function errorMessage(error) {
	if (error instanceof Error) return error.message;
	if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message;
	return String(error);
}

/**
 * POSIX single-quote escaping: wrap in single quotes and turn every embedded
 * single quote into `'\''`, so the remote login shell sees the literal text.
 * @param value - the raw text.
 * @returns one safely quoted shell word.
 */
export function sq(value) {
	return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * Compose the single remote-script argv element.
 *
 * The remote login shell re-parses this string, so the pieces are joined with
 * `&&`: an optional `cd`, then one `export` per environment variable, then the
 * caller's command verbatim.
 * @param options - `cwd`, `env`, and `command`.
 * @returns the remote script string.
 */
export function composeRemoteScript(options) {
	const parts = [];
	const cwd = options.cwd;
	if (typeof cwd === 'string' && cwd.trim().length > 0) parts.push(`cd ${sq(cwd)}`);
	const env = options.env;
	if (env !== undefined && env !== null) {
		for (const [key, value] of Object.entries(env)) {
			if (!ENV_KEY_PATTERN.test(key)) {
				throw new Error(`remote-ssh: env key ${JSON.stringify(key)} is not a valid POSIX environment variable name`);
			}
			if (typeof value !== 'string') {
				throw new Error(`remote-ssh: env value for ${JSON.stringify(key)} must be a string`);
			}
			parts.push(`export ${key}=${sq(value)}`);
		}
	}
	parts.push(options.command);
	return parts.join(' && ');
}

/**
 * `ConnectTimeout` seconds for a millisecond budget, rounded up to at least 1.
 * @param ms - the connect timeout in milliseconds.
 * @returns the decimal string OpenSSH expects.
 */
export function connectTimeoutSeconds(ms) {
	const seconds = Math.ceil(Number(ms) / 1000);
	return String(Number.isFinite(seconds) && seconds >= 1 ? seconds : 1);
}

/** The connection options shared by ssh and scp, without the port flag. */
function connectionOptions(options) {
	const argv = [];
	if (options.port !== undefined && options.port !== null) argv.push(options.portFlag, String(options.port));
	if (options.identityFile !== undefined) argv.push('-i', options.identityFile);
	if (options.proxyJump !== undefined) argv.push('-J', options.proxyJump);
	argv.push('-o', `ConnectTimeout=${connectTimeoutSeconds(options.connectTimeoutMs)}`);
	argv.push('-o', 'BatchMode=yes');
	argv.push('-o', `StrictHostKeyChecking=${options.strictHostKeyChecking}`);
	for (const option of options.extraOptions ?? []) argv.push(option);
	return argv;
}

/**
 * Build the complete ssh argv, executable first.
 * @param options - resolved target, connection options, and the remote script.
 * @returns the argv array.
 */
export function buildSshArgv(options) {
	const argv = [options.executable, ...connectionOptions({ ...options, portFlag: '-p' })];
	if (options.pty === true) argv.push('-tt');
	argv.push('--', options.target, options.remoteScript);
	return argv;
}

/**
 * Build the complete scp argv, executable first.
 * @param options - resolved target, connection options, and source/destination.
 * @returns the argv array.
 */
export function buildScpArgv(options) {
	const argv = [options.executable, ...connectionOptions({ ...options, portFlag: '-P' })];
	if (options.recursive === true) argv.push('-r');
	// `--` ends option parsing (this OpenSSH 10.6p1 scp accepts it), so a relative operand beginning with `-` is transferred as a path instead of being rejected as an unknown option.
	argv.push('-q', '--', options.source, options.destination);
	return argv;
}

/** Accumulate at most `limit` bytes of one stream and flag any overflow. */
class StreamCapper {
	constructor(limit) {
		this.limit = limit;
		this.chunks = [];
		this.size = 0;
		this.truncated = false;
	}

	/** Append a chunk, dropping everything past the cap. */
	push(chunk) {
		if (this.size >= this.limit) {
			this.truncated = true;
			return;
		}
		const remaining = this.limit - this.size;
		if (chunk.length > remaining) {
			this.chunks.push(chunk.subarray(0, remaining));
			this.size = this.limit;
			this.truncated = true;
			return;
		}
		this.chunks.push(chunk);
		this.size += chunk.length;
	}

	/** Decode the captured bytes. */
	text() {
		return Buffer.concat(this.chunks).toString('utf8');
	}
}

/**
 * Resolve an executable name or path to an absolute path.
 * @param file - executable name or path.
 * @returns the absolute path, or null when it cannot be executed.
 */
export function resolveExecutable(file) {
	if (typeof file !== 'string' || file.length === 0) return null;
	if (isAbsolute(file) || file.includes('/')) {
		try {
			accessSync(file, constants.X_OK);
			return file;
		} catch {
			return null;
		}
	}
	for (const directory of (process.env.PATH ?? '').split(delimiter)) {
		if (directory.length === 0) continue;
		const candidate = join(directory, file);
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Keep searching the remaining PATH entries.
		}
	}
	return null;
}

/**
 * Spawn one child process and resolve with its bounded outcome.
 *
 * Resolution is guaranteed: the child is killed on timeout (SIGTERM, then
 * SIGKILL after {@link KILL_GRACE_MS}) and again on abort, with a final
 * fallback timer so even an unkillable process cannot hang the tool call.
 * @param options - executable, argv, timeout, stdin text, abort signal, cap.
 * @returns exit code, signal, captured streams, duration, and flags.
 */
export function runProcess(options) {
	const { file, args, timeoutMs, input, signal, maxOutputBytes } = options;
	return new Promise((resolve) => {
		const startedAt = Date.now();
		const stdout = new StreamCapper(maxOutputBytes);
		const stderr = new StreamCapper(maxOutputBytes);
		let child;
		try {
			child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
		} catch (error) {
			stderr.push(Buffer.from(`remote-ssh: failed to start ${file}: ${errorMessage(error)}\n`));
			resolve({
				exitCode: null,
				signal: null,
				stdout: stdout.text(),
				stderr: stderr.text(),
				durationMs: Date.now() - startedAt,
				timedOut: false,
				truncated: stderr.truncated,
			});
			return;
		}
		let settled = false;
		let timedOut = false;
		let timeoutTimer;
		let killTimer;
		let finalTimer;
		const cleanup = () => {
			if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
			if (killTimer !== undefined) clearTimeout(killTimer);
			if (finalTimer !== undefined) clearTimeout(finalTimer);
			if (signal !== undefined) signal.removeEventListener('abort', onAbort);
		};
		const finish = (exitCode, signalName) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve({
				exitCode,
				signal: signalName ?? null,
				stdout: stdout.text(),
				stderr: stderr.text(),
				durationMs: Date.now() - startedAt,
				timedOut,
				truncated: stdout.truncated || stderr.truncated,
			});
		};
		const escalate = () => {
			if (settled) return;
			try {
				child.kill('SIGTERM');
			} catch {
				// The child already exited; close will settle the promise.
			}
			killTimer = setTimeout(() => {
				if (settled) return;
				try {
					child.kill('SIGKILL');
				} catch {
					// The child already exited; close will settle the promise.
				}
				finalTimer = setTimeout(() => finish(null, 'SIGKILL'), KILL_FINAL_MS);
				if (typeof finalTimer.unref === 'function') finalTimer.unref();
			}, KILL_GRACE_MS);
			if (typeof killTimer.unref === 'function') killTimer.unref();
		};
		const onAbort = () => escalate();
		if (child.stdout !== null && child.stdout !== undefined) child.stdout.on('data', (chunk) => stdout.push(chunk));
		if (child.stderr !== null && child.stderr !== undefined) child.stderr.on('data', (chunk) => stderr.push(chunk));
		child.on('error', (error) => {
			stderr.push(Buffer.from(`remote-ssh: ${errorMessage(error)}\n`));
			finish(null, null);
		});
		child.on('close', (code, signalName) => finish(code, signalName ?? null));
		if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
			timeoutTimer = setTimeout(() => {
				timedOut = true;
				escalate();
			}, timeoutMs);
			if (typeof timeoutTimer.unref === 'function') timeoutTimer.unref();
		}
		if (signal !== undefined) {
			if (signal.aborted) escalate();
			else signal.addEventListener('abort', onAbort, { once: true });
		}
		if (child.stdin !== null && child.stdin !== undefined) {
			child.stdin.on('error', () => {
				// The child may exit before consuming stdin; that is not a tool failure.
			});
			if (typeof input === 'string' && input.length > 0) child.stdin.end(input);
			else child.stdin.end();
		}
	});
}
