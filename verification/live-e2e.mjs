#!/usr/bin/env node
/**
 * Optional live end-to-end check against one real SSH alias from
 * `~/.ssh/config`.
 *
 *   node verification/live-e2e.mjs --alias MyServer
 *   node verification/live-e2e.mjs --alias MyServer --yes --version 0.2.1-rc.2
 *
 * Default mode is read-only: it runs the Host-side doctor and, when the remote
 * helper is missing, prints the exact install command and exits 2 without
 * installing anything. `--yes` explicitly allows the remote helper installation
 * and the remote workspace creation required by the open flow.
 *
 * The script never edits `~/.ssh/config`. It uses a temporary data directory and
 * a temporary DSH home for the local `dsh-remote` profile, then stops the
 * instance and removes its temporary files. It is not part of `npm test` and is
 * never run by CI.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { RemoteSshController } from '../lib/controller.js';
import { InstanceManager } from '../lib/instance.js';
import { RuntimeProfile } from '../lib/runtime-profile.js';
import { resolveConfig } from '../lib/config.js';
import { resolveRuntime } from '../lib/paths.js';
import { helperInstallCommand } from '../lib/helper.js';

const { values } = parseArgs({
	options: {
		alias: { type: 'string' },
		yes: { type: 'boolean', default: false },
		version: { type: 'string' },
		workspace: { type: 'string' },
		timeout: { type: 'string' },
		json: { type: 'boolean', default: false },
	},
	allowPositionals: false,
});

function usage(message) {
	process.stderr.write(`${message}\n\nUsage: node verification/live-e2e.mjs --alias <ssh-alias> [--yes] [--version <dsh-version>] [--workspace <remote-path>] [--timeout <ms>] [--json]\n`);
	process.exitCode = 1;
}

if (values.alias === undefined || values.alias.trim() === '') {
	usage('--alias is required (a Host alias from ~/.ssh/config).');
} else {
	const alias = values.alias.trim();
	const timeoutMs = values.timeout === undefined ? 180_000 : Number(values.timeout);
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) usage('--timeout must be a positive number of milliseconds.');
	const runtime = resolveRuntime();
	const version = values.version ?? process.env.DSH_VERSION ?? runtime.version;
	if (version === undefined || version === '') {
		usage('Cannot determine the DSH version. Pass --version (for example 0.2.1-rc.2) or set DSH_VERSION.');
	}
	const result = {
		alias,
		version,
		install: values.yes === true,
		startedAt: new Date().toISOString(),
		phases: [],
		ok: false,
	};
	let controller;
	let base;
	const report = () => {
		if (values.json === true) {
			process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
			return;
		}
		process.stdout.write(`\n[${result.ok ? 'OK' : 'FAILED'}] ${alias} (DSH ${version})\n`);
		for (const phase of result.phases) process.stdout.write(`  ${phase.phase.padEnd(18)} ${phase.message ?? ''}\n`);
		if (result.url !== undefined) process.stdout.write(`  url: ${result.url}\n`);
		if (result.helperCommand !== undefined) process.stdout.write(`  helper command: ${result.helperCommand}\n`);
		if (result.error !== undefined) process.stdout.write(`  error: ${result.error}\n`);
	};
	try {
		base = await mkdtemp(join(tmpdir(), 'rssh-live-e2e-'));
		const dshHome = join(base, 'dsh');
		const config = resolveConfig({
			dataDir: join(base, 'data'),
			sshConfigPath: join(homedir(), '.ssh', 'config'),
			profileName: `dsh-remote-live-${Date.now()}`,
			sshPackageVersion: version,
			inheritDesktopSettings: false,
			mirrorWorkspace: true,
			commandTimeoutMs: 30_000,
		});
		const profile = new RuntimeProfile(config, runtime, { dshHome });
		const instances = new InstanceManager(config, runtime, join(base, 'data', 'instances'), { envOverrides: { DSH_HOME: dshHome } });
		controller = new RemoteSshController({}, config, { runtime, profile, instances });
		await controller.start();
		const snapshot = await controller.snapshot();
		const host = snapshot.hosts.find((entry) => entry.source === 'ssh-config' && entry.alias === alias);
		if (host === undefined) {
			const visible = snapshot.hosts.filter((entry) => entry.source === 'ssh-config').map((entry) => entry.alias);
			throw new Error(`alias "${alias}" was not imported from ${join(homedir(), '.ssh', 'config')}; imported aliases: ${visible.join(', ') || '(none)'}`);
		}
		result.hostId = host.id;
		if (values.workspace !== undefined) {
			// Imported hosts are read-only; use a managed host when a custom workspace is needed.
			throw new Error('--workspace is not supported for imported hosts; add the host to the plugin first');
		}
		// Read-only doctor: never installs anything.
		const doctor = await controller.doctor(host.id);
		result.doctor = {
			ready: doctor.ready,
			helper: doctor.facts.helper?.status,
			checks: doctor.checks.map((entry) => ({ id: entry.id, ok: entry.ok, detail: entry.detail })),
		};
		const helper = doctor.facts.helper;
		if (helper?.status !== 'installed') {
			const remoteHome = doctor.facts.remote?.home ?? '~';
			result.helperCommand = helperInstallCommand(config, host, remoteHome, version, doctor.facts.remote);
			if (values.yes !== true) {
				result.ok = false;
				result.error = `remote helper is ${helper?.status ?? 'missing'}; re-run with --yes to install it, or run the helper command manually`;
				report();
				process.exitCode = 2;
			}
		}
		const opened = await controller.openHost(host.id, { allowInstall: values.yes === true });
		result.jobId = opened.jobId;
		const startedAt = Date.now();
		let lastPhase = '';
		let instance;
		while (Date.now() - startedAt < timeoutMs) {
			await new Promise((resolve) => setTimeout(resolve, 1_000));
			const current = await controller.snapshot();
			instance = current.hosts.find((entry) => entry.id === host.id)?.instance;
			if (instance === undefined) continue;
			if (instance.phase !== lastPhase) {
				lastPhase = instance.phase;
				result.phases.push({ phase: instance.phase, message: instance.message, at: new Date().toISOString() });
			}
			if (instance.phase === 'running' || instance.phase === 'failed') break;
		}
		if (instance?.phase !== 'running') {
			throw new Error(`open did not reach "running" within ${timeoutMs} ms (last phase: ${instance?.phase ?? 'unknown'})`);
		}
		const { url } = await controller.openUrl(host.id);
		result.url = url;
		const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
		result.httpStatus = response.status;
		if (response.status >= 400) throw new Error(`remote window URL returned HTTP ${response.status}`);
		result.ok = true;
	} catch (error) {
		result.error = error instanceof Error ? error.message : String(error);
		if (values.json !== true) process.stderr.write(`live-e2e failed: ${result.error}\n`);
	} finally {
		if (controller !== undefined) {
			try {
				if (result.hostId !== undefined) await controller.stopHost(result.hostId);
			} catch {
				// Best effort; dispose also stops every child.
			}
			await controller.dispose().catch(() => undefined);
		}
		if (base !== undefined) await rm(base, { recursive: true, force: true }).catch(() => undefined);
		report();
	}
	if (process.exitCode === undefined) process.exitCode = result.ok ? 0 : 1;
}
