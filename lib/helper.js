/**
 * Remote helper discovery and provisioning.
 *
 * The official `@deepseek-ai/dsh-ssh` provider launches a versioned POSIX
 * helper on the remote host. This module discovers the remote platform, Node,
 * npm and the helper installation, then installs the exact runtime version on
 * explicit user confirmation.
 * @module @junjiangao/dsh-plugin-remote-ssh/helper
 */
import { mkdir } from 'node:fs/promises';
import { expandRemotePath } from './validate.js';
import { quote, runRemote } from './ssh.js';
import { RemoteSshError, ERROR_CODES } from './errors.js';

/** Minimum Node version accepted for the remote helper. */
export const NODE_MINIMUM = '22.19.0';

/** Run one POSIX script on the remote host through `/bin/sh -c`. */
export async function runRemoteScript(host, config, script, options = {}) {
	return runRemote(host, config, `/bin/sh -c ${quote(script)}`, {
		strictHostKeyChecking: 'accept-new',
		...options,
	});
}

/** Discover platform, home, Node and npm facts. */
export async function discoverRemoteFacts(host, config, options = {}) {
	const script = [
		// Non-interactive SSH sessions do not load the user's shell rc files, so
		// fnm/nvm/volta installations are often absent from PATH. Fall back to
		// their conventional locations before declaring Node/npm missing.
		'if [ -z "$(command -v node 2>/dev/null)" ] || [ -z "$(command -v npm 2>/dev/null)" ]; then',
		'  for dir in "$HOME/.local/share/fnm/aliases/default/bin" "$HOME/.local/share/fnm/node-versions"/*/installation/bin "$HOME/.nvm/current/bin" "$HOME/.nvm/versions/node"/*/bin "$HOME/.volta/bin" "$HOME/.local/bin" "/opt/homebrew/bin" "/usr/local/bin"; do',
		'    if [ -x "$dir/node" ] && [ -x "$dir/npm" ]; then PATH="$dir:$PATH"; export PATH; break; fi',
		'  done',
		'fi',
		'printf "DSH_PLATFORM=%s\\n" "$(uname -s 2>/dev/null)"',
		'printf "DSH_HOME=%s\\n" "$HOME"',
		'printf "DSH_NODE=%s\\n" "$(command -v node 2>/dev/null)"',
		'printf "DSH_NODE_VERSION=%s\\n" "$(node -p "process.versions.node" 2>/dev/null)"',
		'printf "DSH_NPM=%s\\n" "$(command -v npm 2>/dev/null)"',
		'printf "DSH_NPM_VERSION=%s\\n" "$(npm --version 2>/dev/null)"',
	].join('\n');
	const result = await runRemoteScript(host, config, script, {
		...options,
		timeoutMs: options.timeoutMs ?? Math.max(config.commandTimeoutMs, 15_000),
	});
	if (!result.ok) {
		throw new RemoteSshError(ERROR_CODES.sshFailed, result.error ?? `cannot inspect ${host.alias}`);
	}
	const values = {};
	for (const line of result.stdout.split(/\r?\n/)) {
		const index = line.indexOf('=');
		if (index > 0) values[line.slice(0, index)] = line.slice(index + 1).trim();
	}
	const facts = {
		platform: values.DSH_PLATFORM ?? '',
		home: values.DSH_HOME ?? '',
		nodePath: values.DSH_NODE || undefined,
		nodeVersion: values.DSH_NODE_VERSION || undefined,
		npmPath: values.DSH_NPM || undefined,
		npmVersion: values.DSH_NPM_VERSION || undefined,
	};
	if (facts.home === '') {
		throw new RemoteSshError(ERROR_CODES.remoteUnsupported, `cannot determine the home directory on ${host.alias}`);
	}
	if (facts.platform !== 'Linux' && facts.platform !== 'Darwin') {
		throw new RemoteSshError(
			ERROR_CODES.remoteUnsupported,
			`${host.alias} runs ${facts.platform || 'an unknown platform'}; only Linux and macOS remotes are supported`,
		);
	}
	return facts;
}

/** Parse a Node version into comparable numbers. */
export function parseNodeVersion(value) {
	if (typeof value !== 'string') return undefined;
	const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
	if (match === null) return undefined;
	return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** Apply the supported Node range: `^22.19.0 || >=24.0.0`. */
export function isSupportedNode(value) {
	const version = parseNodeVersion(value);
	if (version === undefined) return false;
	if (version.major === 22) {
		if (version.minor > 19) return true;
		return version.minor === 19 && version.patch >= 0;
	}
	return version.major >= 24;
}

/** Absolute remote paths for one helper installation. */
export function helperPaths(config, host, remoteHome, version) {
	const root = expandRemotePath(host.remoteHelperRoot ?? config.helperRoot, remoteHome);
	const versionDir = `${root}/${version}`;
	const packageDir = `${versionDir}/node_modules/${config.helperPackage}`;
	return {
		root,
		versionDir,
		packageDir,
		entry: `${packageDir}/lib/helper.js`,
		manifest: `${packageDir}/package.json`,
	};
}

/** Human-readable install command shown in the confirmation dialog. */
export function helperInstallCommand(config, host, remoteHome, version, remote) {
	const paths = helperPaths(config, host, remoteHome, version);
	const registry = config.npmRegistry === undefined ? '' : ` --registry ${quote(config.npmRegistry)}`;
	const npm = typeof remote?.npmPath === 'string' && remote.npmPath !== '' ? quote(remote.npmPath) : 'npm';
	const nodePath = config.remoteNode ?? remote?.nodePath;
	const nodeDir = typeof nodePath === 'string' && nodePath.includes('/')
		? nodePath.slice(0, nodePath.lastIndexOf('/'))
		: undefined;
	const prefix = nodeDir === undefined ? '' : `PATH=${quote(nodeDir)}:$PATH `;
	return `${prefix}${npm} install --prefix ${quote(paths.versionDir)} --no-audit --no-fund --omit=dev${registry} ${quote(`${config.helperPackage}@${version}`)}`;
}

/**
 * Inspect an existing helper installation.
 * @returns `{ status, version, hash, path, expectedVersion }`; `status` is
 * `installed`, `missing` or `mismatch`.
 */
export async function inspectHelper(host, config, facts, options = {}) {
	const expectedVersion = config.sshPackageVersion ?? options.runtimeVersion;
	if (expectedVersion === undefined || expectedVersion === '') {
		return { status: 'unknown', path: undefined, expectedVersion: undefined };
	}
	const paths = helperPaths(config, host, facts.home, expectedVersion);
	const script = [
		`if [ -f ${quote(paths.manifest)} ] && [ -f ${quote(paths.entry)} ]; then`,
		'  printf "DSH_INSTALLED=1\\n"',
		`  cat ${quote(paths.manifest)}`,
		'else',
		'  printf "DSH_INSTALLED=0\\n"',
		'fi',
	].join('\n');
	const result = await runRemoteScript(host, config, script, options);
	if (!result.ok) {
		throw new RemoteSshError(ERROR_CODES.sshFailed, result.error ?? `cannot inspect the helper on ${host.alias}`);
	}
	if (!result.stdout.startsWith('DSH_INSTALLED=1')) {
		return { status: 'missing', path: paths.entry, expectedVersion };
	}
	const manifestText = result.stdout.slice('DSH_INSTALLED=1\n'.length);
	let manifest;
	try {
		manifest = JSON.parse(manifestText);
	} catch {
		return { status: 'mismatch', version: undefined, path: paths.entry, expectedVersion };
	}
	const version = typeof manifest.version === 'string' ? manifest.version : undefined;
	const hash = await helperHash(host, config, paths.entry, options);
	return {
		status: version === expectedVersion ? 'installed' : 'mismatch',
		version,
		hash,
		path: paths.entry,
		expectedVersion,
	};
}

/** Compute the remote sha256 of the helper entry. */
export async function helperHash(host, config, entry, options = {}) {
	const script = [
		`if command -v sha256sum >/dev/null 2>&1; then sha256sum ${quote(entry)};`,
		`elif command -v shasum >/dev/null 2>&1; then shasum -a 256 ${quote(entry)};`,
		'else printf "DSH_NO_HASH\\n"; fi',
	].join('\n');
	const result = await runRemoteScript(host, config, script, options);
	if (!result.ok) return undefined;
	const first = result.stdout.trim().split(/\s+/)[0] ?? '';
	return /^[0-9a-f]{64}$/i.test(first) ? first.toLowerCase() : undefined;
}

/**
 * Install the helper for one host. Caller must have shown the command and
 * obtained explicit confirmation.
 * @returns `{ version, path, hash, command, log }`.
 */
export async function installHelper(host, config, facts, options = {}) {
	const version = config.sshPackageVersion ?? options.runtimeVersion;
	if (version === undefined || version === '') {
		throw new RemoteSshError(
			ERROR_CODES.helperInstallFailed,
			'cannot determine the DSH runtime version for the remote helper',
			{ hint: 'Set sshPackageVersion in the plugin config.' },
		);
	}
	if (facts.npmPath === undefined) {
		throw new RemoteSshError(
			ERROR_CODES.helperInstallFailed,
			`npm was not found on ${host.alias}`,
			{ hint: 'Install Node.js and npm on the remote host, then retry.' },
		);
	}
	const paths = helperPaths(config, host, facts.home, version);
	const registry = config.npmRegistry === undefined ? '' : ` --registry ${quote(config.npmRegistry)}`;
	const nodePath = config.remoteNode ?? facts.nodePath;
	const nodeDir = typeof nodePath === 'string' && nodePath.includes('/')
		? nodePath.slice(0, nodePath.lastIndexOf('/'))
		: undefined;
	const pathPrefix = nodeDir === undefined ? '' : `PATH=${quote(nodeDir)}:$PATH `;
	const npm = typeof facts.npmPath === 'string' && facts.npmPath !== '' ? quote(facts.npmPath) : 'npm';
	const script = [
		`mkdir -p ${quote(paths.versionDir)}`,
		`chmod 700 ${quote(paths.versionDir)} 2>/dev/null || true`,
		`${pathPrefix}${npm} install --prefix ${quote(paths.versionDir)} --no-audit --no-fund --omit=dev${registry} ${quote(`${config.helperPackage}@${version}`)}`,
	].join('\n');
	const result = await runRemoteScript(host, config, script, {
		...options,
		timeoutMs: options.timeoutMs ?? config.installTimeoutMs,
		maxBytes: 512 * 1024,
	});
	const log = tail(`${result.stdout}${result.stderr}`, 6_000);
	if (!result.ok) {
		throw new RemoteSshError(
			ERROR_CODES.helperInstallFailed,
			`installing ${config.helperPackage}@${version} on ${host.alias} failed`,
			{ details: { command: helperInstallCommand(config, host, facts.home, version, facts), log } },
		);
	}
	const state = await inspectHelper(host, config, facts, { ...options, runtimeVersion: version });
	if (state.status !== 'installed') {
		throw new RemoteSshError(
			ERROR_CODES.helperInstallFailed,
			`helper installation on ${host.alias} did not produce a matching ${version} installation`,
			{ details: { log } },
		);
	}
	return {
		version,
		path: state.path,
		hash: state.hash,
		command: helperInstallCommand(config, host, facts.home, version, facts),
		log,
	};
}

/** Resolve and create the remote workspace. */
export async function prepareRemoteWorkspace(host, config, facts, options = {}) {
	const requested = host.remoteWorkspace ?? '~';
	const workspace = expandRemotePath(requested, facts.home);
	const script = [
		`if [ ! -d ${quote(workspace)} ]; then mkdir -p ${quote(workspace)} && printf "DSH_CREATED=1\\n" || { printf "DSH_CREATED=0\\n"; exit 1; };`,
		'else printf "DSH_CREATED=0\\n"; fi',
		`if [ -w ${quote(workspace)} ]; then printf "DSH_WRITABLE=1\\n"; else printf "DSH_WRITABLE=0\\n"; fi`,
	].join('\n');
	const result = await runRemoteScript(host, config, script, options);
	if (!result.ok) {
		throw new RemoteSshError(
			ERROR_CODES.sshFailed,
			`cannot prepare workspace ${workspace} on ${host.alias}`,
			{ details: { stderr: tail(result.stderr, 2_000) } },
		);
	}
	return {
		requested,
		path: workspace,
		created: result.stdout.includes('DSH_CREATED=1'),
		writable: result.stdout.includes('DSH_WRITABLE=1'),
	};
}

/** Create the local mirror directory used by workspace attach validation. */
export async function prepareLocalMirror(workspace) {
	try {
		await mkdir(workspace, { recursive: true, mode: 0o700 });
		return { path: workspace, ok: true };
	} catch (error) {
		return { path: workspace, ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Create one remote directory when it is missing and prove it is writable.
 *
 * Mixed mode registers an arbitrary remote directory as a workspace, not just
 * the host's configured `remoteWorkspace`, so the helper needs the same
 * best-effort creation and permission check for a caller-supplied path.
 * @param host - managed host record.
 * @param config - resolved plugin configuration.
 * @param directory - absolute remote directory.
 * @param options - timeout/cancellation overrides.
 * @returns `{ directory, created, writable }`.
 */
export async function ensureRemoteDirectory(host, config, directory, options = {}) {
	const script = [
		`if [ ! -d ${quote(directory)} ]; then`,
		`  if ! mkdir -p ${quote(directory)} 2>/dev/null; then printf "DSH_CREATE_FAILED=1\\n"; exit 1; fi`,
		'  printf "DSH_CREATED=1\\n"',
		'else printf "DSH_CREATED=0\\n"; fi',
		`if [ -w ${quote(directory)} ]; then printf "DSH_WRITABLE=1\\n"; else printf "DSH_WRITABLE=0\\n"; fi`,
	].join('\n');
	const result = await runRemoteScript(host, config, script, {
		...options,
		timeoutMs: options.timeoutMs ?? Math.max(config.commandTimeoutMs, 15_000),
	});
	if (!result.ok) {
		throw new RemoteSshError(ERROR_CODES.sshFailed, result.error ?? `cannot prepare ${directory} on ${host.alias}`, {
			details: { stderr: tail(result.stderr, 2_000) },
		});
	}
	return {
		directory,
		created: result.stdout.includes('DSH_CREATED=1'),
		writable: result.stdout.includes('DSH_WRITABLE=1'),
	};
}

/** Keep the last `limit` characters of a log. */
export function tail(text, limit) {
	if (typeof text !== 'string' || text.length <= limit) return text;
	return text.slice(text.length - limit);
}
