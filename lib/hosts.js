/**
 * Target resolution and the `allowedHosts` guard.
 *
 * A `host` argument is any OpenSSH target: a configured entry name, an
 * ssh_config alias, `user@hostname`, or a bare hostname/IP. Only a configured
 * name expands to explicit options; every other target is passed through
 * verbatim so OpenSSH resolves it from its own configuration.
 * @module @local/dsh-plugin-remote-ssh/hosts
 */
import { resolveExecutable } from './shell.js';

/** Escape every regular-expression metacharacter of one glob pattern. */
function escapeRegExp(pattern) {
	return pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Compile one `allowedHosts` entry: an exact match or a simple `*` glob. */
function globToRegExp(pattern) {
	return new RegExp(`^${escapeRegExp(pattern).replace(/\\\*/g, '.*')}$`);
}

/**
 * Resolve the model-supplied `host` into the exact OpenSSH target and options.
 * @param config - normalized plugin config.
 * @param host - configured name, ssh_config alias, `user@hostname`, or bare host.
 * @returns the resolved target plus the options a configured entry contributes.
 */
export function resolveTarget(config, host) {
	if (typeof host !== 'string' || host.trim().length === 0) {
		throw new Error('remote-ssh: host must be a non-empty string');
	}
	const name = host.trim();
	const entry = config.hosts.find((candidate) => candidate.name === name);
	if (entry === undefined) {
		return { host: name, target: name, extraOptions: [], configured: false };
	}
	const target = entry.user === undefined ? entry.hostname : `${entry.user}@${entry.hostname}`;
	return {
		host: name,
		target,
		extraOptions: entry.extraOptions,
		configured: true,
		...(entry.port !== undefined ? { port: entry.port } : {}),
		...(entry.identityFile !== undefined ? { identityFile: entry.identityFile } : {}),
		...(entry.proxyJump !== undefined ? { proxyJump: entry.proxyJump } : {}),
		...(entry.defaultCwd !== undefined ? { defaultCwd: entry.defaultCwd } : {}),
		...(entry.description !== undefined ? { description: entry.description } : {}),
	};
}

/**
 * Whether a target is permitted by `allowedHosts`.
 *
 * An empty list allows everything. Otherwise the given `host` or the resolved
 * target must match one entry exactly or through a simple `*` glob
 * (for example `*.internal.example.com`).
 * @param config - normalized plugin config.
 * @param host - the model-supplied host argument.
 * @param target - the resolved OpenSSH target.
 * @returns whether the call may proceed.
 */
export function isTargetAllowed(config, host, target) {
	if (config.allowedHosts.length === 0) return true;
	return config.allowedHosts.some((pattern) => {
		const matcher = globToRegExp(pattern);
		return matcher.test(host) || matcher.test(target);
	});
}

/**
 * Reject a target the deployment did not permit.
 * @param config - normalized plugin config.
 * @param host - the model-supplied host argument.
 * @param target - the resolved OpenSSH target.
 */
export function assertTargetAllowed(config, host, target) {
	if (isTargetAllowed(config, host, target)) return;
	const allowed = config.allowedHosts.map((pattern) => JSON.stringify(pattern)).join(', ');
	throw new Error(`remote-ssh: host ${JSON.stringify(host)} (target ${JSON.stringify(target)}) is not permitted by allowedHosts [${allowed}]; add a matching entry to the remote-ssh config to allow it`);
}

/**
 * Resolve the configured ssh executable to an absolute path when possible.
 * @param config - normalized plugin config.
 * @returns the absolute path, or null when the executable is not on PATH.
 */
export function resolveSshExecutable(config) {
	return resolveExecutable(config.sshExecutable);
}
