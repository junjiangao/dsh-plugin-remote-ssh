/**
 * Mixed local/remote execution router.
 *
 * [Option C] keeps one DSH desktop window for both local and remote
 * workspaces. The official SSH family was designed as an **entire composition
 * swap**: it mounts `ctx.fs`, `ctx.subprocess`, and `ctx.sandbox` in a
 * dedicated process. This module keeps that property but moves the swap down
 * one level: every execution world (the local machine and one SSH host per
 * remote workspace) is mounted inside its own **isolated Cordis context**, and
 * a single router provides the three global services by dispatching each call
 * to the world that owns it.
 *
 * Routing inputs:
 * - **Mount paths**: every remote workspace is registered under a local mirror
 *   directory (see `mixed-registry.js`). Workspace and session cwds are these
 *   mirror paths, so a path prefix is a reliable discriminator even when the
 *   remote home directory happens to equal the local one.
 * - **Ambient world** (`AsyncLocalStorage`): a `tools/execute` wrapper records
 *   the world of the calling session so capability calls that carry no cwd
 *   (`resolveExecutable`, `terminalEnvironment`, absolute remote paths written
 *   by the model) dispatch correctly.
 * - **cwd**: subprocess spawns always carry a cwd, so their world follows it.
 *
 * The local world mounts the official `dsh-fs-sandbox` / `dsh-subprocess-local`
 * / `dsh-sandbox-local` providers unchanged, preserving local behaviour. A
 * remote world mounts `dsh-ssh` plus the three SSH providers in an isolated
 * child scope, exactly like the official remote profile composes them.
 *
 * @module @junjiangao/dsh-plugin-remote-ssh/execution-router
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync } from 'node:fs';
import { isAbsolute, join, posix } from 'node:path';
import process from 'node:process';
import { ensureMixedRuntime, loadRuntimeModules } from './mixed-runtime.js';

/** Ambient execution world of the current tool call. */
export const ambientWorld = new AsyncLocalStorage();

/**
 * Normalize the ambient store into `{ world, cwd }`.
 *
 * Earlier probes stored a bare world; accepting both keeps the routing core
 * usable without an AsyncLocalStorage writer.
 * @param value - stored value.
 * @returns the record, or undefined outside a tool call.
 */
function ambientEntry(value) {
	if (value === undefined || value === null) return undefined;
	return value.world === undefined ? { world: value, cwd: undefined } : value;
}

/** Marker property used to attach a world to a returned `FsTarget`. */
const TARGET_WORLD = Symbol('dsh.mixed.targetWorld');

/** Fallback ownership map for targets that cannot carry a symbol. */
const targetWorlds = new WeakMap();

/** Normalize one absolute POSIX path (both local and remote paths are POSIX here). */
export function normalizePath(value) {
	return posix.normalize(value);
}

/** Whether `child` is `parent` or lives below it. */
export function isUnder(parent, child) {
	return child === parent || child.startsWith(`${parent}/`);
}

/** Resolve a possibly relative path against one absolute base. */
export function resolvePath(base, value) {
	return isAbsolute(value) ? normalizePath(value) : posix.resolve(base, value);
}

/** Attach world ownership to a filesystem target. */
function tagTarget(target, world) {
	try {
		Object.defineProperty(target, TARGET_WORLD, { value: world, enumerable: false, configurable: true });
	} catch {
		// Frozen/sealed target: the WeakMap still carries the ownership.
	}
	targetWorlds.set(target, world);
	return target;
}

/** Read world ownership from a filesystem target. */
function worldOfTarget(target) {
	return target?.[TARGET_WORLD] ?? targetWorlds.get(target);
}

/** One execution world: local or a connected SSH host. */
class ExecutionWorld {
	/**
	 * @param kind - `local` or `remote`.
	 * @param id - stable world id (host id for remote worlds).
	 * @param services - the three provider services.
	 * @param dispose - releases the isolated context.
	 */
	constructor(kind, id, services, dispose, extra = {}) {
		this.kind = kind;
		this.id = id;
		this.fs = services.fs;
		this.subprocess = services.subprocess;
		this.sandbox = services.sandbox;
		this.dispose = dispose;
		this.root = extra.root;
		this.alias = extra.alias;
	}
}

/** The routing root: owns the local world, remote worlds, and mount table. */
export class ExecutionRouter {
	/**
	 * @param ctx - Host plugin Context.
	 * @param options - runtime locations and the local cwd.
	 */
	constructor(ctx, options) {
		this.ctx = ctx;
		this.runtimeDir = options.runtimeDir;
		this.profileDir = options.profileDir;
		this.dataDir = options.dataDir;
		this.version = options.version;
		this.localCwd = options.localCwd ?? process.cwd();
		this.logger = options.logger;
		this.modules = undefined;
		this.local = undefined;
		this.localFibers = [];
		this.remoteWorlds = new Map();
		this.mounts = [];
		this.sshRuntime = undefined;
		this.sshModules = undefined;
		this.disposed = false;
		this.toolsDisposer = undefined;
		this.localExecutableRoots = [];
	}

	/** Mount the provider services and install the ambient-world wrapper. */
	async start() {
		this.modules = await loadRuntimeModules(this.runtimeDir);
		this.localExecutableRoots = [process.execPath, this.runtimeDir].map((value) => normalizePath(value));
		this.resourcesRoot = normalizePath(posix.dirname(posix.dirname(this.runtimeDir)));
		this.local = await this.#mountLocalWorld();
		await this.#mountRouterServices();
		this.toolsDisposer = this.ctx.on('tools/execute', (exec, next) => {
			const cwd = exec?.agent?.session?.header?.cwd;
			const mount = typeof cwd === 'string' ? this.matchMount(normalizePath(cwd)) : undefined;
			// Keep the session's remote cwd in the ambient record: a host may have
			// several registered workspaces at different remote roots, so one
			// shared world root cannot stand in for all of them.
			const remoteCwd = mount === undefined ? undefined : this.remotePathAt(mount, normalizePath(cwd));
			return ambientWorld.run({ world: mount?.world ?? this.local, cwd: remoteCwd }, next);
		});
	}

	/** Create the isolated local world using the official local providers. */
	async #mountLocalWorld() {
		const child = this.ctx.isolate('fs').isolate('subprocess').isolate('sandbox');
		const fibers = [];
		fibers.push(await child.plugin(this.modules.SandboxedFileSystem, { cwd: this.localCwd }));
		fibers.push(await child.plugin(this.modules.LocalSubprocessRuntime));
		fibers.push(await child.plugin(this.modules.LocalSandboxProvider));
		const services = await bindWorldServices(child, fibers);
		this.localFibers = fibers;
		const dispose = async () => {
			for (const fiber of [...fibers].reverse()) await disposeFiber(fiber);
		};
		return new ExecutionWorld('local', 'local', services, dispose);
	}

	/** Register the three router services on the Host root context. */
	async #mountRouterServices() {
		const router = this;
		const { FileSystem, SubprocessRuntime, SandboxProvider } = this.modules;

		class RouterFileSystem extends FileSystem {
			/** Resolve a path into its owning world exactly once. */
			async resolve(path, opts) {
				const { world, path: targetPath, cwd } = router.routePath(path, opts?.cwd);
				const target = await world.fs.resolve(targetPath, { cwd, signal: opts?.signal });
				return tagTarget(target, world);
			}

			processPath(target) {
				return router.worldForTarget(target).fs.processPath(target);
			}

			processPathFromHostPath(hostPath) {
				const mount = router.matchMount(normalizePath(hostPath));
				if (mount !== undefined) return router.remotePathAt(mount, normalizePath(hostPath));
				return router.local.fs.processPathFromHostPath(hostPath);
			}

			fileUrl(target) {
				return router.worldForTarget(target).fs.fileUrl(target);
			}

			contains(parent, child) {
				const parentWorld = router.worldForTarget(parent);
				const childWorld = router.worldForTarget(child);
				if (parentWorld !== childWorld) return false;
				return parentWorld.fs.contains(parent, child);
			}

			async stat(target, signal) {
				return router.worldForTarget(target).fs.stat(target, signal);
			}

			async lstat(path, opts, signal) {
				const { world, path: targetPath, cwd } = router.routePath(path, opts?.cwd);
				return world.fs.lstat(targetPath, { cwd }, signal);
			}

			async readText(target, signal) {
				return router.worldForTarget(target).fs.readText(target, signal);
			}

			streamText(target, signal) {
				return router.worldForTarget(target).fs.streamText(target, signal);
			}

			async readBytes(target, signal, maxBytes) {
				return router.worldForTarget(target).fs.readBytes(target, signal, maxBytes);
			}

			async readByteRange(target, range, signal) {
				return router.worldForTarget(target).fs.readByteRange(target, range, signal);
			}

			async listDir(target, signal) {
				return router.worldForTarget(target).fs.listDir(target, signal);
			}

			async writeText(target, content, expected, signal, sandboxPolicy) {
				const world = router.worldForTarget(target);
				return world.fs.writeText(target, content, expected, signal, router.mapPolicy(world, sandboxPolicy));
			}

			async editText(target, edit, expected, signal, sandboxPolicy) {
				const world = router.worldForTarget(target);
				return world.fs.editText(target, edit, expected, signal, router.mapPolicy(world, sandboxPolicy));
			}

			watch(target, changed, signal) {
				return router.worldForTarget(target).fs.watch(target, changed, signal);
			}

			get sandboxMode() {
				return router.local.fs.sandboxMode;
			}
		}

		class RouterSubprocessRuntime extends SubprocessRuntime {
			resolveExecutable(command, env, signal) {
				const world = router.currentWorld();
				const mapped = router.mapExecutable(world, command);
				return world.subprocess.resolveExecutable(mapped, env, signal);
			}

			terminalEnvironment(signal) {
				return router.currentWorld().subprocess.terminalEnvironment(signal);
			}

			spawn(spec) {
				const forced = router.maybeForceLocal(spec.argv);
				if (forced) return router.local.subprocess.spawn(router.localSpawnSpec(spec));
				const { world, path: cwd } = router.routePath(spec.cwd);
				return world.subprocess.spawn({ ...spec, cwd });
			}

			spawnTerminal(spec) {
				const forced = router.maybeForceLocal(spec.argv);
				if (forced) return router.local.subprocess.spawnTerminal(router.localSpawnSpec(spec));
				const { world, path: cwd } = router.routePath(spec.cwd);
				return world.subprocess.spawnTerminal({ ...spec, cwd });
			}
		}

		class RouterSandboxProvider extends SandboxProvider {
			confine(argv, policy, signal) {
				const { world } = router.routePath(policy.workspaceRoot);
				return world.sandbox.confine(argv, router.mapPolicy(world, policy) ?? policy, signal);
			}
		}

		// Synchronous registration is deliberate: consumers waiting on `fs`
		// must not observe a window where the Host has no filesystem provider.
		this.rootFibers = [
			await this.ctx.plugin(RouterFileSystem),
			await this.ctx.plugin(RouterSubprocessRuntime),
			await this.ctx.plugin(RouterSandboxProvider),
		];
	}

	/** Map one path/cwd pair to a world and a world-local absolute path. */
	routePath(path, cwd) {
		let absolute = typeof path === 'string' && path !== '' ? path : '.';
		const ambient = ambientEntry(ambientWorld.getStore());
		let base = cwd;
		if (!isAbsolute(absolute)) {
			if (base === undefined) base = ambient?.cwd ?? ambient?.world?.root ?? this.localCwd;
			absolute = resolvePath(base, absolute);
		} else {
			absolute = normalizePath(absolute);
		}
		const mount = this.matchMount(absolute);
		if (mount !== undefined) {
			return {
				world: mount.world,
				path: this.remotePathAt(mount, absolute),
				cwd: base === undefined ? undefined : this.mapCwd(mount, base),
			};
		}
		if (ambient?.world?.kind === 'remote') {
			// A remote session's absolute paths are remote paths even outside its
			// workspace root (`/etc/hostname`, `/tmp`). Only a registered mirror
			// prefix above may redirect to the remote world, and the local world is
			// never reachable from an ambient remote tool call.
			return {
				world: ambient.world,
				path: absolute,
				cwd: base === undefined ? ambient.cwd : this.passThroughAmbientCwd(ambient.world, base),
			};
		}
		if (base !== undefined) {
			const cwdMount = this.matchMount(normalizePath(base));
			if (cwdMount !== undefined) {
				// An absolute path outside the mount while the cwd is remote still
				// belongs to the remote world (e.g. `/etc/hostname` typed by the
				// model inside a remote session).
				return { world: cwdMount.world, path: absolute, cwd: this.mapCwd(cwdMount, base) };
			}
		}
		return { world: this.local, path: absolute, cwd: base === undefined ? undefined : normalizePath(base) };
	}

	/** Find the longest registered mount containing an absolute local path. */
	matchMount(absolute) {
		let best;
		for (const mount of this.mounts) {
			if (isUnder(mount.mountPath, absolute)) {
				if (best === undefined || mount.mountPath.length > best.mountPath.length) best = mount;
			}
		}
		return best;
	}

	/** Map a local mirror path back to the remote path. */
	remotePathAt(mount, localPath) {
		if (localPath === mount.mountPath) return mount.remotePath;
		return posix.join(mount.remotePath, localPath.slice(mount.mountPath.length + 1));
	}

	/** Map a cwd from the router namespace to the world namespace. */
	mapCwd(mount, cwd) {
		const absolute = normalizePath(cwd);
		if (isUnder(mount.mountPath, absolute)) return this.remotePathAt(mount, absolute);
		if (isUnder(mount.remotePath, absolute)) return absolute;
		return undefined;
	}

	/** Keep an ambient remote cwd only when it is already in remote coordinates. */
	passThroughAmbientCwd(world, cwd) {
		if (cwd === undefined) return undefined;
		const absolute = normalizePath(cwd);
		if (world.root !== undefined && isUnder(world.root, absolute)) return absolute;
		const mount = this.matchMount(absolute);
		if (mount !== undefined) return this.mapCwd(mount, absolute);
		return undefined;
	}

	/** The world of the current call, defaulting to local. */
	currentWorld() {
		return ambientEntry(ambientWorld.getStore())?.world ?? this.local;
	}

	/** The world owning a target, with a cwd-based fallback for untagged targets. */
	worldForTarget(target) {
		const world = worldOfTarget(target);
		if (world !== undefined) return world;
		const ambient = ambientEntry(ambientWorld.getStore());
		if (ambient !== undefined) return ambient.world;
		return this.local;
	}

	/** The world of one session/workspace cwd. */
	worldForCwd(cwd) {
		const mount = this.matchMount(normalizePath(cwd));
		return mount?.world;
	}

	/** Map a sandbox policy onto the selected world's path namespace. */
	mapPolicy(world, policy) {
		if (policy === undefined) return undefined;
		const workspaceRoot = world.kind === 'remote'
			? this.#remotePolicyRoot(world, policy.workspaceRoot)
			: normalizePath(policy.workspaceRoot);
		return { ...policy, workspaceRoot };
	}

	/** Translate a router-namespace workspace root into the remote namespace. */
	#remotePolicyRoot(world, workspaceRoot) {
		if (workspaceRoot === undefined) return world.root;
		const mount = this.matchMount(normalizePath(workspaceRoot));
		if (mount !== undefined && mount.world === world) return this.mapCwd(mount, workspaceRoot);
		const absolute = normalizePath(workspaceRoot);
		if (world.root !== undefined && isUnder(world.root, absolute)) return absolute;
		return world.root;
	}

	/** Map an executable path into the selected world's namespace. */
	mapExecutable(world, command) {
		if (world.kind !== 'remote') return command;
		if (typeof command !== 'string' || !isAbsolute(command)) return command;
		const mount = this.matchMount(normalizePath(command));
		if (mount !== undefined && mount.world === world) return this.remotePathAt(mount, normalizePath(command));
		return command;
	}

	/** Local-only processes (PTC Node, packaged tool binaries) bypass routing. */
	maybeForceLocal(argv) {
		const head = argv?.[0];
		if (typeof head !== 'string' || !isAbsolute(head) || !existsSync(head)) return false;
		const absolute = normalizePath(head);
		if (this.localExecutableRoots.some((root) => isUnder(root, absolute))) return true;
		// PTC (and a few other local runtimes) execute a local Node binary with a
		// local script while the session cwd is a remote mount. The binary is not
		// under the runtime directory, so recognize that shape explicitly.
		const script = argv?.[1];
		if (posix.basename(absolute) !== 'node' && posix.basename(absolute) !== 'node.exe') return false;
		if (typeof script !== 'string' || !isAbsolute(script) || !existsSync(script)) return false;
		return isUnder(this.runtimeDir, normalizePath(script)) || isUnder(this.resourcesRoot, normalizePath(script));
	}

	/** Keep a forced-local spec's cwd when it exists on this machine. */
	localSpawnSpec(spec) {
		const cwd = typeof spec.cwd === 'string' && existsSync(spec.cwd) ? spec.cwd : this.localCwd;
		return { ...spec, cwd };
	}

	/**
	 * Ensure one remote world and register a mount for one workspace.
	 * @param options - host identity, mirror mapping, and SSH connection config.
	 * @returns the registered mount.
	 */
	async addRemoteWorkspace(options) {
		const { id, hostId, hostAlias, mountPath, remotePath, connection } = options;
		const world = await this.#ensureRemoteWorld(hostId, hostAlias, connection);
		const filtered = this.mounts.filter((mount) => mount.id !== id);
		filtered.push({
			id,
			hostId,
			hostAlias,
			mountPath: normalizePath(mountPath),
			remotePath: normalizePath(remotePath),
			world,
		});
		filtered.sort((left, right) => right.mountPath.length - left.mountPath.length);
		this.mounts = filtered;
		return { id, hostId, mountPath, remotePath };
	}

	/** Drop one mount (the world stays connected for other workspaces). */
	unregisterMount(id) {
		this.mounts = this.mounts.filter((mount) => mount.id !== id);
	}

	/** Dispose one host's world and every mount that used it. */
	async removeHost(hostId) {
		this.mounts = this.mounts.filter((mount) => mount.hostId !== hostId);
		const entry = this.remoteWorlds.get(hostId);
		if (entry === undefined) return;
		this.remoteWorlds.delete(hostId);
		const world = await entry.promise.catch(() => undefined);
		if (world !== undefined) await world.dispose();
	}

	/** The current connection state of one host world. */
	async worldState(hostId) {
		const entry = this.remoteWorlds.get(hostId);
		if (entry === undefined) return { connected: false };
		const world = await entry.promise.catch(() => undefined);
		return world === undefined
			? { connected: false }
			: { connected: true, alias: world.alias, root: world.root };
	}

	/** Create (or reuse) the isolated SSH world of one host. */
	async #ensureRemoteWorld(hostId, hostAlias, connection) {
		const existing = this.remoteWorlds.get(hostId);
		if (existing !== undefined) {
			const world = await existing.promise;
			world.alias = hostAlias;
			world.root = connection.workspace;
			return world;
		}
		const promise = this.#createRemoteWorld(hostId, hostAlias, connection);
		this.remoteWorlds.set(hostId, { promise });
		try {
			return await promise;
		} catch (error) {
			this.remoteWorlds.delete(hostId);
			throw error;
		}
	}

	/** Mount the SSH connection and its three providers in isolated scopes. */
	async #createRemoteWorld(hostId, hostAlias, connection) {
		const modules = await this.#loadSshModules();
		const sshCtx = this.ctx.isolate('ssh');
		const fibers = [];
		fibers.push(await sshCtx.plugin(modules.SshConnection, connection));
		const providers = sshCtx.isolate('fs').isolate('subprocess').isolate('sandbox');
		fibers.push(await providers.plugin(modules.SshFileSystem));
		fibers.push(await providers.plugin(modules.SshSubprocessRuntime));
		fibers.push(await providers.plugin(modules.SshSandboxProvider));
		const services = await bindWorldServices(providers, fibers);
		const dispose = async () => {
			for (const fiber of [...fibers].reverse()) await disposeFiber(fiber);
		};
		return new ExecutionWorld('remote', hostId, services, dispose, {
			root: normalizePath(connection.workspace),
			alias: hostAlias,
		});
	}

	/** Lazily load the SSH module tree once per router lifetime. */
	async #loadSshModules() {
		if (this.sshModules !== undefined) return this.sshModules;
		this.sshRuntime ??= await ensureMixedRuntime({
			runtimeDir: this.runtimeDir,
			profileDir: this.profileDir,
			dataDir: this.dataDir,
			version: this.version,
		});
		const [ssh, fsSsh, subprocessSsh, sandboxSsh] = await Promise.all([
			this.sshRuntime.import('@deepseek-ai/dsh-ssh'),
			this.sshRuntime.import('@deepseek-ai/dsh-fs-ssh'),
			this.sshRuntime.import('@deepseek-ai/dsh-subprocess-ssh'),
			this.sshRuntime.import('@deepseek-ai/dsh-sandbox-ssh'),
		]);
		this.sshModules = {
			SshConnection: ssh.default ?? ssh.SshConnection,
			SshFileSystem: fsSsh.default ?? fsSsh.SshFileSystem,
			SshSubprocessRuntime: subprocessSsh.default ?? subprocessSsh.SshSubprocessRuntime,
			SshSandboxProvider: sandboxSsh.default ?? sandboxSsh.SshSandboxProvider,
		};
		return this.sshModules;
	}

	/** Release every isolated world and the installed listeners. */
	async dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.toolsDisposer?.();
		for (const entry of [...this.remoteWorlds.values()]) {
			const world = await entry.promise.catch(() => undefined);
			if (world !== undefined) await world.dispose();
		}
		this.remoteWorlds.clear();
		this.mounts = [];
		for (const fiber of [...(this.rootFibers ?? [])].reverse()) await disposeFiber(fiber);
		for (const fiber of [...this.localFibers].reverse()) await disposeFiber(fiber);
	}
}

/**
 * Read the three provider services through a fiber that declares them as
 * injections. The plugin that mounted the router only injects \`connection\`,
 * and Cordis forbids reading undeclared services from that fiber; this small
 * collector fiber is the supported way to bind them.
 * @param scope - the isolated world context.
 * @param fibers - fiber list that receives the collector fiber too.
 * @returns the bound provider services.
 */
async function bindWorldServices(scope, fibers) {
	const services = {};
	const collector = {
		name: 'mixed-world-services',
		inject: ['fs', 'subprocess', 'sandbox'],
		apply(target) {
			services.fs = target.fs;
			services.subprocess = target.subprocess;
			services.sandbox = target.sandbox;
		},
	};
	fibers.push(await scope.plugin(collector));
	return services;
}

/** Dispose one Cordis fiber defensively. */
async function disposeFiber(fiber) {
	if (fiber === undefined || fiber === null) return;
	if (typeof fiber.dispose === 'function') {
		await fiber.dispose();
		return;
	}
	if (typeof fiber.then === 'function') await fiber;
}

/**
 * Mount the mixed execution router into a Host plugin context.
 * @param ctx - Host plugin Context.
 * @param options - runtime locations, profile, data dir, and local cwd.
 * @returns the started router.
 */
export async function mountExecutionRouter(ctx, options) {
	const router = new ExecutionRouter(ctx, options);
	await router.start();
	return router;
}
