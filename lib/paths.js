/**
 * Filesystem, runtime and executable discovery for the Host half.
 *
 * All user-configurable paths go through here so `~` expansion, DSH home
 * resolution, profile directories, bundled CLI and bundled pnpm are solved the
 * same way for the controller, tests and verification scripts.
 * @module @junjiangao/dsh-plugin-remote-ssh/paths
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import { RemoteSshError, ERROR_CODES } from './errors.js';

/** Expand a leading `~` or `~/` against the current user's home directory. */
export function expandHome(value, home = homedir()) {
	if (typeof value !== 'string') return value;
	if (value === '~') return home;
	if (value.startsWith('~/')) return join(home, value.slice(2));
	return value;
}

/** Resolve the DSH home from the environment, matching the Harness default. */
export function resolveDshHome(env = process.env) {
	return env.DSH_HOME !== undefined && env.DSH_HOME !== '' ? env.DSH_HOME : join(homedir(), '.dsh');
}

/** Resolve the user's OpenSSH config path. */
export function resolveSshConfigPath(config) {
	return expandHome(config.sshConfigPath);
}

/** Resolve the plugin-owned data directory. */
export function resolveDataDir(config) {
	return expandHome(config.dataDir);
}

/** Every fixed path inside the plugin data directory. */
export function resolvePluginPaths(config) {
	const dataDir = resolveDataDir(config);
	return {
		dataDir,
		hostsFile: join(dataDir, 'hosts.json'),
		sshConfigFile: join(dataDir, 'ssh_config'),
		instancesDir: join(dataDir, 'instances'),
		tmpDir: join(dataDir, 'tmp'),
		mixedDir: join(dataDir, 'mixed'),
		mixedRegistryFile: join(dataDir, 'mixed', 'workspaces.json'),
		mixedMountsDir: join(dataDir, 'mixed', 'mounts'),
		sshConfigPath: resolveSshConfigPath(config),
		profileDir: resolveProfileDir(config),
	};
}

/** Resolve a profile directory under the DSH home. */
export function resolveProfileDir(config, home = resolveDshHome()) {
	return join(home, 'profiles', config.profileName);
}

/** Whether the local host can run the official POSIX SSH client stack. */
export function isPosixHost() {
	return process.platform === 'linux' || process.platform === 'darwin';
}

/** Resolve one executable name to an absolute path, or `undefined`. */
export function resolveExecutable(name, env = process.env) {
	if (typeof name !== 'string' || name === '') return undefined;
	if (name.includes('/') || name.includes('\\')) return existsSync(name) ? name : undefined;
	const pathValue = env.PATH ?? env.Path ?? '';
	for (const directory of pathValue.split(':')) {
		if (directory === '') continue;
		const candidate = join(directory, name);
		try {
			if (existsSync(candidate)) return candidate;
		} catch {
			// Ignore unreadable PATH entries.
		}
	}
	return undefined;
}

/** Read one package manifest, returning `undefined` when absent or invalid. */
function readManifest(file) {
	try {
		return JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		return undefined;
	}
}

/**
 * Resolve the running DSH runtime: version, bundled CLI wrapper, bundled pnpm
 * and the Node executable that starts subprocesses.
 *
 * Desktop passes its runtime facts as argv entries to the Host process; the
 * ordinary CLI has a different argv. Every source is tried so the plugin works
 * in both compositions.
 * @param env - process environment.
 * @returns runtime facts, with `version` empty when discovery failed.
 */
export function resolveRuntime(env = process.env, argv = process.argv) {
	const result = {
		version: '',
		runtimeDir: '',
		cliPath: '',
		cliArgs: [],
		pnpmPath: '',
		pnpmArgs: [],
		nodePath: process.execPath,
		nodeBinDir: dirname(process.execPath),
		isDesktop: false,
	};
	// Desktop host argv: [node, entry, runtimeDir, projectDir, primaryRuntime, pnpm, nodeBin]
	if (argv[2] !== undefined && isAbsolute(argv[2]) && existsSync(join(argv[2], 'package.json'))) {
		const manifest = readManifest(join(argv[2], 'package.json'));
		if (manifest !== undefined && typeof manifest.name === 'string' && manifest.name.includes('dsh')) {
			result.runtimeDir = argv[2];
			result.isDesktop = true;
		}
	}
	if (result.runtimeDir === '') {
		const entry = argv[1] ?? '';
		const marker = 'app.asar.unpacked';
		const index = entry.indexOf(`${marker}/dsh`);
		if (index !== -1) result.runtimeDir = resolve(entry.slice(0, index + marker.length), 'dsh');
		else if (entry.includes('node_modules/@deepseek-ai/dsh/')) {
			result.runtimeDir = entry.slice(0, entry.indexOf('node_modules/@deepseek-ai/dsh/'));
		}
	}
	if (result.runtimeDir !== '') {
		const dshManifest = readManifest(join(result.runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
			?? readManifest(join(result.runtimeDir, 'package.json'));
		if (dshManifest?.version) result.version = dshManifest.version;
	}
	// Bundled CLI wrapper: <resources>/runtime/cli/bin/dsh. Desktop-host argv
	// points at the unpacked runtime directory rather than the Node binary, so
	// also derive the resources root from runtimeDir when necessary.
	const resources = resolve(dirname(process.execPath), '..', '..');
	const wrapper = join(resources, 'runtime', 'cli', 'bin', 'dsh');
	if (existsSync(wrapper)) result.cliPath = wrapper;
	else if (result.runtimeDir !== '') {
		const desktopWrapper = resolve(result.runtimeDir, '..', '..', 'runtime', 'cli', 'bin', 'dsh');
		if (existsSync(desktopWrapper)) result.cliPath = desktopWrapper;
	}
	// pnpm: desktop argv entry, then the primary-runtime reference, then PATH.
	if (argv[5] !== undefined && /pnpm(\.mjs|\.cjs|\.js)?$/.test(argv[5]) && existsSync(argv[5])) {
		result.pnpmPath = argv[5];
		if (argv[6] !== undefined && existsSync(argv[6])) {
			let stats;
			try {
				stats = statSync(argv[6]);
			} catch {
				stats = undefined;
			}
			if (stats?.isDirectory() === true) {
				// Desktop host argv[6] is the Node bin directory, not the Node file.
				result.nodeBinDir = argv[6];
				const bundledNode = join(argv[6], basename(process.execPath));
				result.nodePath = existsSync(bundledNode) ? bundledNode : process.execPath;
			} else {
				result.nodePath = argv[6];
				result.nodeBinDir = dirname(argv[6]);
			}
		}
	}
	if (result.pnpmPath === '') {
		const localRuntimeFile = join(resources, 'runtime', 'local-runtime.json');
		const localRuntime = readManifest(localRuntimeFile);
		if (typeof localRuntime?.source === 'string') {
			const candidate = join(localRuntime.source, 'dependencies', 'pnpm', 'bin', 'pnpm.mjs');
			if (existsSync(candidate)) result.pnpmPath = candidate;
		}
	}
	if (result.pnpmPath === '') {
		const runtimesRoot = join(homedir(), '.local', 'share', 'deepseek-harness', 'runtimes');
		try {
			const candidates = readdirSync(runtimesRoot)
				.map((name) => join(runtimesRoot, name, 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'))
				.filter((candidate) => existsSync(candidate));
			if (candidates.length > 0) result.pnpmPath = candidates[candidates.length - 1];
		} catch {
			// No local runtime directory.
		}
	}
	if (result.pnpmPath === '') {
		const pnpm = resolveExecutable('pnpm', env);
		if (pnpm !== undefined) {
			result.pnpmPath = pnpm;
			result.pnpmArgs = [];
		}
	}
	if (result.pnpmPath !== '' && result.pnpmPath.endsWith('.mjs')) {
		result.pnpmArgs = [result.pnpmPath];
		result.pnpmPath = result.nodePath;
	}
	if (result.version === '' && env.DSH_VERSION !== undefined) result.version = env.DSH_VERSION;
	return result;
}

/** Assert that the local host can run the official SSH stack. */
export function assertPosixHost() {
	if (isPosixHost()) return;
	throw new RemoteSshError(
		ERROR_CODES.remoteUnsupported,
		`remote SSH requires a Linux or macOS host; this process runs on ${process.platform}`,
		{ hint: 'The official dsh-ssh provider family supports POSIX clients only.' },
	);
}

/** Stable, readable identity for a directory (used for stale-instance checks). */
export function canonicalPath(value) {
	try {
		return realpathSync(value);
	} catch {
		return resolve(value);
	}
}

/** Normalize a path for display without resolving it against the host filesystem. */
export function displayPath(value) {
	return basename(value) === value ? value : value;
}
