/**
 * Local DSH profile that supplies the official SSH provider family.
 *
 * The official providers are composition-scoped singletons: exactly one remote
 * host per booted profile. This module prepares a dedicated profile once, then
 * the controller boots it with a per-host overlay (`--patch`). The profile is
 * plugin-owned and never reuses the desktop profile directory.
 * @module @junjiangao/dsh-plugin-remote-ssh/runtime-profile
 */
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDshHome, resolveProfileDir } from './paths.js';
import { runProcess } from './ssh.js';
import { RemoteSshError, ERROR_CODES } from './errors.js';
import { tail } from './helper.js';

/** Marker proving the profile directory is owned by this plugin. */
export const PROFILE_MARKER = '.dsh-remote-ssh-profile.json';
/** Marker file contents version. */
export const PROFILE_FORMAT = 1;
/** Copied remote `@file` provider; loaded by an absolute path from the overlay. */
export const REMOTE_REFERENCE_FILE = 'remote-file-reference.mjs';
/** Copied remote directory-picker backend; loaded by an absolute path from the overlay. */
export const REMOTE_DIRECTORY_PICKER_FILE = 'remote-directory-picker.mjs';
/** Copied one-shot Session deeplink package directory inside the profile. */
export const REMOTE_SESSION_DEEPLINK_DIR = 'remote-session-deeplink';
/** Files copied for the Session deeplink package (host half, browser half, manifest). */
export const REMOTE_SESSION_DEEPLINK_FILES = ['package.json', 'index.js', 'client.js'];
/** Source of the copied `@file` provider inside this package. */
const REMOTE_REFERENCE_SOURCE = fileURLToPath(new URL('./remote-reference.js', import.meta.url));
/** Source of the copied directory-picker backend inside this package. */
const REMOTE_DIRECTORY_PICKER_SOURCE = fileURLToPath(new URL('./remote-directory-picker.js', import.meta.url));
/** Source directory of the copied Session deeplink client package. */
const REMOTE_SESSION_DEEPLINK_SOURCE = fileURLToPath(new URL('../runtime/remote-session-deeplink/', import.meta.url));
/** Official provider packages installed into the profile. */
export const SSH_PACKAGES = [
	'@deepseek-ai/dsh-ssh',
	'@deepseek-ai/dsh-fs-ssh',
	'@deepseek-ai/dsh-subprocess-ssh',
	'@deepseek-ai/dsh-sandbox-ssh',
];

/** Read one JSON file, returning `undefined` when absent or invalid. */
async function readJson(file) {
	try {
		return JSON.parse(await readFile(file, 'utf8'));
	} catch {
		return undefined;
	}
}

/** Render the profile manifest. */
function renderProfilePackageJson(version) {
	return `${JSON.stringify(
		{
			name: 'dsh-profile-dsh-remote',
			private: true,
			type: 'module',
			dependencies: Object.fromEntries(SSH_PACKAGES.map((name) => [name, version])),
			dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
		},
		null,
		2,
	)}\n`;
}

/** Render the pnpm workspace settings used by the other DSH profiles. */
function renderWorkspaceYaml() {
	return `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
minimumReleaseAgeExclude:
${SSH_PACKAGES.map((name) => `  - '${name}'`).join('\n')}
`;
}

/** One prepared-profile manager. */
export class RuntimeProfile {
	/**
	 * @param config - resolved plugin config.
	 * @param runtime - facts from `resolveRuntime()`.
	 * @param options - `{ dshHome?, dryRun? }`.
	 */
	constructor(config, runtime, options = {}) {
		this.config = config;
		this.runtime = runtime;
		this.dshHome = options.dshHome ?? resolveDshHome();
		this.dryRun = options.dryRun === true;
		this.dir = resolveProfileDir(config, this.dshHome);
		this.name = config.profileName;
		this.version = config.sshPackageVersion ?? runtime.version;
		this.ensurePromise = undefined;
		this.lastError = undefined;
	}

	/** Absolute path of the copied remote file-reference provider. */
	remoteReferencePath() {
		return join(this.dir, REMOTE_REFERENCE_FILE);
	}

	/** Absolute path of the copied remote directory-picker backend. */
	remoteDirectoryPickerPath() {
		return join(this.dir, REMOTE_DIRECTORY_PICKER_FILE);
	}

	/** Absolute path of the copied Session deeplink package directory. */
	remoteSessionDeeplinkDir() {
		return join(this.dir, 'plugins', REMOTE_SESSION_DEEPLINK_DIR);
	}

	/** Absolute path of the copied Session deeplink Host entry the overlay loads. */
	remoteSessionDeeplinkEntryPath() {
		return join(this.remoteSessionDeeplinkDir(), 'index.js');
	}

	/** Desktop user patch applied to every remote instance when inheritance is enabled. */
	desktopPatchPath() {
		if (!this.config.inheritDesktopSettings) return undefined;
		const file = join(this.dshHome, 'profiles', 'desktop', 'cordis.patch.yml');
		return existsSync(file) ? file : undefined;
	}

	/** Inspect the profile without changing anything. */
	async inspect() {
		const marker = await readJson(join(this.dir, PROFILE_MARKER));
		const owned = marker?.owner === '@junjiangao/dsh-plugin-remote-ssh';
		const packages = {};
		for (const name of SSH_PACKAGES) {
			const manifest = await readJson(join(this.dir, 'node_modules', ...name.split('/'), 'package.json'));
			packages[name] = typeof manifest?.version === 'string' ? manifest.version : undefined;
		}
		const missing = SSH_PACKAGES.filter((name) => packages[name] === undefined);
		const mismatched = this.version === '' || this.version === undefined
			? []
			: SSH_PACKAGES.filter((name) => packages[name] !== undefined && packages[name] !== this.version);
		return {
			dir: this.dir,
			name: this.name,
			version: this.version,
			exists: existsSync(this.dir),
			owned,
			marker: marker ?? undefined,
			packages,
			missing,
			mismatched,
			ready: owned && missing.length === 0 && mismatched.length === 0,
		};
	}

	/** Prepare the profile idempotently; concurrent callers share one install. */
	async ensure(options = {}) {
		if (this.ensurePromise !== undefined) return this.ensurePromise;
		this.ensurePromise = this.#ensure(options).finally(() => {
			this.ensurePromise = undefined;
		});
		return this.ensurePromise;
	}

	async #ensure(options) {
		if (this.version === '' || this.version === undefined) {
			throw new RemoteSshError(
				ERROR_CODES.profileInstallFailed,
				'cannot determine the DSH runtime version needed by the SSH provider packages',
				{ hint: 'Set sshPackageVersion in the plugin config.' },
			);
		}
		await this.#resolveOwnedDirectory();
		await this.#writeFiles();
		const before = await this.inspect();
		if (before.ready) return { ...before, installed: false, log: '' };
		if (this.dryRun) {
			throw new RemoteSshError(ERROR_CODES.profileInstallFailed, 'profile preparation is disabled in dry-run mode');
		}
		const log = await this.#install(options);
		const after = await this.inspect();
		if (!after.ready) {
			throw new RemoteSshError(
				ERROR_CODES.profileInstallFailed,
				`the ${this.name} profile is missing the official SSH packages after installation`,
				{
					details: {
						missing: after.missing,
						mismatched: after.mismatched,
						log: tail(log, 6_000),
					},
				},
			);
		}
		return { ...after, installed: true, log: tail(log, 6_000) };
	}

	/** Pick an owned directory, or a deterministic fallback when the name is taken. */
	async #resolveOwnedDirectory() {
		const base = resolveProfileDir(this.config, this.dshHome);
		const candidates = [base, `${base}-plugin`, `${base}-plugin-2`, `${base}-plugin-3`, `${base}-plugin-4`];
		for (const candidate of candidates) {
			try {
				const info = await stat(candidate);
				if (!info.isDirectory()) continue;
			} catch (error) {
				if (error?.code !== 'ENOENT') throw error;
				this.dir = candidate;
				this.name = basename(candidate);
				return;
			}
			const marker = await readJson(join(candidate, PROFILE_MARKER));
			if (marker?.owner === '@junjiangao/dsh-plugin-remote-ssh') {
				this.dir = candidate;
				this.name = basename(candidate);
				return;
			}
		}
		throw new RemoteSshError(
			ERROR_CODES.conflict,
			`cannot create the ${this.config.profileName} profile: every candidate directory already exists and is not owned by this plugin`,
			{ hint: 'Remove or rename the conflicting profile directories, or change profileName.' },
		);
	}

	/** Write the manifest, workspace settings and marker. */
	async #writeFiles() {
		await mkdir(this.dir, { recursive: true, mode: 0o700 });
		const packageFile = join(this.dir, 'package.json');
		const current = await readFile(packageFile, 'utf8').catch(() => undefined);
		const next = renderProfilePackageJson(this.version);
		if (current !== next) await writeFile(packageFile, next, { encoding: 'utf8', mode: 0o600 });
		const workspaceFile = join(this.dir, 'pnpm-workspace.yaml');
		if (!existsSync(workspaceFile)) await writeFile(workspaceFile, renderWorkspaceYaml(), { encoding: 'utf8', mode: 0o600 });
		const patchFile = join(this.dir, 'cordis.patch.yml');
		if (!existsSync(patchFile)) await writeFile(patchFile, '[]\n', { encoding: 'utf8', mode: 0o600 });
		const markerFile = join(this.dir, PROFILE_MARKER);
		const marker = {
			owner: '@junjiangao/dsh-plugin-remote-ssh',
			format: PROFILE_FORMAT,
			packageVersion: this.version,
			createdAt: new Date().toISOString(),
		};
		await writeFile(markerFile, `${JSON.stringify(marker, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
		// Both copies are loaded by absolute path from the per-host overlay:
		// the profile only declares the official SSH packages, so these plugin
		// sources must live inside the profile directory to be importable.
		await copyFile(REMOTE_REFERENCE_SOURCE, this.remoteReferencePath());
		await copyFile(REMOTE_DIRECTORY_PICKER_SOURCE, this.remoteDirectoryPickerPath());
		await this.#copySessionDeeplink();
	}

	/** Copy the one-shot Session deeplink package into the profile, atomically per file. */
	async #copySessionDeeplink() {
		const directory = this.remoteSessionDeeplinkDir();
		await mkdir(directory, { recursive: true, mode: 0o700 });
		for (const file of REMOTE_SESSION_DEEPLINK_FILES) {
			const target = join(directory, file);
			// Write beside the target and rename: a concurrently booting remote
			// window must never import a half-written plugin file.
			const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
			await copyFile(join(REMOTE_SESSION_DEEPLINK_SOURCE, file), temporary);
			await rename(temporary, target);
		}
	}

	/** Run the bundled pnpm install, offline-first. */
	async #install(options) {
		const logs = [];
		const attempts = [
			['install', '--config.minimumReleaseAge=0', '--prefer-offline'],
			['install', '--config.minimumReleaseAge=0'],
		];
		for (const args of attempts) {
			const command = this.#pnpmCommand();
			const env = { ...process.env };
			if (this.config.npmRegistry !== undefined) env.npm_config_registry = this.config.npmRegistry;
			const result = await runProcess(command.file, [...command.args, ...args], {
				cwd: this.dir,
				timeoutMs: this.config.installTimeoutMs,
				signal: options.signal,
				maxBytes: 512 * 1024,
				env,
			});
			logs.push(`$ ${command.file} ${[...command.args, ...args].join(' ')}\n${result.stdout}${result.stderr}`);
			if (result.code === 0 && !result.timedOut) return logs.join('\n');
		}
		throw new RemoteSshError(
			ERROR_CODES.profileInstallFailed,
			`installing the official SSH provider packages into ${this.dir} failed`,
			{
				details: {
					dir: this.dir,
					log: tail(logs.join('\n'), 8_000),
				},
				hint: 'Check registry access, the running DSH version, and pnpm output above.',
			},
		);
	}

	/** Build the node/pnpm invocation. */
	#pnpmCommand() {
		if (this.runtime.pnpmPath === '') {
			throw new RemoteSshError(
				ERROR_CODES.profileInstallFailed,
				'cannot locate the bundled pnpm executable',
				{ hint: 'Run the plugin from the official DSH distribution, or install pnpm on PATH.' },
			);
		}
		return { file: this.runtime.pnpmPath, args: [...this.runtime.pnpmArgs] };
	}
}
