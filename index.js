/**
 * `@junjiangao/dsh-plugin-remote-ssh` — SSH host manager for the DeepSeek
 * Harness Web UI, backed by the official `@deepseek-ai/dsh-ssh` provider family.
 *
 * This Host half owns the management channel: the managed host list, the
 * generated OpenSSH config fragment, remote helper provisioning, the local
 * remote-execution profile, and one independent DSH Web instance per host. It
 * deliberately registers no model-facing tools; the browser reaches it through
 * authenticated Connection Fetch routes.
 *
 * It also mounts the **mixed execution router** (option C): the router replaces
 * the base `fs` / `subprocess` / `sandbox` providers and dispatches each call to
 * either the isolated local world or an isolated SSH world. The bundle patch
 * disables the three base provider rows, so the router is the only provider of
 * those services in a profile that includes this plugin.
 * @module @junjiangao/dsh-plugin-remote-ssh
 */
import process from 'node:process';
import { Config } from './lib/config.js';
import { RemoteSshController } from './lib/controller.js';
import { mountExecutionRouter } from './lib/execution-router.js';
import { registerRpc } from './lib/rpc.js';

/** Stable Loader identity. */
export const name = 'remote-ssh';
/** The Connection service provides the authenticated `/api` fetch bridge. */
export const inject = ['connection'];

export { Config };

/**
 * Start the controller and mount its RPC routes.
 * @param ctx - Host plugin context.
 * @param config - the Loader row's config, defaulted by {@link Config}.
 */
export async function apply(ctx, config) {
	const controller = new RemoteSshController(ctx, config);
	if (controller.runtime.runtimeDir === '') {
		throw new Error('remote-ssh: mixed execution needs a resolved DSH runtime directory');
	}
	const router = await mountExecutionRouter(ctx, {
		runtimeDir: controller.runtime.runtimeDir,
		profileDir: controller.profile.dir,
		dataDir: controller.paths.dataDir,
		version: controller.runtime.version,
		localCwd: process.cwd(),
		logger: ctx.logger,
	});
	controller.attachExecutionRouter(router);
	try {
		await controller.start();
		registerRpc(ctx, controller);
	} catch (error) {
		await router.dispose();
		throw error;
	}
	ctx.effect(
		() => () => controller.dispose(),
		'remote-ssh: stop remote instances and execution worlds on dispose',
	);
}
