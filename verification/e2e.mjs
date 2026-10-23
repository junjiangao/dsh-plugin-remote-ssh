#!/usr/bin/env node
/**
 * End-to-end orchestration check backed by the local sshd rig and a fake DSH
 * CLI. It exercises the same controller/RPC/instance code the Web panel uses
 * without touching the real `~/.ssh` or starting a second real Harness.
 *
 *   node verification/e2e.mjs [--json verification/out/e2e.json]
 *
 * Read-only with respect to user files.
 */
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import path from 'node:path';
import process from 'node:process';
import strict from 'node:assert/strict';
import { createSuite, assert } from './lib/checks.mjs';
import { repoRoot } from './lib/harness.mjs';
import { startRig, stopRig } from '../tests/rig/lib.mjs';
import { RemoteSshController } from '../lib/controller.js';
import { InstanceManager, findWebUrl } from '../lib/instance.js';
import { ENDPOINTS, registerRpc } from '../lib/rpc.js';
import { resolveConfig } from '../lib/config.js';
import { writeManagedConfig, ensureManagedInclude } from '../lib/ssh-config.js';
import { renderOverlay } from '../lib/overlay.js';

const suite = createSuite('e2e');
let rig;
let controller;
let base;

/** Fake DSH CLI used to prove the instance lifecycle without a real Harness. */
async function fakeCli(dir) {
	const file = join(dir, 'fake-dsh');
	await writeFile(file, `#!/bin/sh
echo "dsh web: http://127.0.0.1:59998/?token=e2e-secret-token"
trap 'exit 0' TERM INT
while :; do sleep 1; done
`);
	await chmod(file, 0o700);
	return file;
}

/** Call one registered RPC route exactly like the browser bridge does. */
async function rpc(routes, endpoint, payload = {}) {
	const handler = routes.get(`/api/remote-ssh/${endpoint}`);
	assert(handler !== undefined, `route ${endpoint} not registered`);
	const response = await handler(new Request(`http://127.0.0.1/api/remote-ssh/${endpoint}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ type: 'client-request', rpcId: `rpc-${endpoint}`, payload }),
	}));
	strict.equal(response.status, 200);
	return response.json();
}

try {
	rig = await startRig();
	base = await mkdtemp(join(tmpdir(), 'rssh-verify-e2e-'));
	const sshDir = join(base, '.ssh');
	await mkdir(sshDir, { recursive: true });
	const sshConfigPath = join(sshDir, 'config');
	const knownHosts = join(sshDir, 'known_hosts');
	await writeFile(sshConfigPath, [
		'Host rig-imported',
		'  HostName 127.0.0.1',
		`  User ${rig.user}`,
		`  Port ${rig.port}`,
		`  IdentityFile ${rig.keyPath}`,
		'  StrictHostKeyChecking accept-new',
		`  UserKnownHostsFile ${knownHosts}`,
		'',
	].join('\n'));
	const dataDir = join(base, 'data');
	const runtime = { cliPath: await fakeCli(base), version: '0.2.1-rc.2', isDesktop: false, nodeBinDir: '', runtimeDir: '' };
	const config = resolveConfig({ dataDir, sshConfigPath, profileName: 'dsh-remote-verify', sshPackageVersion: '0.2.1-rc.2', inheritDesktopSettings: false, mirrorWorkspace: false, commandTimeoutMs: 20_000 });
	controller = new RemoteSshController({}, config, { runtime, instances: new InstanceManager(config, runtime, join(dataDir, 'instances')) });
	await controller.start();

	const routes = new Map();
	registerRpc({ effect: (fn) => { fn(); return () => {}; }, connection: { fetch: { register: (spec) => { routes.set(spec.path, spec.fetch); return () => {}; } } } }, controller);

	await suite.check('rig.ssh', 'the test sshd accepts a direct connection', async () => {
		const { execFile } = await import('node:child_process');
		const { promisify } = await import('node:util');
		const run = promisify(execFile);
		const { stdout } = await run('ssh', ['-F', sshConfigPath, 'rig-imported', 'printf RIG_OK']);
		strict.equal(stdout, 'RIG_OK');
		return 'sshd handshake';
	});

	await suite.check('rpc.routes', 'every declared endpoint route is mounted', () => {
		strict.deepEqual([...routes.keys()].sort(), ENDPOINTS.map((name) => `/api/remote-ssh/${name}`).sort());
		strict.equal(routes.size, ENDPOINTS.length);
		return `${routes.size} routes`;
	});

	await suite.check('rpc.remoteWorkspaces', 'the workspace inventory is empty before any remote window exists', async () => {
		const body = await rpc(routes, 'remoteWorkspaces');
		strict.equal(body.type, 'server-response');
		strict.equal(body.rpcId, 'rpc-remoteWorkspaces');
		assert(body.result.ok === true);
		strict.deepEqual(body.result.value.hosts, []);
		strict.ok(Array.isArray(body.result.value.warnings));
		return 'empty inventory';
	});

	await suite.check('rpc.snapshot', 'snapshot returns imported hosts and settings', async () => {
		const body = await rpc(routes, 'snapshot');
		strict.equal(body.type, 'server-response');
		strict.equal(body.rpcId, 'rpc-snapshot');
		assert(body.result.ok === true);
		const value = body.result.value;
		assert(value.hosts.some((host) => host.alias === 'rig-imported' && host.source === 'ssh-config'));
		strict.equal(value.settings.sshConfigPath, sshConfigPath);
		return `${value.hosts.length} host(s)`;
	});

	await suite.check('rpc.testConnection', 'the imported host passes a live SSH probe', async () => {
		const snapshot = (await rpc(routes, 'snapshot')).result.value;
		const host = snapshot.hosts.find((entry) => entry.alias === 'rig-imported');
		const body = await rpc(routes, 'testConnection', { id: host.id });
		assert(body.result.ok === true, body.result.error?.message);
		strict.equal(body.result.value.ok, true);
		return body.result.value.stdout;
	});

	await suite.check('controller.crud', 'managed host saves, updates and deletes through the controller', async () => {
		const saved = await controller.saveHost({
			alias: 'rig-e2e', displayName: 'Rig E2E', hostname: '127.0.0.1', user: rig.user,
			port: rig.port, identityFile: rig.keyPath, strictHostKeyChecking: 'yes',
			userKnownHostsFile: knownHosts, remoteWorkspace: '~', extraOptions: [{ key: 'Compression', value: 'yes' }],
		});
		strict.equal(saved.host.source, 'managed');
		const updated = await controller.saveHost({ ...saved.host, displayName: 'Rig E2E Edited', serverAliveInterval: 12 });
		strict.equal(updated.host.displayName, 'Rig E2E Edited');
		strict.equal(updated.host.serverAliveInterval, 12);
		strict.deepEqual(updated.host.extraOptions, [{ key: 'Compression', value: 'yes' }]);
		const tested = await controller.testConnection({ id: saved.host.id });
		assert(tested.ok === true, tested.error?.message);
		await controller.deleteHost(saved.host.id);
		const snapshot = await controller.snapshot();
		assert(!snapshot.hosts.some((host) => host.id === saved.host.id));
		return 'save → update → test → delete';
	});

	await suite.check('sshconfig.maintenance', 'managed fragment and Include block are idempotent', async () => {
		const saves = await controller.saveHost({ alias: 'rig-config', hostname: '127.0.0.1', user: rig.user, port: rig.port, identityFile: rig.keyPath });
		const text = await readFile(sshConfigPath, 'utf8');
		assert(text.includes('# BEGIN dsh-plugin-remote-ssh'));
		assert(text.includes(`Include ${join(dataDir, 'ssh_config')}`));
		await ensureManagedInclude(sshConfigPath, join(dataDir, 'ssh_config'));
		await ensureManagedInclude(sshConfigPath, join(dataDir, 'ssh_config'));
		strict.equal(await readFile(sshConfigPath, 'utf8'), text);
		await controller.deleteHost(saves.host.id);
		return 'Include + fragment stable';
	});

	await suite.check('overlay.shape', 'per-host overlay contains exactly one official SSH family', () => {
		const text = renderOverlay({
			host: { id: 'host_e2e', alias: 'rig-e2e' },
			workspace: '/tmp/rig-workspace',
			nodePath: '/usr/bin/node',
			helperPath: '/home/me/.dsh-remote-ssh/helper/0.2.1-rc.2/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js',
			helperHash: 'a'.repeat(64),
			permissionMode: 'workspace-write',
		});
		for (const id of ['ssh', 'fs-ssh', 'subprocess-ssh', 'sandbox-ssh']) assert(text.includes(`- id: ${id}`), id);
		for (const id of ['subprocess', 'sandbox', 'fs-sandbox', 'ptc-runtime']) assert(text.includes(`- id: ${id}\n  disabled: true`), id);
		assert(text.includes("workspace: '/tmp/rig-workspace'"));
		return '4 SSH rows + disabled local providers';
	});

	await suite.check('instance.lifecycle', 'a fake CLI is started, redacted and stopped', async () => {
		const created = await controller.saveHost({ alias: 'rig-instance', hostname: '127.0.0.1', user: rig.user, port: rig.port, identityFile: rig.keyPath });
		const target = created.host;
		const instances = controller.instances;
		const started = await instances.start({ id: target.id }, { profileName: 'dsh-remote-verify' });
		strict.equal(started.url, 'http://127.0.0.1:59998/?token=e2e-secret-token');
		const view = instances.view(target.id);
		strict.equal(view.phase, 'running');
		assert(!String(view.logTail).includes('e2e-secret-token'));
		await instances.stop(target.id);
		strict.equal(instances.view(target.id).phase, 'idle');
		return findWebUrl(started.url) !== undefined ? 'url + lifecycle' : 'url';
	});

	await suite.check('rpc.error', 'invalid content type and unknown ids are rejected safely', async () => {
		const handler = routes.get('/api/remote-ssh/snapshot');
		const response = await handler(new Request('http://127.0.0.1/api/remote-ssh/snapshot', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }));
		strict.equal(response.status, 415);
		const missing = await rpc(routes, 'openUrl', { id: 'host_does_not_exist' });
		assert(missing.result.ok === false);
		strict.equal(missing.result.error.code, 'not-found');
		return '415 + not-found';
	});
} catch (error) {
	await suite.check('harness.setup', 'e2e harness starts', () => { throw error; });
} finally {
	if (controller !== undefined) await controller.dispose().catch(() => {});
	if (rig !== undefined) await stopRig(rig).catch(() => {});
	if (base !== undefined) await rm(base, { recursive: true, force: true }).catch(() => {});
}

const summary = suite.summary();
const outJson = path.join(repoRoot, 'verification/out/e2e.json');
const outTxt = path.join(repoRoot, 'verification/out/e2e.txt');
const payload = { generatedAt: new Date().toISOString(), title: suite.title, ...summary, results: suite.results };
const { mkdirSync, writeFileSync } = await import('node:fs');
mkdirSync(path.dirname(outJson), { recursive: true });
writeFileSync(outJson, `${JSON.stringify(payload, null, 2)}\n`);
writeFileSync(outTxt, `${suite.results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.id}  ${r.description}  ${r.notes.split('\n')[0]}`).join('\n')}\n\n${summary.passed} passed, ${summary.failed} failed, ${summary.total} total\n`);
process.exitCode = summary.failed === 0 ? 0 : 1;
