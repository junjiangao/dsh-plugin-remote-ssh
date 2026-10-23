/**
 * Safe process execution and OpenSSH invocation.
 *
 * Every remote operation starts as an argv array for the local OpenSSH client.
 * No local shell is involved; the only remote command is a single POSIX shell
 * string built from quoted tokens, never from unquoted user input.
 * @module @junjiangao/dsh-plugin-remote-ssh/ssh
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { resolveSshConfigPath } from './paths.js';

/** Per-stream capture cap; remote diagnostics are small and logs are bounded. */
export const MAX_CAPTURE_BYTES = 256 * 1024;

/** POSIX single-quote escaping. The result is always one shell word. */
export function quote(value) {
	return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Quote a list of tokens into one POSIX shell command line. */
export function quoteCommand(argv) {
	return argv.map(quote).join(' ');
}

/**
 * Run one local process and capture bounded stdout/stderr.
 * @param file - executable path or name.
 * @param args - argv array, passed verbatim.
 * @param options - timeout, abort signal, stdin, capture cap.
 * @returns exit facts; never rejects for a non-zero exit.
 */
export function runProcess(file, args, options = {}) {
	const {
		timeoutMs = 30_000,
		signal,
		input,
		maxBytes = MAX_CAPTURE_BYTES,
		env = process.env,
		cwd,
	} = options;
	return new Promise((resolve, reject) => {
		const startedAt = Date.now();
		let settled = false;
		let timedOut = false;
		let stdout = '';
		let stderr = '';
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let truncated = false;
		let child;
		try {
			child = spawn(file, args, {
				cwd,
				env,
				stdio: ['pipe', 'pipe', 'pipe'],
			});
		} catch (error) {
			reject(error);
			return;
		}
		const append = (current, chunk, counter) => {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
			const remaining = maxBytes - counter;
			if (remaining <= 0) {
				truncated = true;
				return { text: current, counter, truncated: true };
			}
			const slice = buffer.length > remaining ? buffer.subarray(0, remaining) : buffer;
			if (buffer.length > remaining) truncated = true;
			return { text: current + slice.toString('utf8'), counter: counter + slice.length, truncated };
		};
		child.stdout.on('data', (chunk) => {
			const next = append(stdout, chunk, stdoutBytes);
			stdout = next.text;
			stdoutBytes = next.counter;
		});
		child.stderr.on('data', (chunk) => {
			const next = append(stderr, chunk, stderrBytes);
			stderr = next.text;
			stderrBytes = next.counter;
		});
		const finish = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (signal !== undefined) signal.removeEventListener('abort', onAbort);
			resolve({
				...result,
				stdout,
				stderr,
				stdoutBytes,
				stderrBytes,
				truncated,
				timedOut,
				durationMs: Date.now() - startedAt,
			});
		};
		const fail = (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (signal !== undefined) signal.removeEventListener('abort', onAbort);
			reject(error);
		};
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill('SIGTERM');
			} catch {
				// Already gone.
			}
			setTimeout(() => {
				try {
					child.kill('SIGKILL');
				} catch {
					// Already gone.
				}
			}, 2_000).unref();
		}, timeoutMs);
		const onAbort = () => {
			try {
				child.kill('SIGTERM');
			} catch {
				// Already gone.
			}
			finish({ code: null, signal: 'SIGTERM', aborted: true });
		};
		if (signal !== undefined) {
			if (signal.aborted) {
				onAbort();
				return;
			}
			signal.addEventListener('abort', onAbort, { once: true });
		}
		child.on('error', fail);
		child.on('close', (code, closeSignal) => {
			finish({ code, signal: closeSignal, aborted: false });
		});
		if (input !== undefined) child.stdin.end(input);
		else child.stdin.end();
	});
}

/** Connection facts used to build one `ssh` invocation. */
function sshConnectionArgs(host, config, overrides) {
	const sshConfigPath = overrides.sshConfigPath ?? resolveSshConfigPath(config);
	const args = ['-F', sshConfigPath];
	args.push(
		'-o',
		'BatchMode=yes',
		'-o',
		`ConnectTimeout=${Math.max(1, Math.ceil((overrides.connectTimeoutMs ?? config.connectTimeoutMs) / 1000))}`,
		'-o',
		`StrictHostKeyChecking=${overrides.strictHostKeyChecking ?? host.strictHostKeyChecking ?? 'accept-new'}`,
		'-o',
		'ServerAliveInterval=10',
		'-o',
		'ServerAliveCountMax=3',
	);
	const knownHosts = overrides.userKnownHostsFile ?? host.userKnownHostsFile;
	if (knownHosts !== undefined && knownHosts !== '') {
		args.push('-o', `UserKnownHostsFile=${knownHosts}`);
	}
	args.push('--', host.alias);
	return args;
}

/**
 * Build the full argv for one remote command.
 * @param host - host/alias descriptor.
 * @param config - plugin configuration.
 * @param command - one POSIX shell command string; caller must quote values.
 * @param overrides - per-call config path, timeout and host-key policy.
 */
export function buildSshArgs(host, config, command, overrides = {}) {
	const args = sshConnectionArgs(host, config, overrides);
	if (command !== undefined && command !== '') args.push(command);
	return args;
}

/**
 * Run one remote shell command through OpenSSH.
 * @returns `{ ok, code, stdout, stderr, timedOut, durationMs, error }`.
 */
export async function runRemote(host, config, command, overrides = {}) {
	const args = buildSshArgs(host, config, command, overrides);
	const result = await runProcess(
		config.sshExecutable,
		args,
		{
			timeoutMs: overrides.timeoutMs ?? config.commandTimeoutMs,
			signal: overrides.signal,
			input: overrides.input,
			maxBytes: overrides.maxBytes,
		},
	);
	const ok = result.code === 0 && !result.timedOut && !result.aborted;
	return {
		...result,
		ok,
		error: ok ? undefined : describeSshFailure(result, host.alias),
	};
}

/** Turn an ssh exit into a short, non-sensitive explanation. */
export function describeSshFailure(result, alias) {
	if (result.timedOut) return `ssh ${alias} timed out`;
	if (result.aborted) return `ssh ${alias} was cancelled`;
	const stderr = result.stderr.trim();
	if (stderr !== '') return stderr.split('\n').slice(-3).join(' ');
	return `ssh ${alias} exited with code ${String(result.code)}`;
}

/** Run one remote command and parse stdout as JSON when possible. */
export async function runRemoteJson(host, config, command, overrides = {}) {
	const result = await runRemote(host, config, command, overrides);
	if (!result.ok) return { ...result, value: undefined };
	try {
		return { ...result, value: JSON.parse(result.stdout) };
	} catch {
		return { ...result, value: undefined, parseError: 'remote command did not return JSON' };
	}
}

/** Run one local executable and capture bounded output. */
export async function runLocal(file, args, options = {}) {
	return runProcess(file, args, options);
}

/** Read a local text file without throwing. */
export function readTextIfPresent(file) {
	try {
		return readFileSync(file, 'utf8');
	} catch {
		return undefined;
	}
}
