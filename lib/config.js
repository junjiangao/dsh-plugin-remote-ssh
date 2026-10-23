/**
 * Loader-facing configuration for the remote SSH bundle.
 *
 * The plugin no longer exposes model-facing SSH tools. This configuration only
 * controls the management channel: where the browser panel stores its host
 * list, which OpenSSH executable and config it reads, how the remote helper is
 * provisioned, and how the independent remote-execution Web instance is
 * started.
 * @module @junjiangao/dsh-plugin-remote-ssh/config
 */
import z from '@deepseek-ai/schemastery';

/** Default timeout for establishing one SSH connection, in milliseconds. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
/** Default timeout for one remote diagnostic command, in milliseconds. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
/** Default timeout for installing the remote helper or local runtime, in milliseconds. */
export const DEFAULT_INSTALL_TIMEOUT_MS = 600_000;
/** Default deadline for a remote Web instance to print its URL, in milliseconds. */
export const DEFAULT_OPEN_TIMEOUT_MS = 90_000;

/**
 * Configuration schema for one `remote-ssh` Loader row.
 *
 * Every field has a default so the bundle activates with `config: {}`.
 */
export const Config = z
	.object({
		sshExecutable: z
			.string()
			.default('ssh')
			.description('OpenSSH client executable used for bootstrap and diagnostics.'),
		sshConfigPath: z
			.string()
			.default('~/.ssh/config')
			.description('OpenSSH user config read for hosts and updated with the managed Include block.'),
		dataDir: z
			.string()
			.default('~/.dsh/remote-ssh')
			.description('Plugin data directory for the managed host list, generated ssh_config and overlays.'),
		profileName: z
			.string()
			.default('dsh-remote')
			.description('DSH profile prepared with the official SSH provider packages and booted per host.'),
		sshPackageVersion: z
			.string()
			.description('Version of the official dsh-ssh packages; defaults to the running DSH version.'),
		helperPackage: z
			.string()
			.default('@deepseek-ai/dsh-ssh')
			.description('npm package installed on the remote host to provide the SSH helper.'),
		helperRoot: z
			.string()
			.default('~/.dsh-remote-ssh/helper')
			.description('Remote parent directory that receives one helper installation per version.'),
		npmRegistry: z
			.string()
			.description('Optional npm registry URL used when installing the remote helper.'),
		remoteNode: z
			.string()
			.description('Optional absolute remote Node executable; discovered with `command -v node` when omitted.'),
		connectTimeoutMs: z
			.number()
			.default(DEFAULT_CONNECT_TIMEOUT_MS)
			.description('SSH connection timeout passed to the OpenSSH client.'),
		commandTimeoutMs: z
			.number()
			.default(DEFAULT_COMMAND_TIMEOUT_MS)
			.description('Timeout for one remote diagnostic command.'),
		installTimeoutMs: z
			.number()
			.default(DEFAULT_INSTALL_TIMEOUT_MS)
			.description('Timeout for remote helper or local runtime package installation.'),
		openTimeoutMs: z
			.number()
			.default(DEFAULT_OPEN_TIMEOUT_MS)
			.description('Deadline for a new remote Web instance to print its authenticated URL.'),
		inheritDesktopSettings: z
			.boolean()
			.default(true)
			.description('Apply the desktop profile user patch to the remote Web instance so models and UI settings carry over.'),
		mirrorWorkspace: z
			.boolean()
			.default(true)
			.description('Create an empty same-path directory on the host so workspace attachment validation accepts the remote workspace.'),
		permissionMode: z
			.union(['workspace-write', 'read-only', 'danger-full-access'])
			.default('workspace-write')
			.description('Sandbox mode used by the remote execution world.'),
	})
	.description('Remote SSH host manager and remote-execution window settings.');

/**
 * Normalize a raw Loader config into the shape every module consumes.
 *
 * The Loader validates the schema before `apply`, but tests and direct plugin
 * construction call this helper so defaults are identical on every path.
 * @param config - partial or already-validated configuration.
 * @returns a complete configuration object.
 */
export function resolveConfig(config) {
	const value = config ?? {};
	return {
		sshExecutable: value.sshExecutable ?? 'ssh',
		sshConfigPath: value.sshConfigPath ?? '~/.ssh/config',
		dataDir: value.dataDir ?? '~/.dsh/remote-ssh',
		profileName: value.profileName ?? 'dsh-remote',
		sshPackageVersion: value.sshPackageVersion,
		helperPackage: value.helperPackage ?? '@deepseek-ai/dsh-ssh',
		helperRoot: value.helperRoot ?? '~/.dsh-remote-ssh/helper',
		npmRegistry: value.npmRegistry,
		remoteNode: value.remoteNode,
		connectTimeoutMs: positive(value.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS),
		commandTimeoutMs: positive(value.commandTimeoutMs, DEFAULT_COMMAND_TIMEOUT_MS),
		installTimeoutMs: positive(value.installTimeoutMs, DEFAULT_INSTALL_TIMEOUT_MS),
		openTimeoutMs: positive(value.openTimeoutMs, DEFAULT_OPEN_TIMEOUT_MS),
		inheritDesktopSettings: value.inheritDesktopSettings !== false,
		mirrorWorkspace: value.mirrorWorkspace !== false,
		permissionMode: value.permissionMode ?? 'workspace-write',
	};
}

/** Read one positive finite number, falling back to a default. */
function positive(value, fallback) {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}
