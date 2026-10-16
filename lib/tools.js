/**
 * The four model-facing SSH tools.
 *
 * Each tool resolves a host, builds an OpenSSH command line, runs it through
 * {@link runProcess}, and returns a bounded, structured result. Argument and
 * permission failures throw a plain `Error` (the tool registry turns it into a
 * structured error result); transport failures are reported in the result
 * itself, never as an unhandled rejection.
 * @module @local/dsh-plugin-remote-ssh/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { assertTargetAllowed, resolveSshExecutable, resolveTarget } from './hosts.js';
import { buildScpArgv, buildSshArgv, composeRemoteScript, runProcess } from './shell.js';

/** Extra budget above ConnectTimeout for one `ssh_hosts` probe. */
const PROBE_TIMEOUT_SLACK_MS = 5000;
/** Output cap for one `ssh_hosts` probe; probes only need a diagnostic line. */
const PROBE_MAX_OUTPUT_BYTES = 8192;
/** Longest failure summary reported by `ssh_hosts` per host. */
const ERROR_SUMMARY_MAX_CHARS = 300;

/** Shared statement of the raw-target capability, reported by `ssh_hosts`. */
const NOTE_RAW_TARGETS =
	'Raw OpenSSH targets (an ssh_config alias, user@hostname, or a bare hostname/IP) are accepted by ssh_exec, ssh_upload, and ssh_download without a configured entry.';

/** A required nullable integer node; a fresh object per use keeps the DSL compiler happy. */
function nullableInteger() {
	return { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] };
}

/** A required nullable string node. */
function nullableString() {
	return { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] };
}

/** Require a non-empty string argument, keeping the original text. */
function requireNonEmpty(value, label) {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new Error(`remote-ssh: ${label} must be a non-empty string`);
	}
	return value;
}

/** Resolve a per-call timeout, falling back to the configured default. */
function resolveTimeoutMs(value, fallback) {
	if (value === undefined || value === null) return fallback;
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
		throw new Error('remote-ssh: timeoutMs must be a positive number of milliseconds');
	}
	return value;
}

/** The resolved OpenSSH target string for one configured entry. */
function entryTarget(entry) {
	return entry.user === undefined ? entry.hostname : `${entry.user}@${entry.hostname}`;
}

/** One short diagnostic line describing a failed probe. */
function summarizeFailure(result) {
	if (result.timedOut) return `probe timed out after ${result.durationMs}ms`;
	const line = result.stderr
		.split('\n')
		.map((candidate) => candidate.trim())
		.find((candidate) => candidate.length > 0);
	if (line !== undefined) {
		return line.length > ERROR_SUMMARY_MAX_CHARS ? `${line.slice(0, ERROR_SUMMARY_MAX_CHARS)}...` : line;
	}
	return result.exitCode === null ? 'ssh could not be started' : `ssh exited with code ${result.exitCode}`;
}

/** Probe one configured host with a short non-interactive `true` command. */
async function probeHost(config, entry, signal) {
	const argv = buildSshArgv({
		executable: config.sshExecutable,
		port: entry.port,
		identityFile: entry.identityFile,
		proxyJump: entry.proxyJump,
		connectTimeoutMs: config.connectTimeoutMs,
		strictHostKeyChecking: config.strictHostKeyChecking,
		extraOptions: entry.extraOptions,
		target: entryTarget(entry),
		remoteScript: 'true',
		pty: false,
	});
	const startedAt = Date.now();
	const result = await runProcess({
		file: argv[0],
		args: argv.slice(1),
		timeoutMs: config.connectTimeoutMs + PROBE_TIMEOUT_SLACK_MS,
		signal,
		maxOutputBytes: Math.min(config.maxOutputBytes, PROBE_MAX_OUTPUT_BYTES),
	});
	const latencyMs = Date.now() - startedAt;
	if (result.exitCode === 0) return { reachable: true, latencyMs };
	return { reachable: false, latencyMs, error: summarizeFailure(result) };
}

/** Render the `ssh_hosts` result as bounded text. */
function renderHosts(_args, value) {
	const lines = [];
	lines.push(`ssh executable: ${value.sshExecutable}${value.resolvedSshExecutable === null ? ' (not found on PATH)' : ` (resolved: ${value.resolvedSshExecutable})`}`);
	lines.push(`allowedHosts: ${value.allowedHosts.length === 0 ? 'any target allowed' : value.allowedHosts.join(', ')}`);
	lines.push(value.note);
	if (value.hosts.length === 0) {
		lines.push('Configured hosts: none.');
		return [{ type: 'text', text: lines.join('\n') }];
	}
	lines.push(`Configured hosts: ${value.hosts.length}`);
	for (const host of value.hosts) {
		const details = [];
		if (host.description !== undefined) details.push(host.description);
		if (host.reachable === true) details.push(`reachable in ${host.latencyMs ?? 0}ms`);
		else if (host.reachable === false) details.push(`unreachable: ${host.error ?? 'unknown error'}`);
		lines.push(`- ${host.name} -> ${host.target}${details.length > 0 ? ` (${details.join('; ')})` : ''}`);
	}
	return [{ type: 'text', text: lines.join('\n') }];
}

/** Render an `ssh_exec` result as bounded text. */
function renderExec(_args, value) {
	const status = value.timedOut
		? `timed out after ${value.durationMs}ms and was killed`
		: value.exitCode === null
			? value.signal === null
				? 'did not start'
				: `was killed by ${value.signal}`
			: `exited with code ${value.exitCode}`;
	const lines = [`ssh ${value.host} (${value.target}) ${status} in ${value.durationMs}ms.`];
	if (value.timedOut) {
		lines.push('Only the local ssh client was terminated; the remote command may still be running on the remote host, so re-check the remote host before assuming it stopped.');
	}
	if (value.truncated) lines.push(`Output was truncated at the configured maxOutputBytes per stream.`);
	lines.push(`stdout:\n${value.stdout.length > 0 ? value.stdout : '(empty)'}`);
	lines.push(`stderr:\n${value.stderr.length > 0 ? value.stderr : '(empty)'}`);
	return [{ type: 'text', text: lines.join('\n') }];
}

/** Render a transfer result as bounded text. */
function renderTransfer(verb) {
	return (_args, value) => {
		const status = value.exitCode === null ? 'did not complete' : `exited with code ${value.exitCode}`;
		const lines = [`${verb} ${value.localPath} ${verb === 'Uploaded' ? 'to' : 'from'} ${value.host}:${value.remotePath} (${status}, ${value.durationMs}ms).`];
		if (value.stderr.length > 0) lines.push(`stderr:\n${value.stderr}`);
		return [{ type: 'text', text: lines.join('\n') }];
	};
}

/** Append a timeout diagnostic to a transfer's captured stderr. */
function transferStderr(result, timeoutMs) {
	if (!result.timedOut) return result.stderr;
	const note = `remote-ssh: transfer timed out after ${timeoutMs}ms and was killed`;
	return result.stderr.length > 0 ? `${result.stderr}\n${note}` : note;
}

/** The `ssh_hosts` tool: inventory plus optional reachability check. */
function createHostsTool(config) {
	return defineTool({
		name: 'ssh_hosts',
		description: `List the SSH hosts configured for this session, and optionally check that each is reachable. ${NOTE_RAW_TARGETS}`,
		parameters: {
			check: {
				type: 'boolean',
				description: 'Probe every configured host with a short non-interactive command and report reachability and latency. Defaults to false.',
			},
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					sshExecutable: { type: 'string', required: true },
					resolvedSshExecutable: nullableString(),
					acceptsRawTargets: { type: 'boolean', required: true },
					note: { type: 'string', required: true },
					allowedHosts: { type: 'array', required: true, items: { type: 'string' } },
					hosts: {
						type: 'array',
						required: true,
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								name: { type: 'string', required: true },
								hostname: { type: 'string', required: true },
								target: { type: 'string', required: true },
								user: { type: 'string' },
								port: { type: 'integer' },
								description: { type: 'string' },
								reachable: { type: 'boolean' },
								latencyMs: { type: 'integer' },
								error: { type: 'string' },
							},
						},
					},
				},
			},
			render: renderHosts,
		},
		presentCall: () => ({ card: 'generic', title: 'List SSH hosts', kind: 'other', rawInput: 'ssh_hosts' }),
		async execute(args, exec) {
			const hosts = config.hosts.map((entry) => ({
				name: entry.name,
				hostname: entry.hostname,
				target: entryTarget(entry),
				...(entry.user !== undefined ? { user: entry.user } : {}),
				...(entry.port !== undefined ? { port: entry.port } : {}),
				...(entry.description !== undefined ? { description: entry.description } : {}),
			}));
			if (args.check === true) {
				for (let index = 0; index < hosts.length; index += 1) {
					const probe = await probeHost(config, config.hosts[index], exec?.signal);
					hosts[index] = { ...hosts[index], ...probe };
				}
			}
			return {
				sshExecutable: config.sshExecutable,
				resolvedSshExecutable: resolveSshExecutable(config),
				acceptsRawTargets: true,
				note: NOTE_RAW_TARGETS,
				allowedHosts: [...config.allowedHosts],
				hosts,
			};
		},
	});
}

/** The `ssh_exec` tool: run one command on a remote host. */
function createExecTool(config) {
	return defineTool({
		name: 'ssh_exec',
		description:
			'Run a shell command on a remote host over SSH and return its exit code, stdout, and stderr. The command runs through the remote login shell; the connection is non-interactive, so it never prompts for a password or host-key confirmation.',
		parameters: {
			host: {
				type: 'string',
				required: true,
				description: 'Configured host name, ssh_config alias, user@hostname, or bare hostname/IP.',
			},
			command: {
				type: 'string',
				required: true,
				description: 'Command to run on the remote host through its login shell.',
			},
			cwd: {
				type: 'string',
				description: 'Remote directory to cd into before running the command; overrides the configured defaultCwd.',
			},
			env: {
				type: 'object',
				additionalProperties: true,
				description: 'Environment variables exported before the command; keys must be valid POSIX names and values must be strings.',
			},
			timeoutMs: {
				type: 'number',
				description: 'Hard timeout for this call in milliseconds; defaults to the configured commandTimeoutMs. The command is killed when it expires.',
			},
			pty: {
				type: 'boolean',
				description: 'Allocate a remote pseudo-terminal for commands that need a TTY. Defaults to false.',
			},
			stdin: {
				type: 'string',
				description: 'Text written to the remote command standard input.',
			},
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					host: { type: 'string', required: true },
					target: { type: 'string', required: true },
					exitCode: nullableInteger(),
					signal: nullableString(),
					stdout: { type: 'string', required: true },
					stderr: { type: 'string', required: true },
					durationMs: { type: 'integer', required: true },
					timedOut: { type: 'boolean', required: true },
					truncated: { type: 'boolean', required: true },
				},
			},
			render: renderExec,
		},
		presentCall: (args) => ({ card: 'generic', title: `ssh ${args.host}`, kind: 'other', rawInput: args.command }),
		async execute(args, exec) {
			const resolved = resolveTarget(config, args.host);
			assertTargetAllowed(config, args.host, resolved.target);
			const command = requireNonEmpty(args.command, 'command');
			const timeoutMs = resolveTimeoutMs(args.timeoutMs, config.commandTimeoutMs);
			const remoteScript = composeRemoteScript({
				cwd: args.cwd ?? resolved.defaultCwd,
				env: args.env,
				command,
			});
			const argv = buildSshArgv({
				executable: config.sshExecutable,
				port: resolved.port,
				identityFile: resolved.identityFile,
				proxyJump: resolved.proxyJump,
				connectTimeoutMs: config.connectTimeoutMs,
				strictHostKeyChecking: config.strictHostKeyChecking,
				extraOptions: resolved.extraOptions,
				target: resolved.target,
				remoteScript,
				pty: args.pty === true,
			});
			const result = await runProcess({
				file: argv[0],
				args: argv.slice(1),
				timeoutMs,
				input: args.stdin,
				signal: exec?.signal,
				maxOutputBytes: config.maxOutputBytes,
			});
			return {
				host: resolved.host,
				target: resolved.target,
				exitCode: result.exitCode,
				signal: result.signal,
				stdout: result.stdout,
				stderr: result.stderr,
				durationMs: result.durationMs,
				timedOut: result.timedOut,
				truncated: result.truncated,
			};
		},
	});
}

/** Build either transfer tool; both share the host options and the result shape. */
function createTransferTool(config, direction) {
	const upload = direction === 'upload';
	return defineTool({
		name: upload ? 'ssh_upload' : 'ssh_download',
		description: upload
			? 'Copy a local file or directory to a remote host over SSH (scp). The connection is non-interactive, so it never prompts for a password or host-key confirmation.'
			: 'Copy a file or directory from a remote host to the local machine over SSH (scp). The connection is non-interactive, so it never prompts for a password or host-key confirmation.',
		parameters: {
			host: {
				type: 'string',
				required: true,
				description: 'Configured host name, ssh_config alias, user@hostname, or bare hostname/IP.',
			},
			localPath: {
				type: 'string',
				required: true,
				description: upload ? 'Local source path, relative to the harness process working directory or absolute.' : 'Local destination path, relative to the harness process working directory or absolute.',
			},
			remotePath: {
				type: 'string',
				required: true,
				description: upload ? 'Destination path on the remote host, interpreted by the remote side.' : 'Source path on the remote host, interpreted by the remote side.',
			},
			recursive: {
				type: 'boolean',
				description: 'Transfer directories recursively. Defaults to false.',
			},
			timeoutMs: {
				type: 'number',
				description: 'Hard timeout for this transfer in milliseconds; defaults to the configured commandTimeoutMs. The transfer is killed when it expires.',
			},
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					host: { type: 'string', required: true },
					localPath: { type: 'string', required: true },
					remotePath: { type: 'string', required: true },
					exitCode: nullableInteger(),
					stderr: { type: 'string', required: true },
					durationMs: { type: 'integer', required: true },
				},
			},
			render: renderTransfer(upload ? 'Uploaded' : 'Downloaded'),
		},
		presentCall: (args) => ({
			card: 'generic',
			title: upload ? `scp ${args.localPath} -> ${args.host}` : `scp ${args.host}:${args.remotePath} -> ${args.localPath}`,
			kind: 'other',
			rawInput: args.remotePath,
		}),
		async execute(args, exec) {
			const resolved = resolveTarget(config, args.host);
			assertTargetAllowed(config, args.host, resolved.target);
			const localPath = requireNonEmpty(args.localPath, 'localPath');
			const remotePath = requireNonEmpty(args.remotePath, 'remotePath');
			const timeoutMs = resolveTimeoutMs(args.timeoutMs, config.commandTimeoutMs);
			const remote = `${resolved.target}:${remotePath}`;
			const argv = buildScpArgv({
				executable: config.scpExecutable,
				port: resolved.port,
				identityFile: resolved.identityFile,
				proxyJump: resolved.proxyJump,
				connectTimeoutMs: config.connectTimeoutMs,
				strictHostKeyChecking: config.strictHostKeyChecking,
				extraOptions: resolved.extraOptions,
				recursive: args.recursive === true,
				source: upload ? localPath : remote,
				destination: upload ? remote : localPath,
			});
			const result = await runProcess({
				file: argv[0],
				args: argv.slice(1),
				timeoutMs,
				signal: exec?.signal,
				maxOutputBytes: config.maxOutputBytes,
			});
			return {
				host: resolved.host,
				localPath,
				remotePath,
				exitCode: result.exitCode,
				stderr: transferStderr(result, timeoutMs),
				durationMs: result.durationMs,
			};
		},
	});
}

/**
 * Register all four tools on `ctx.tools`.
 * @param ctx - context whose `tools` registry receives the registrations.
 * @param config - normalized plugin config.
 */
export function registerRemoteSshTools(ctx, config) {
	ctx.tools.register(createHostsTool(config));
	ctx.tools.register(createExecTool(config));
	ctx.tools.register(createTransferTool(config, 'upload'));
	ctx.tools.register(createTransferTool(config, 'download'));
}
