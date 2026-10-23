import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findWebUrl, InstanceManager, redactSecrets, stripAnsi } from '../../lib/instance.js';

async function tempRuntime(script) {
	const dir = await mkdtemp(join(tmpdir(), 'rssh-instance-'));
	const file = join(dir, 'fake-dsh');
	await writeFile(file, script);
	await chmod(file, 0o700);
	return { dir, file, runtime: { cliPath: file, isDesktop: false, runtimeDir: '', nodeBinDir: '', nodePath: '/bin/sh' } };
}

const config = { profileName: 'dsh-remote-test', openTimeoutMs: 5000 };

test('findWebUrl extracts the authenticated URL with ANSI and trailing punctuation', () => {
	assert.equal(
		findWebUrl('\u001b[32mdsh web:\u001b[0m http://127.0.0.1:1234/?token=abc\n'),
		'http://127.0.0.1:1234/?token=abc',
	);
	assert.equal(findWebUrl('no url here'), undefined);
});

test('redactSecrets removes the token while keeping the URL shape', () => {
	const redacted = redactSecrets('dsh web: http://127.0.0.1:1234/?token=supersecret&x=1');
	assert.doesNotMatch(redacted, /supersecret/);
	assert.match(redacted, /http:\/\/127\.0\.0\.1:1234\//);
});

test('stripAnsi removes SGR sequences', () => {
	assert.equal(stripAnsi('\u001b[1;31mred\u001b[0m'), 'red');
});

test('InstanceManager starts a child, exposes a redacted view, and stops it', async () => {
	const { dir, runtime } = await tempRuntime(`#!/bin/sh
echo "dsh web: http://127.0.0.1:59999/?token=supersecret"
trap 'exit 0' TERM INT
while :; do sleep 1; done
`);
	const instances = new InstanceManager(config, runtime, dir);
	const host = { id: 'host_test' };
	const started = await instances.start(host, { profileName: 'p' });
	assert.equal(started.url, 'http://127.0.0.1:59999/?token=supersecret');
	const view = instances.view(host.id);
	assert.equal(view.phase, 'running');
	assert.equal(view.running, true);
	assert.equal(view.hasUrl, true);
	assert.doesNotMatch(view.logTail, /supersecret/);
	assert.equal(await readFile(instances.url(host.id) && join(dir, 'host_test.pid'), 'utf8').then(() => true), true);
	await instances.stop(host.id);
	assert.equal(instances.view(host.id).phase, 'idle');
	assert.equal(existsSync(join(dir, 'host_test.pid')), false);
});

test('InstanceManager reports a child that exits before printing a URL', async () => {
	const { dir, runtime } = await tempRuntime(`#!/bin/sh
echo "boom" >&2
exit 7
`);
	const instances = new InstanceManager(config, runtime, dir);
	await assert.rejects(instances.start({ id: 'host_fail' }, { profileName: 'p' }), /exited before printing/);
	assert.equal(instances.view('host_fail').phase, 'failed');
});

test('InstanceManager honours the open timeout and kills the child', async () => {
	const { dir, runtime } = await tempRuntime(`#!/bin/sh
trap 'exit 0' TERM INT
while :; do sleep 1; done
`);
	const instances = new InstanceManager({ ...config, openTimeoutMs: 300 }, runtime, dir);
	await assert.rejects(instances.start({ id: 'host_timeout' }, { profileName: 'p' }), /did not print its URL/);
});

test('InstanceManager cleanupStale ignores unrelated pid records', async () => {
	const { dir, runtime } = await tempRuntime('#!/bin/sh\nexit 0\n');
	await writeFile(join(dir, 'host_old.pid'), JSON.stringify({ pid: process.pid, hostId: 'host_old' }));
	const instances = new InstanceManager({ ...config, profileName: 'dsh-remote-unrelated' }, runtime, dir);
	await instances.cleanupStale();
	assert.equal(existsSync(join(dir, 'host_old.pid')), false);
});
