import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRig, stopRig } from '../rig/lib.mjs';
import { RemoteSshController } from '../../lib/controller.js';
import { resolveConfig } from '../../lib/config.js';

test('controller imports, tests, saves, updates and deletes a rig host', async () => {
	const rig = await startRig();
	let controller;
	try {
		const base = await mkdtemp(join(tmpdir(), 'rssh-it-'));
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
		const config = resolveConfig({
			dataDir,
			sshConfigPath,
			profileName: 'dsh-remote-integration',
			sshPackageVersion: '0.2.1-rc.2',
			inheritDesktopSettings: false,
			mirrorWorkspace: false,
			commandTimeoutMs: 20_000,
		});
		controller = new RemoteSshController({}, config);
		await controller.start();

		const initial = await controller.snapshot();
		assert.equal(initial.settings.sshConfigPath, sshConfigPath);
		assert.equal(initial.hosts.length, 1);
		const imported = initial.hosts[0];
		assert.equal(imported.id, 'ssh-config:rig-imported');
		assert.equal(imported.source, 'ssh-config');
		assert.equal(imported.editable, false);
		assert.equal(imported.hostname, '127.0.0.1');
		assert.equal(imported.port, rig.port);

		const testedImported = await controller.testConnection({ id: imported.id });
		assert.equal(testedImported.ok, true);
		assert.equal(testedImported.stdout, 'DSH_TEST_OK');

		const saved = await controller.saveHost({
			alias: 'rig-managed',
			displayName: 'Rig Managed',
			hostname: '127.0.0.1',
			user: rig.user,
			port: rig.port,
			identityFile: rig.keyPath,
			strictHostKeyChecking: 'yes',
			userKnownHostsFile: knownHosts,
			remoteWorkspace: '~',
			extraOptions: [{ key: 'Compression', value: 'yes' }],
		});
		assert.equal(saved.snapshot.hosts.filter((host) => host.source === 'managed').length, 1);
		const managed = saved.host;
		assert.equal(managed.editable, true);
		assert.equal(managed.strictHostKeyChecking, 'yes');
		assert.deepEqual(managed.extraOptions, [{ key: 'Compression', value: 'yes' }]);

		const configText = await readFile(sshConfigPath, 'utf8');
		assert.match(configText, /^# BEGIN dsh-plugin-remote-ssh/);
		assert.match(configText, /Include /);
		assert.doesNotMatch(configText, /Host rig-managed/);
		const fragment = await readFile(join(dataDir, 'ssh_config'), 'utf8');
		assert.match(fragment, /Host rig-managed/);

		const testedManaged = await controller.testConnection({ id: managed.id });
		assert.equal(testedManaged.ok, true);

		const updated = await controller.saveHost({ ...managed, displayName: 'Rig Managed Edited', serverAliveInterval: 15 });
		assert.equal(updated.host.displayName, 'Rig Managed Edited');
		assert.equal(updated.host.serverAliveInterval, 15);
		assert.deepEqual(updated.host.extraOptions, [{ key: 'Compression', value: 'yes' }]);

		const reloaded = new RemoteSshController({}, config);
		await reloaded.start();
		const afterReload = await reloaded.snapshot();
		assert.equal(afterReload.hosts.find((host) => host.id === managed.id).displayName, 'Rig Managed Edited');
		await reloaded.dispose();

		const deleted = await controller.deleteHost(managed.id);
		assert.equal(deleted.snapshot.hosts.filter((host) => host.source === 'managed').length, 0);
		assert.doesNotMatch(await readFile(join(dataDir, 'ssh_config'), 'utf8'), /rig-managed/);
	} finally {
		if (controller !== undefined) await controller.dispose();
		await stopRig(rig);
	}
});

test('controller rejects a duplicate managed alias and rolls back', async () => {
	const base = await mkdtemp(join(tmpdir(), 'rssh-it-'));
	const sshDir = join(base, '.ssh');
	await mkdir(sshDir, { recursive: true });
	const sshConfigPath = join(sshDir, 'config');
	await writeFile(sshConfigPath, 'Host existing\n  HostName example.com\n');
	const config = resolveConfig({
		dataDir: join(base, 'data'),
		sshConfigPath,
		profileName: 'dsh-remote-integration',
		sshPackageVersion: '0.2.1-rc.2',
		inheritDesktopSettings: false,
	});
	const controller = new RemoteSshController({}, config);
	await controller.start();
	try {
		await controller.saveHost({ alias: 'dup', hostname: 'one' });
		await assert.rejects(controller.saveHost({ alias: 'dup', hostname: 'two' }), /already used/);
		const snapshot = await controller.snapshot();
		assert.equal(snapshot.hosts.filter((host) => host.source === 'managed').length, 1);
		assert.match(await readFile(join(base, 'data', 'ssh_config'), 'utf8'), /HostName one/);
	} finally {
		await controller.dispose();
	}
});
