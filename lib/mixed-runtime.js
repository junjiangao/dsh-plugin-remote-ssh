/**
 * Module loading for mixed local/remote execution.
 *
 * The desktop Host ships the abstract service packages and the **local**
 * providers, but not the official SSH provider family \u2014 that family is
 * installed into the `dsh-remote` profile only. Mixed mode needs both in one
 * process, and the SSH packages must import the *same* `@deepseek-ai/cordis`
 * and service classes as the running Host; installing a private copy of those
 * peers would break service identity.
 *
 * [`ensureMixedRuntime`] therefore builds a private module tree that contains:
 * - copies of the four SSH provider packages, taken from the prepared
 *   `dsh-remote` profile, and
 * - symlinks to every package of the running DSH runtime's `node_modules`, so
 *   peer imports resolve to the exact modules the Host already loaded.
 *
 * The tree is versioned by DSH version and rebuilt when its marker is missing,
 * so a DSH upgrade cannot keep stale copies of the SSH packages around.
 * @module @junjiangao/dsh-plugin-remote-ssh/mixed-runtime
 */
import { createRequire } from 'node:module';
import { cp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

/** Official packages that are copied out of the SSH profile. */
export const SSH_PACKAGE_NAMES = [
	'@deepseek-ai/dsh-ssh',
	'@deepseek-ai/dsh-fs-ssh',
	'@deepseek-ai/dsh-subprocess-ssh',
	'@deepseek-ai/dsh-sandbox-ssh',
];

/** Local filesystem packages used for the local execution world. */
const LOCAL_MODULE_NAMES = {
	fs: '@deepseek-ai/dsh-fs',
	fsError: '@deepseek-ai/dsh-fs',
	fsSandbox: '@deepseek-ai/dsh-fs-sandbox',
	fsLocal: '@deepseek-ai/dsh-fs-local',
	subprocess: '@deepseek-ai/dsh-subprocess',
	subprocessLocal: '@deepseek-ai/dsh-subprocess-local',
	sandbox: '@deepseek-ai/dsh-sandbox',
	sandboxLocal: '@deepseek-ai/dsh-sandbox-local',
};

/** Error raised when the mixed module tree cannot be prepared. */
export class MixedRuntimeError extends Error {
	/**
	 * @param message - diagnostic.
	 * @param options - optional cause and remediation hint.
	 */
	constructor(message, options = {}) {
		super(message, options);
		this.name = 'MixedRuntimeError';
		this.hint = options.hint;
	}
}

/** Resolve the entry file of one package from a base directory. */
export function resolvePackage(baseDir, specifier) {
	const require = createRequire(join(baseDir, 'package.json'));
	return require.resolve(specifier);
}

/** Import one package from a base directory. */
export async function importPackage(baseDir, specifier) {
	return import(pathToFileURL(resolvePackage(baseDir, specifier)).href);
}

/** Read a package version, or undefined when the manifest is unreadable. */
async function packageVersion(dir) {
	try {
		const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
		return typeof manifest.version === 'string' ? manifest.version : undefined;
	} catch {
		return undefined;
	}
}

/** Link every runtime package into one private `node_modules` directory. */
async function linkRuntimePackages(source, destination) {
	const names = await readdir(source, { withFileTypes: true });
	for (const entry of names) {
		if (entry.name === '.bin' || entry.name === '.pnpm' || entry.name === '.modules.yaml') continue;
		if (entry.name.startsWith('@')) {
			const scopedSource = join(source, entry.name);
			const scopedDestination = join(destination, entry.name);
			await mkdir(scopedDestination, { recursive: true });
			const children = await readdir(scopedSource, { withFileTypes: true });
			for (const child of children) {
				// SSH packages are copied below, not linked from the runtime.
				if (SSH_PACKAGE_NAMES.includes(`${entry.name}/${child.name}`)) continue;
				await symlink(join(scopedSource, child.name), join(scopedDestination, child.name), 'dir');
			}
			continue;
		}
		await symlink(join(source, entry.name), join(destination, entry.name), 'dir');
	}
}

/** Read the package markers that make up the SSH side of the tree. */
async function sshPackageVersions(profileDir) {
	const versions = [];
	for (const name of SSH_PACKAGE_NAMES) {
		const dir = join(profileDir, 'node_modules', ...name.split('/'));
		const version = await packageVersion(dir);
		if (version === undefined) {
			throw new MixedRuntimeError(`mixed mode needs ${name} in ${profileDir}`, {
				hint: 'Open a remote host once (or refresh the remote profile) so the SSH runtime packages are installed.',
			});
		}
		versions.push({ name, version });
	}
	return versions;
}

/** Check that a previously built tree is complete. */
async function treeIsReady(treeDir, expected) {
	try {
		const marker = JSON.parse(await readFile(join(treeDir, 'ready.json'), 'utf8'));
		if (!isDeepStrictEqual(marker.sshPackages, expected)) return false;
		return true;
	} catch {
		return false;
	}
}

/**
 * Build (or reuse) the private module tree for the SSH provider family.
 * @param options - runtime location, SSH profile location, and target directory.
 * @returns a handle with `import(specifier)` bound to the tree.
 */
export async function ensureMixedRuntime(options) {
	const { runtimeDir, profileDir, dataDir, version } = options;
	const installNodeModules = join(runtimeDir, 'node_modules');
	const sshVersions = await sshPackageVersions(profileDir);
	const tag = (version === undefined || version === '' ? 'dev' : version).replace(/[^A-Za-z0-9._-]+/gu, '_');
	const root = join(dataDir, 'mixed', 'runtime', tag);
	const tree = join(root, 'tree');
	if (await treeIsReady(tree, sshVersions)) return createHandle(tree);

	await rm(root, { recursive: true, force: true });
	await mkdir(join(tree, 'node_modules', '@deepseek-ai'), { recursive: true });
	await linkRuntimePackages(installNodeModules, join(tree, 'node_modules'));

	for (const name of SSH_PACKAGE_NAMES) {
		const from = join(profileDir, 'node_modules', ...name.split('/'));
		const to = join(tree, 'node_modules', ...name.split('/'));
		await cp(from, to, { recursive: true, dereference: false, force: true });
	}
	await writeFile(
		join(tree, 'ready.json'),
		`${JSON.stringify({ version: tag, sshPackages: sshVersions, builtAt: new Date().toISOString() }, undefined, 2)}\n`,
		{ mode: 0o600 },
	);
	return createHandle(tree);
}

/** Build the public handle for one prepared module tree. */
function createHandle(tree) {
	const require = createRequire(join(tree, 'package.json'));
	return {
		dir: tree,
		require,
		resolve(specifier) {
			return require.resolve(specifier);
		},
		async import(specifier) {
			return import(pathToFileURL(require.resolve(specifier)).href);
		},
	};
}

/**
 * Load the abstract service classes and the local provider classes from the
 * running DSH runtime. These are the same module instances every other Host
 * plugin sees, so `instanceof` and Cordis service identity stay intact.
 * @param runtimeDir - absolute DSH runtime root.
 */
export async function loadRuntimeModules(runtimeDir) {
	const entries = Object.entries(LOCAL_MODULE_NAMES);
	const loaded = await Promise.all(entries.map(async ([key, specifier]) => {
		const namespace = await importPackage(runtimeDir, specifier);
		return [key, namespace];
	}));
	const modules = Object.fromEntries(loaded);
	return {
		FileSystem: modules.fs.FileSystem,
		FsError: modules.fs.FsError,
		SubprocessRuntime: modules.subprocess.SubprocessRuntime,
		SubprocessExecutableNotFoundError: modules.subprocess.SubprocessExecutableNotFoundError,
		SandboxProvider: modules.sandbox.SandboxProvider,
		SandboxedFileSystem: modules.fsSandbox.default ?? modules.fsSandbox.SandboxedFileSystem,
		LocalFileSystem: modules.fsLocal.default ?? modules.fsLocal.LocalFileSystem,
		LocalSubprocessRuntime: modules.subprocessLocal.default ?? modules.subprocessLocal.LocalSubprocessRuntime,
		LocalSandboxProvider: modules.sandboxLocal.default ?? modules.sandboxLocal.LocalSandboxProvider,
	};
}
