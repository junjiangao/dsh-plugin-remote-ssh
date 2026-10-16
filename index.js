/**
 * `@local/dsh-plugin-remote-ssh` — model-facing SSH tools for the DeepSeek
 * Harness, backed by the system OpenSSH CLI.
 *
 * The bundle is Host-only: it registers `ssh_hosts`, `ssh_exec`, `ssh_upload`,
 * and `ssh_download` on `ctx.tools`. Authentication is delegated entirely to
 * OpenSSH (keys and agent only — every invocation passes `BatchMode=yes`), and
 * targets that are not pre-configured are passed to OpenSSH verbatim, so an
 * ssh_config alias such as `MyOracleCloud` works without any configuration.
 * @module @local/dsh-plugin-remote-ssh
 */
import { Config, resolveConfig } from './lib/config.js';
import { registerRemoteSshTools } from './lib/tools.js';

/** Stable Loader identity. */
export const name = 'remote-ssh';
/** Services required by the SSH tools. */
export const inject = ['tools'];

export { Config };

/**
 * Register the SSH tools for this plugin row.
 * @param ctx - context whose `tools` registry receives the registrations.
 * @param config - the row's config, already defaulted by {@link Config}.
 */
export function apply(ctx, config) {
	registerRemoteSshTools(ctx, resolveConfig(config));
}
