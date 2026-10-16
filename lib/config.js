/**
 * Configuration schema and normalization for the remote-ssh bundle.
 *
 * {@link Config} is the schemastery schema the Loader validates a plugin row's
 * `config` against. {@link resolveConfig} additionally normalizes a partial or
 * hand-written config into the fully-defaulted shape the tools consume, so
 * `apply()` behaves identically when it receives `{}`, an already validated
 * config, or a directly constructed object.
 * @module @junjiangao/dsh-plugin-remote-ssh/config
 */
import z from '@deepseek-ai/schemastery';

/** Default budget for establishing one SSH connection, in milliseconds. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 15000;
/** Default hard timeout for one remote command or transfer, in milliseconds. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 120000;
/** Default cap applied to each captured output stream, in bytes. */
export const DEFAULT_MAX_OUTPUT_BYTES = 262144;
/** Accepted `StrictHostKeyChecking` values, in OpenSSH spelling. */
export const STRICT_HOST_KEY_CHECKING = ['accept-new', 'yes', 'no'];
/** Default host-key policy: trust a host the first time, then pin it. */
export const DEFAULT_STRICT_HOST_KEY_CHECKING = 'accept-new';

/** One configured host entry: everything needed to build an OpenSSH target. */
const HostEntry = z
	.object({
		name: z.string().required().description('Unique name the tools accept as `host` (for example `prod-web`).'),
		hostname: z.string().required().description('Hostname or IP address OpenSSH connects to.'),
		user: z.string().description('Login user; when set, the target becomes `user@hostname`.'),
		port: z.natural().description('SSH port; omit to use the OpenSSH default or the `~/.ssh/config` value.'),
		identityFile: z.string().description('Private key path passed to ssh/scp as `-i`.'),
		proxyJump: z.string().description('Bastion passed as `-J` in `[user@]host[:port]` form.'),
		description: z.string().description('Human-readable note reported by `ssh_hosts`.'),
		defaultCwd: z.string().description('Remote directory to `cd` into when a call does not pass `cwd`.'),
		extraOptions: z.array(z.string()).default([]).description('Extra raw options appended to every ssh/scp invocation.'),
	})
	.description('One pre-configured remote host.');

/**
 * Loader-facing configuration schema for this bundle. Every field has a default
 * so the row activates with `config: {}`.
 */
export const Config = z.object({
	hosts: z.array(HostEntry).default([]).description('Pre-configured hosts addressable by name. Raw OpenSSH targets work without any entry here.'),
	connectTimeoutMs: z.number().default(DEFAULT_CONNECT_TIMEOUT_MS).description('Connection timeout passed to OpenSSH, in milliseconds.'),
	commandTimeoutMs: z.number().default(DEFAULT_COMMAND_TIMEOUT_MS).description('Default hard timeout for one command or transfer, in milliseconds.'),
	maxOutputBytes: z.number().default(DEFAULT_MAX_OUTPUT_BYTES).description('Maximum captured bytes per output stream before truncation.'),
	strictHostKeyChecking: z.union(STRICT_HOST_KEY_CHECKING).default(DEFAULT_STRICT_HOST_KEY_CHECKING).description('OpenSSH StrictHostKeyChecking policy.'),
	allowedHosts: z.array(z.string()).default([]).description('Permitted targets; empty allows any. Each entry matches a target exactly or as a simple `*` glob.'),
	sshExecutable: z.string().default('ssh').description('ssh executable name or path.'),
	scpExecutable: z.string().default('scp').description('scp executable name or path.'),
});

/** Read one optional non-empty string, treating blank input as absent. */
function optionalString(value, label) {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'string') throw new Error(`remote-ssh: ${label} must be a string`);
	const trimmed = value.trim();
	return trimmed.length === 0 ? undefined : trimmed;
}

/** Read one required non-empty string. */
function requiredString(value, label) {
	const text = optionalString(value, label);
	if (text === undefined) throw new Error(`remote-ssh: ${label} must be a non-empty string`);
	return text;
}

/** Read one positive finite number, falling back to `fallback`. */
function positiveNumber(value, fallback, label) {
	if (value === undefined || value === null) return fallback;
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
		throw new Error(`remote-ssh: ${label} must be a positive finite number`);
	}
	return value;
}

/** Read one positive integer, falling back to `fallback`. */
function positiveInteger(value, fallback, label) {
	const resolved = positiveNumber(value, fallback, label);
	if (!Number.isInteger(resolved)) throw new Error(`remote-ssh: ${label} must be a positive integer`);
	return resolved;
}

/** Normalize the optional string-array fields of one host entry. */
function optionalStringArray(value, label) {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) throw new Error(`remote-ssh: ${label} must be an array of strings`);
	return value.map((entry, index) => requiredString(entry, `${label}[${index}]`));
}

/** Normalize one configured host entry, rejecting malformed or duplicate names. */
function normalizeHost(raw, index, seenNames) {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new Error(`remote-ssh: hosts[${index}] must be an object`);
	}
	const label = `hosts[${index}]`;
	const name = requiredString(raw.name, `${label}.name`);
	const hostname = requiredString(raw.hostname, `${label}.hostname`);
	if (seenNames.has(name)) throw new Error(`remote-ssh: duplicate configured host name ${JSON.stringify(name)}`);
	seenNames.add(name);
	const user = optionalString(raw.user, `${label}.user`);
	const identityFile = optionalString(raw.identityFile, `${label}.identityFile`);
	const proxyJump = optionalString(raw.proxyJump, `${label}.proxyJump`);
	const description = optionalString(raw.description, `${label}.description`);
	const defaultCwd = optionalString(raw.defaultCwd, `${label}.defaultCwd`);
	let port;
	if (raw.port !== undefined && raw.port !== null) {
		port = positiveInteger(raw.port, undefined, `${label}.port`);
		if (port > 65535) throw new Error(`remote-ssh: ${label}.port must be at most 65535`);
	}
	return {
		name,
		hostname,
		...(user !== undefined ? { user } : {}),
		...(port !== undefined ? { port } : {}),
		...(identityFile !== undefined ? { identityFile } : {}),
		...(proxyJump !== undefined ? { proxyJump } : {}),
		...(description !== undefined ? { description } : {}),
		...(defaultCwd !== undefined ? { defaultCwd } : {}),
		extraOptions: optionalStringArray(raw.extraOptions, `${label}.extraOptions`),
	};
}

/** Normalize the configured host list. */
function normalizeHosts(raw) {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) throw new Error('remote-ssh: hosts must be an array of host objects');
	const seenNames = new Set();
	return raw.map((entry, index) => normalizeHost(entry, index, seenNames));
}

/** Normalize the allowedHosts list. */
function normalizeAllowedHosts(raw) {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) throw new Error('remote-ssh: allowedHosts must be an array of strings');
	return raw.map((entry, index) => requiredString(entry, `allowedHosts[${index}]`));
}

/**
 * Resolve a raw config into the complete shape the tools use.
 *
 * The schema already applies these defaults at activation; this function keeps
 * direct callers (tests, embedded use) working and turns malformed values into
 * clear configuration errors instead of confusing runtime failures.
 * @param raw - the plugin row's config, possibly partial.
 * @returns the normalized config.
 */
export function resolveConfig(raw) {
	const source = raw === null || typeof raw !== 'object' || Array.isArray(raw) ? {} : raw;
	const strictHostKeyChecking = source.strictHostKeyChecking ?? DEFAULT_STRICT_HOST_KEY_CHECKING;
	if (!STRICT_HOST_KEY_CHECKING.includes(strictHostKeyChecking)) {
		throw new Error(`remote-ssh: strictHostKeyChecking must be one of ${STRICT_HOST_KEY_CHECKING.map((value) => JSON.stringify(value)).join(', ')}`);
	}
	return {
		hosts: normalizeHosts(source.hosts),
		connectTimeoutMs: positiveNumber(source.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS, 'connectTimeoutMs'),
		commandTimeoutMs: positiveNumber(source.commandTimeoutMs, DEFAULT_COMMAND_TIMEOUT_MS, 'commandTimeoutMs'),
		maxOutputBytes: positiveInteger(source.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 'maxOutputBytes'),
		strictHostKeyChecking,
		allowedHosts: normalizeAllowedHosts(source.allowedHosts),
		sshExecutable: optionalString(source.sshExecutable, 'sshExecutable') ?? 'ssh',
		scpExecutable: optionalString(source.scpExecutable, 'scpExecutable') ?? 'scp',
	};
}
