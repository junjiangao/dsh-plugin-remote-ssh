/**
 * Host-side controller for the remote SSH panel.
 *
 * Owns the managed host list, the generated OpenSSH configuration, per-host
 * helper/profile preparation, and the independent remote-execution windows.
 * Every browser request is a small operation on this controller; no long work
 * happens on the RPC thread without a job and a pollable phase.
 * @module @junjiangao/dsh-plugin-remote-ssh/controller
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { resolveConfig } from './config.js';
import { RemoteSshError, ERROR_CODES, toRemoteSshError } from './errors.js';
import {
	assertPosixHost,
	isPosixHost,
	resolveExecutable,
	resolvePluginPaths,
	resolveRuntime,
} from './paths.js';
import { HostStore } from './store.js';
import {
	ensureManagedInclude,
	parseUserConfig,
	renderHostBlock,
	resolveAlias,
	verifyManagedHosts,
	writeManagedConfig,
} from './ssh-config.js';
import {
	discoverRemoteFacts,
	ensureRemoteDirectory,
	helperInstallCommand,
	inspectHelper,
	installHelper,
	runRemoteScript,
	tail,
} from './helper.js';
import { resolveRemoteNode, runDoctor } from './doctor.js';
import { RuntimeProfile } from './runtime-profile.js';
import { overlayPath, renderOverlay, writeOverlay } from './overlay.js';
import { InstanceManager } from './instance.js';
import { prepareRemoteHome, safeHomeKey } from './remote-home.js';
import { clearPendingSession, isSessionId, writePendingSession } from './pending-session.js';
import { scanRemoteWorkspaces } from './remote-workspaces.js';
import { expandRemotePath, validateHostDraft } from './validate.js';
import { MixedRegistry, mountPathFor, trimPath } from './mixed-registry.js';

/** How long imported host resolution stays fresh, in milliseconds. */
const IMPORTED_TTL_MS = 30_000;
/** Maximum number of imported aliases resolved per refresh. */
const IMPORTED_LIMIT = 64;
/** Parallel `ssh -G` resolutions. */
const IMPORTED_CONCURRENCY = 4;

/** Build an empty snapshot used before the controller has started. */
function emptySnapshot(config) {
	return {
		generatedAt: new Date().toISOString(),
		platform: { supported: isPosixHost(), platform: process.platform },
		settings: {
			sshConfigPath: config.sshConfigPath,
			dataDir: config.dataDir,
			profileName: config.profileName,
			profileDir: '',
			runtimeVersion: '',
			profileReady: false,
			inheritDesktopSettings: config.inheritDesktopSettings,
			mirrorWorkspace: config.mirrorWorkspace,
			helperPackage: config.helperPackage,
			permissionMode: config.permissionMode,
		},
		hosts: [],
		warnings: [],
	};
}

/** One controller instance per plugin mount. */
export class RemoteSshController {
	/**
	 * @param ctx - Cordis context (unused beyond logging, kept for symmetry).
	 * @param rawConfig - Loader row config.
	 * @param options - test overrides: `{ runtime?, profile?, instances? }`.
	 */
	constructor(ctx, rawConfig, options = {}) {
		this.ctx = ctx;
		this.config = resolveConfig(rawConfig);
		this.paths = resolvePluginPaths(this.config);
		this.runtime = options.runtime ?? resolveRuntime();
		this.profile = options.profile ?? new RuntimeProfile(this.config, this.runtime);
		this.profileState = undefined;
		this.profileName = this.config.profileName;
		this.store = new HostStore(this.paths.hostsFile);
		this.instances = options.instances ?? new InstanceManager(this.config, this.runtime, this.paths.instancesDir);
		this.mixedRegistry = new MixedRegistry(this.paths.mixedRegistryFile);
		this.router = undefined;
		this.importedCache = undefined;
		this.importedPromise = undefined;
		this.helperCache = new Map();
		this.jobs = new Map();
		this.helperInstalls = new Map();
		this.warnings = [];
		this.started = false;
		this.disposed = false;
	}

	/** Prepare directories, load the store and clean stale pid records. */
	async start() {
		if (this.started) return;
		await mkdir(this.paths.dataDir, { recursive: true, mode: 0o700 });
		await mkdir(this.paths.instancesDir, { recursive: true, mode: 0o700 });
		await mkdir(this.paths.tmpDir, { recursive: true, mode: 0o700 });
		await this.store.load();
		await this.instances.cleanupStale();
		try {
			this.profileState = await this.profile.inspect();
			this.profileName = this.profileState.name;
		} catch (error) {
			this.warnings.push(`cannot inspect the ${this.config.profileName} profile: ${error.message}`);
		}
		this.started = true;
	}

	/** Stop every child, cancel every job and release mixed execution worlds. */
	async dispose() {
		if (this.disposed) return;
		this.disposed = true;
		for (const job of this.jobs.values()) job.abort.abort();
		await Promise.allSettled([...this.jobs.values()].map((job) => job.promise));
		await this.instances.stopAll();
		await this.router?.dispose();
		this.router = undefined;
	}

	/**
	 * Attach the mixed execution router mounted by the plugin entry.
	 * @param router - the started router, or undefined when mixed mode is off.
	 */
	attachExecutionRouter(router) {
		this.router = router;
	}

	/** Build the complete browser snapshot. */
	async snapshot() {
		const managed = this.store.list();
		const imported = await this.#importedHosts();
		const managedAliases = new Set(managed.map((host) => host.alias));
		const hosts = [];
		for (const host of managed) hosts.push(this.#view(host, 'managed'));
		for (const host of imported.hosts) {
			if (managedAliases.has(host.alias)) continue;
			hosts.push(this.#view(host, 'ssh-config'));
		}
		const warnings = [...this.store.warnings, ...this.warnings, ...imported.errors];
		if (this.runtime.version === '') warnings.push('cannot determine the running DSH version; set sshPackageVersion.');
		if (!isPosixHost()) warnings.push('the official dsh-ssh provider supports POSIX clients only.');
		return {
			generatedAt: new Date().toISOString(),
			platform: { supported: isPosixHost(), platform: process.platform },
			settings: {
				sshConfigPath: this.paths.sshConfigPath,
				dataDir: this.paths.dataDir,
				profileName: this.profileName,
				profileDir: this.profile.dir,
				runtimeVersion: this.config.sshPackageVersion ?? this.runtime.version,
				profileReady: this.profileState?.ready === true,
				inheritDesktopSettings: this.config.inheritDesktopSettings,
				mirrorWorkspace: this.config.mirrorWorkspace,
				helperPackage: this.config.helperPackage,
				permissionMode: this.config.permissionMode,
			},
			hosts,
			warnings: [...new Set(warnings)],
		};
	}

	/** Create or update one managed host. */
	async saveHost(draft) {
		assertPosixHost();
		const previous = this.store.list();
		try {
			const record = await this.store.save(draft);
			await this.#writeAndVerify(this.store.list());
			if (this.instances.ensure(record.id).running) await this.instances.stop(record.id);
			this.helperCache.delete(record.id);
			this.importedCache = undefined;
			await this.#refreshProfileState();
			return { host: this.#view(record, 'managed'), snapshot: await this.snapshot() };
		} catch (error) {
			await this.#rollback(previous, error);
			throw toRemoteSshError(error, 'saving the host failed');
		}
	}

	/** Delete one managed host. */
	async deleteHost(id) {
		assertPosixHost();
		const existing = this.store.get(id);
		if (existing === undefined) throw new RemoteSshError(ERROR_CODES.notFound, `host "${id}" does not exist`);
		const previous = this.store.list();
		try {
			await this.instances.stop(id);
			await this.store.remove(id);
			await this.#writeAndVerify(this.store.list());
			await rm(overlayPath(this.paths.instancesDir, safeFileKey(existing)), { force: true }).catch(() => undefined);
			this.helperCache.delete(id);
			this.importedCache = undefined;
			return { snapshot: await this.snapshot() };
		} catch (error) {
			await this.#rollback(previous, error);
			throw toRemoteSshError(error, 'deleting the host failed');
		}
	}

	/**
	 * Test the connection for one saved host, or for an unsaved draft.
	 * @returns `{ ok, durationMs, stdout, stderr, error }`.
	 */
	async testConnection(payload) {
		assertPosixHost();
		let host;
		let configPath = this.paths.sshConfigPath;
		let temporary;
		if (payload?.draft !== undefined) {
			const draft = validateHostDraft(payload.draft);
			host = { ...draft, id: draft.id ?? 'draft' };
			temporary = join(this.paths.tmpDir, `draft-${randomUUID()}.conf`);
			await mkdir(this.paths.tmpDir, { recursive: true, mode: 0o700 });
			await writeFile(temporary, renderHostBlock({ ...host, remoteWorkspace: undefined }), {
				encoding: 'utf8',
				mode: 0o600,
			});
			configPath = temporary;
		} else {
			if (typeof payload?.id !== 'string') {
				throw new RemoteSshError(ERROR_CODES.validation, 'testConnection needs an id or a draft');
			}
			host = await this.#requireHost(payload.id);
		}
		try {
			const result = await runRemoteScript(host, this.config, 'printf DSH_TEST_OK', {
				sshConfigPath: configPath,
				strictHostKeyChecking: 'accept-new',
				timeoutMs: this.config.commandTimeoutMs,
			});
			return {
				ok: result.ok,
				durationMs: result.durationMs,
				stdout: result.stdout.trim(),
				stderr: tail(result.stderr.trim(), 4_000),
				error: result.error,
			};
		} finally {
			if (temporary !== undefined) await rm(temporary, { force: true }).catch(() => undefined);
		}
	}

	/** Run read-only readiness checks for one host. */
	async doctor(id) {
		assertPosixHost();
		const host = await this.#requireHost(id);
		const result = await runDoctor({
			host,
			config: this.config,
			runtimeVersion: this.config.sshPackageVersion ?? this.runtime.version,
			runtimeProfile: this.profile,
		});
		if (result.facts?.helper !== undefined) {
			const cached = { ...result.facts.helper };
			if (result.facts.remote !== undefined) {
				try {
					cached.installCommand = helperInstallCommand(
						this.config,
						host,
						result.facts.remote.home,
						this.config.sshPackageVersion ?? this.runtime.version,
						result.facts.remote,
					);
				} catch {
					// The view falls back to the package-level command when it cannot be built.
				}
			}
			this.helperCache.set(host.id, cached);
		}
		if (result.facts?.remote !== undefined) {
			try {
				result.installCommand = helperInstallCommand(
					this.config,
					host,
					result.facts.remote.home,
					this.config.sshPackageVersion ?? this.runtime.version,
					result.facts.remote,
				);
			} catch {
				// Optional presentation detail only.
			}
		}
		return result;
	}

	/** Install the remote helper after explicit confirmation. */
	async installHelper(id) {
		assertPosixHost();
		const host = await this.#requireHost(id);
		const facts = await discoverRemoteFacts(host, this.config);
		const result = await this.#installHelperInternal(host, facts);
		return { hostId: host.id, ...result };
	}

	/**
	 * Start the asynchronous open flow.
	 * @returns `{ jobId, snapshot }` immediately; poll `snapshot` for phases.
	 */
	async openHost(id, options = {}) {
		assertPosixHost();
		const host = await this.#requireHost(id);
		const home = join(this.paths.dataDir, 'homes', safeHomeKey(host.id));
		if (options.sessionId === undefined) {
			// A plain open must not replay a marker left by an earlier failed
			// session open; the deeplink would otherwise hijack the new window.
			await clearPendingSession(home).catch(() => undefined);
		} else {
			if (!isSessionId(options.sessionId)) {
				throw new RemoteSshError(ERROR_CODES.validation, 'sessionId is not a valid Session identity');
			}
			// The marker is written before the child starts so the copied
			// deeplink client can claim it as soon as its Connection is live.
			await writePendingSession(home, options.sessionId);
		}
		const existing = this.instances.entries.get(host.id);
		if (existing?.running) {
			return { jobId: undefined, snapshot: await this.snapshot(), reused: true };
		}
		const runningJob = this.jobs.get(host.id);
		if (runningJob !== undefined) {
			return { jobId: runningJob.id, snapshot: await this.snapshot(), reused: true };
		}
		const job = this.#startOpenJob(host, options.allowInstall === true);
		return { jobId: job.id, snapshot: await this.snapshot() };
	}

	/**
	 * Read-only inventory of remote workspaces and their sessions for the
	 * remote-workspace panel. Managed hosts own the isolated homes this scans;
	 * imported ssh-config aliases never started a remote window.
	 * @returns an object with generatedAt, warnings, hosts and runtime phases.
	 */
	async remoteWorkspaces() {
		return await scanRemoteWorkspaces({
			dataDir: this.paths.dataDir,
			hosts: this.store.list().map((host) => ({
				id: host.id,
				alias: host.alias,
				displayName: host.displayName,
				remoteWorkspace: host.remoteWorkspace ?? '~',
			})),
			instanceOf: (hostId) => this.instances.view(hostId),
		});
	}

	/**
	 * Register one remote directory as a workspace of the **current** window.
	 *
	 * This is the Host half of option C. It proves the SSH helper is installed,
	 * creates the remote directory when needed, prepares the local mirror
	 * directory the desktop workspace service will realpath, connects an
	 * isolated SSH execution world, and persists the mirror mapping. The client
	 * then registers the mirror path through the ordinary Workspace API, so the
	 * session, sidebar, and session log machinery stay untouched.
	 * @param id - managed host id.
	 * @param input - `{ remotePath }` (absolute or `~`-prefixed).
	 * @returns the registered mirror workspace.
	 */
	async registerMixedWorkspace(id, input = {}) {
		assertPosixHost();
		if (this.router === undefined) {
			throw new RemoteSshError(ERROR_CODES.remoteUnsupported, 'mixed execution is not active in this Host');
		}
		const host = await this.#requireHost(id);
		const requested = typeof input.remotePath === 'string' && input.remotePath.trim() !== ''
			? input.remotePath.trim()
			: (host.remoteWorkspace ?? '~');
		if (!requested.startsWith('/') && requested !== '~' && !requested.startsWith('~/')) {
			throw new RemoteSshError(ERROR_CODES.validation, 'remotePath must be absolute or start with ~');
		}
		const signal = input.signal;
		const facts = await discoverRemoteFacts(host, this.config, { signal });
		const remotePath = expandRemotePath(requested, facts.home);
		if (typeof remotePath !== 'string' || !remotePath.startsWith('/')) {
			throw new RemoteSshError(ERROR_CODES.validation, 'remotePath must resolve to an absolute remote path');
		}
		const directory = await ensureRemoteDirectory(host, this.config, remotePath, { signal });
		if (!directory.writable) {
			throw new RemoteSshError(ERROR_CODES.remoteUnsupported, `${remotePath} is not writable on ${host.alias}`, {
				hint: '换一个有写权限的远端目录，或修正该目录的远端权限。',
			});
		}
		const helper = await inspectHelper(host, this.config, facts, {
			runtimeVersion: this.runtime.version,
			signal,
		});
		if (helper.status !== 'installed' || helper.path === undefined || helper.hash === undefined) {
			throw new RemoteSshError(ERROR_CODES.helperMissing, `remote helper is not installed on ${host.alias}`, {
				hint: '先在远程 SSH 面板中安装远端服务，再在当前窗口打开远端工作区。',
			});
		}
		const nodePath = resolveRemoteNode(host, this.config, facts);
		await this.profile.ensure({ signal });
		const remote = trimPath(remotePath);
		await this.mixedRegistry.load();
		const existing = this.mixedRegistry.list().find(
			(entry) => entry.hostId === host.id && entry.remotePath === remote,
		);
		const digest = createHash('sha256').update(`${host.id}\u0000${remote}`).digest('hex');
		const mountPath = trimPath(existing?.mountPath ?? mountPathFor(this.paths.mixedMountsDir, host.id, remote, digest));
		await mkdir(mountPath, { recursive: true, mode: 0o700 });
		const entry = {
			id: existing?.id ?? randomUUID(),
			hostId: host.id,
			hostAlias: host.alias,
			remotePath: remote,
			mountPath,
			title: `${host.displayName ?? host.alias} · ${remote}`,
		};
		await this.router.addRemoteWorkspace({
			...entry,
			connection: {
				host: host.alias,
				launch: { kind: 'node-script', node: nodePath },
				helper: helper.path,
				helperHash: helper.hash,
				workspace: remote,
			},
		});
		try {
			await this.mixedRegistry.add(entry);
		} catch (error) {
			this.router.unregisterMount(entry.id);
			throw error;
		}
		return {
			workspace: { ...entry, connected: true },
			created: directory.created,
			mountPath,
		};
	}

	/**
	 * List every registered mirror workspace with its live connection state.
	 * @returns `{ workspaces, registryFile }`.
	 */
	async mixedWorkspaces() {
		await this.mixedRegistry.load();
		const workspaces = [];
		for (const entry of this.mixedRegistry.list()) {
			const state = this.router === undefined
				? { connected: false }
				: await this.router.worldState(entry.hostId).catch(() => ({ connected: false }));
			workspaces.push({ ...entry, connected: state.connected === true });
		}
		return { workspaces, registryFile: this.paths.mixedRegistryFile };
	}

	/**
	 * Forget one mirror workspace and close its host world when it was the last.
	 * The local mirror directory and the ordinary Workspace registration stay in
	 * place; the client removes the Workspace through the standard API so no
	 * dangling registration remains.
	 * @param entryId - registry entry id.
	 * @returns `{ removed: true, hostId }`.
	 */
	async removeMixedWorkspace(entryId) {
		if (typeof entryId !== 'string' || entryId === '') {
			throw new RemoteSshError(ERROR_CODES.validation, 'id is required');
		}
		await this.mixedRegistry.load();
		const entry = this.mixedRegistry.get(entryId);
		if (entry === undefined) throw new RemoteSshError(ERROR_CODES.notFound, 'unknown mixed workspace');
		await this.mixedRegistry.remove(entryId);
		this.router?.unregisterMount(entryId);
		const remaining = this.mixedRegistry.forHost(entry.hostId);
		if (remaining.length === 0) await this.router?.removeHost(entry.hostId);
		return { removed: true, hostId: entry.hostId };
	}

	/** Return the authenticated URL for a running instance. */
	async openUrl(id) {
		assertPosixHost();
		const host = await this.#requireHost(id);
		return { url: this.instances.url(host.id) };
	}

	/** Stop one instance and cancel its in-flight job. */
	async stopHost(id) {
		const host = await this.#requireHost(id).catch(() => undefined);
		const key = host?.id ?? id;
		const job = this.jobs.get(key);
		if (job !== undefined) {
			job.abort.abort();
			await Promise.allSettled([job.promise]);
		}
		await this.instances.stop(key);
		return { snapshot: await this.snapshot() };
	}

	/** Start one open job and keep it pollable. */
	#startOpenJob(host, allowInstall) {
		const id = `job_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
		const abort = new AbortController();
		const job = { id, abort, promise: undefined, error: undefined };
		this.jobs.set(host.id, job);
		job.promise = this.#runOpen(host, allowInstall, abort.signal)
			.catch((error) => {
				const wrapped = toRemoteSshError(error, 'opening the remote host failed');
				job.error = wrapped;
				this.instances.markFailed(host.id, wrapped);
				throw wrapped;
			})
			.finally(() => {
				if (this.jobs.get(host.id) === job) this.jobs.delete(host.id);
			});
		job.promise.catch(() => undefined);
		return job;
	}

	/** The actual open pipeline. */
	async #runOpen(host, allowInstall, signal) {
		if (signal.aborted) throw new RemoteSshError(ERROR_CODES.cancelled, 'open was cancelled');
		this.instances.setPhase(host.id, 'checking', '检查连接与远端服务');
		const doctor = await runDoctor({
			host,
			config: this.config,
			runtimeVersion: this.config.sshPackageVersion ?? this.runtime.version,
			runtimeProfile: this.profile,
			signal,
		});
		const failed = doctor.checks.find((entry) => entry.id === 'ssh' && !entry.ok)
			?? doctor.checks.find((entry) => entry.optional !== true && !entry.ok && entry.id !== 'helper' && !entry.id.startsWith('profile'));
		if (failed !== undefined && failed.id === 'ssh') {
			throw new RemoteSshError(ERROR_CODES.sshFailed, failed.detail ?? 'SSH connection failed', {
				details: { checks: doctor.checks },
			});
		}
		if (doctor.facts.helper !== undefined) {
			const cached = { ...doctor.facts.helper };
			if (doctor.facts.remote !== undefined) {
				try {
					cached.installCommand = helperInstallCommand(
						this.config,
						host,
						doctor.facts.remote.home,
						this.config.sshPackageVersion ?? this.runtime.version,
						doctor.facts.remote,
					);
				} catch {
					// Optional presentation detail only.
				}
			}
			this.helperCache.set(host.id, cached);
		}
		let helper = doctor.facts.helper;
		if (helper?.status !== 'installed') {
			if (!allowInstall) {
				const installCommand = helperInstallCommand(
					this.config,
					host,
					doctor.facts.remote?.home ?? '~',
					this.config.sshPackageVersion ?? this.runtime.version,
					doctor.facts.remote,
				);
				throw new RemoteSshError(
					ERROR_CODES.helperMissing,
					`the remote SSH helper is not installed on ${host.alias}`,
					{
						details: {
							checks: doctor.checks,
							installCommand,
							requiredVersion: this.config.sshPackageVersion ?? this.runtime.version,
						},
					},
				);
			}
			if (failed !== undefined) {
				throw new RemoteSshError(ERROR_CODES.remoteUnsupported, failed.detail ?? `${host.alias} is not ready`, {
					details: { checks: doctor.checks },
				});
			}
			this.instances.setPhase(host.id, 'installing-helper', '安装远端 SSH 服务');
			const facts = doctor.facts.remote;
			if (facts === undefined) throw new RemoteSshError(ERROR_CODES.sshFailed, 'cannot inspect the remote host');
			helper = await this.#installHelperInternal(host, facts, signal);
		}
		if (signal.aborted) throw new RemoteSshError(ERROR_CODES.cancelled, 'open was cancelled');
		this.instances.setPhase(host.id, 'preparing-runtime', '准备本地远端运行时');
		const profile = await this.profile.ensure({ signal });
		this.profileState = profile;
		this.profileName = profile.name;
		const nodePath = resolveRemoteNode(host, this.config, doctor.facts.remote);
		const workspace = doctor.facts.workspace;
		if (workspace === undefined || !workspace.writable) {
			throw new RemoteSshError(ERROR_CODES.remoteUnsupported, `workspace on ${host.alias} is not writable`);
		}
		if (helper?.hash === undefined || !/^[0-9a-f]{64}$/.test(helper.hash)) {
			throw new RemoteSshError(ERROR_CODES.helperInstallFailed, `cannot compute a sha256 for the helper on ${host.alias}`);
		}
		const remoteHome = await prepareRemoteHome({
			dataDir: this.paths.dataDir,
			host,
			profileName: profile.name,
			profileDir: profile.dir,
			workspace: workspace.path,
		});
		const overlay = renderOverlay({
			host,
			workspace: workspace.path,
			nodePath,
			helperPath: helper.path,
			helperHash: helper.hash,
			permissionMode: this.config.permissionMode,
			referencePluginPath: this.profile.remoteReferencePath(),
			// The official auto picker would open a native dialog on this local
			// machine; the copied backend lists the SSH filesystem instead.
			directoryPickerPluginPath: this.profile.remoteDirectoryPickerPath(),
			mirrorWorkspace: this.config.mirrorWorkspace,
			// Session deep links arrive as a Home marker claimed by this client plugin.
			deeplinkEntryPath: this.profile.remoteSessionDeeplinkEntryPath(),
		});
		const file = await writeOverlay(this.paths.instancesDir, safeFileKey(host), overlay);
		const patchPaths = [];
		const desktopPatch = this.profile.desktopPatchPath();
		if (desktopPatch !== undefined) patchPaths.push(desktopPatch);
		patchPaths.push(file);
		if (signal.aborted) throw new RemoteSshError(ERROR_CODES.cancelled, 'open was cancelled');
		this.instances.setPhase(host.id, 'starting', '启动远程窗口');
		await this.instances.start(host, {
			profileName: profile.name,
			patchPaths,
			overlayPath: file,
			dshHome: remoteHome.home,
			cwd: existsSync(workspace.path) ? workspace.path : undefined,
			signal,
		});
		this.helperCache.set(host.id, { status: 'installed', ...helper });
		return { hostId: host.id };
	}

	/** Deduplicated helper installation. */
	async #installHelperInternal(host, facts, signal) {
		const existing = this.helperInstalls.get(host.id);
		if (existing !== undefined) return existing;
		const promise = (async () => {
			this.helperCache.set(host.id, { status: 'installing' });
			const result = await installHelper(host, this.config, facts, {
				runtimeVersion: this.config.sshPackageVersion ?? this.runtime.version,
				signal,
			});
			const state = { status: 'installed', version: result.version, path: result.path, hash: result.hash };
			this.helperCache.set(host.id, state);
			return result;
		})();
		this.helperInstalls.set(host.id, promise);
		try {
			return await promise;
		} finally {
			this.helperInstalls.delete(host.id);
		}
	}

	/** Write the generated fragment, ensure the Include and verify aliases. */
	async #writeAndVerify(hosts) {
		await writeManagedConfig(this.paths.sshConfigFile, hosts);
		const include = await ensureManagedInclude(this.paths.sshConfigPath, this.paths.sshConfigFile);
		if (resolveExecutable(this.config.sshExecutable) === undefined) {
			this.warnings.push(`cannot find the ssh executable "${this.config.sshExecutable}"; skipped alias verification.`);
			return { include, errors: [] };
		}
		const errors = await verifyManagedHosts(this.config, hosts, {
			sshConfigPath: this.paths.sshConfigPath,
			timeoutMs: Math.min(this.config.commandTimeoutMs, 10_000),
		});
		if (errors.length > 0) {
			throw new RemoteSshError(
				ERROR_CODES.conflict,
				'the generated ssh config did not resolve as expected',
				{ details: { errors, backupPath: include.backupPath } },
			);
		}
		return { include, errors };
	}

	/** Restore the previous host list and generated files after a failed write. */
	async #rollback(previous, error) {
		try {
			await this.store.replaceAll(previous);
			await writeManagedConfig(this.paths.sshConfigFile, previous);
			await ensureManagedInclude(this.paths.sshConfigPath, this.paths.sshConfigFile);
		} catch (rollbackError) {
			if (error instanceof Error) {
				error.message += `; rollback also failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`;
			}
		}
		this.importedCache = undefined;
	}

	/** Refresh the cached profile inspection. */
	async #refreshProfileState() {
		try {
			this.profileState = await this.profile.inspect();
			this.profileName = this.profileState.name;
		} catch {
			this.profileState = undefined;
		}
	}

	/** Resolve imported aliases, with a short-lived cache. */
	async #importedHosts() {
		const now = Date.now();
		if (this.importedCache !== undefined && now - this.importedCache.at < IMPORTED_TTL_MS) {
			return this.importedCache;
		}
		if (this.importedPromise !== undefined) {
			if (this.importedCache !== undefined) return this.importedCache;
			return this.importedPromise;
		}
		this.importedPromise = this.#loadImported()
			.then((value) => {
				this.importedCache = value;
				return value;
			})
			.catch((error) => {
				this.importedCache = { at: Date.now(), hosts: [], errors: [error.message] };
				return this.importedCache;
			})
			.finally(() => {
				this.importedPromise = undefined;
			});
		if (this.importedCache !== undefined) return this.importedCache;
		return this.importedPromise;
	}

	/** Parse the user's ssh config and resolve each alias through `ssh -G`. */
	async #loadImported() {
		const parsed = await parseUserConfig(this.paths.sshConfigPath);
		const managedAliases = new Set(this.store.list().map((host) => host.alias));
		const managedFile = this.paths.sshConfigFile;
		const candidates = parsed.aliases
			.filter((entry) => !managedAliases.has(entry.alias) && entry.file !== managedFile)
			.slice(0, IMPORTED_LIMIT);
		const resolved = await mapLimit(candidates, IMPORTED_CONCURRENCY, async (entry) => {
			try {
				const facts = await resolveAlias(this.config, entry.alias, { timeoutMs: 5_000 });
				return {
					id: `ssh-config:${entry.alias}`,
					alias: entry.alias,
					hostname: facts.hostname ?? entry.alias,
					user: facts.user,
					port: facts.port,
					identityFile: facts.identityFile,
					proxyJump: facts.proxyJump,
					proxyCommand: facts.proxyCommand,
					strictHostKeyChecking: facts.strictHostKeyChecking,
					remoteWorkspace: '~',
					resolved: true,
				};
			} catch (error) {
				return {
					id: `ssh-config:${entry.alias}`,
					alias: entry.alias,
					hostname: entry.alias,
					remoteWorkspace: '~',
					resolved: false,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		});
		return { at: Date.now(), hosts: resolved, errors: parsed.errors };
	}

	/** Build one browser-facing host view. */
	#view(host, source) {
		const cached = this.helperCache.get(host.id) ?? { status: 'unknown' };
		const expectedVersion = this.config.sshPackageVersion ?? this.runtime.version;
		let installCommand = cached.installCommand;
		if (installCommand === undefined) {
			try {
				installCommand = expectedVersion === undefined || expectedVersion === ''
					? undefined
					: helperInstallCommand(this.config, host, '~', expectedVersion);
			} catch {
				installCommand = undefined;
			}
		}
		return {
			id: host.id,
			source,
			alias: host.alias,
			displayName: host.displayName,
			description: host.description,
			hostname: host.hostname,
			user: host.user,
			port: host.port,
			identityFile: host.identityFile,
			proxyJump: host.proxyJump,
			proxyCommand: host.proxyCommand,
			identitiesOnly: host.identitiesOnly,
			forwardAgent: host.forwardAgent,
			serverAliveInterval: host.serverAliveInterval,
			serverAliveCountMax: host.serverAliveCountMax,
			strictHostKeyChecking: host.strictHostKeyChecking,
			userKnownHostsFile: host.userKnownHostsFile,
			connectionAttempts: host.connectionAttempts,
			connectTimeout: host.connectTimeout,
			extraOptions: host.extraOptions ?? [],
			remoteWorkspace: host.remoteWorkspace ?? '~',
			remoteHelperRoot: host.remoteHelperRoot,
			shadowed: false,
			helper: {
				status: cached.status ?? 'unknown',
				version: cached.version,
				path: cached.path,
				expectedVersion,
				hash: cached.hash,
				installCommand,
			},
			instance: this.instances.view(host.id),
			editable: source === 'managed',
			createdAt: host.createdAt,
			updatedAt: host.updatedAt,
			...(host.resolved === false ? { resolutionError: host.error } : {}),
		};
	}

	/** Find a managed or imported host by id. */
	async #requireHost(id) {
		if (typeof id !== 'string' || id === '') throw new RemoteSshError(ERROR_CODES.validation, 'host id is required');
		const managed = this.store.get(id);
		if (managed !== undefined) return managed;
		let imported = await this.#importedHosts();
		let host = imported.hosts.find((candidate) => candidate.id === id);
		if (host === undefined) {
			imported = await this.#loadImported();
			this.importedCache = imported;
			host = imported.hosts.find((candidate) => candidate.id === id);
		}
		if (host === undefined) throw new RemoteSshError(ERROR_CODES.notFound, `host "${id}" does not exist`);
		return host;
	}
}

/** Map one async function over items with bounded concurrency. */
async function mapLimit(items, limit, mapper) {
	const results = new Array(items.length);
	let next = 0;
	const workers = new Array(Math.min(limit, items.length)).fill(undefined).map(async () => {
		while (next < items.length) {
			const index = next;
			next += 1;
			results[index] = await mapper(items[index], index);
		}
	});
	await Promise.all(workers);
	return results;
}

/** Safe file-name key for one host id. */
function safeFileKey(host) {
	return String(host.id).replace(/[^A-Za-z0-9_.-]/g, '_');
}

/** Re-export for tests. */
export { emptySnapshot };
