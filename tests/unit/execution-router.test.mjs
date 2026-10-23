/**
 * Execution router: world selection is the safety-critical piece of mixed mode.
 * These tests exercise the pure routing table without mounting any provider.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ExecutionRouter, ambientWorld, isUnder, normalizePath } from '../../lib/execution-router.js';

/** Build one router with a fake local world and one fake remote mount. */
function makeRouter() {
	const router = new ExecutionRouter({}, {
		runtimeDir: '/opt/dsh',
		profileDir: '/home/me/.dsh/profiles/dsh-remote',
		dataDir: '/home/me/.dsh/remote-ssh',
		version: '0.2.1-rc.2',
		localCwd: '/work',
	});
	const local = { kind: 'local', id: 'local', root: undefined };
	const remote = { kind: 'remote', id: 'host_a', root: '/home/me/project' };
	router.local = local;
	router.mounts = [{
		id: 'mixed_1',
		hostId: 'host_a',
		hostAlias: 'alpha',
		mountPath: '/home/me/.dsh/remote-ssh/mixed/mounts/host_a/home-me-project',
		remotePath: '/home/me/project',
		world: remote,
	}];
	return { router, local, remote };
}

test('paths below a mount map to the remote world', () => {
	const { router, remote } = makeRouter();
	const mount = router.mounts[0].mountPath;
	const hit = router.routePath(mount + '/src/a.ts');
	assert.equal(hit.world, remote);
	assert.equal(hit.path, '/home/me/project/src/a.ts');
	assert.equal(hit.cwd, undefined);
});

test('relative paths resolve against the mirror cwd', () => {
	const { router, remote } = makeRouter();
	const mount = router.mounts[0].mountPath;
	const hit = router.routePath('src/a.ts', mount);
	assert.equal(hit.world, remote);
	assert.equal(hit.path, '/home/me/project/src/a.ts');
	assert.equal(hit.cwd, '/home/me/project');
});

test('absolute paths outside the mount belong to the remote world while cwd is remote', () => {
	const { router, remote } = makeRouter();
	const mount = router.mounts[0].mountPath;
	const hit = router.routePath('/etc/hostname', mount);
	assert.equal(hit.world, remote);
	assert.equal(hit.path, '/etc/hostname');
});

test('local paths stay local', () => {
	const { router, local } = makeRouter();
	const hit = router.routePath('/tmp/local.txt', '/work');
	assert.equal(hit.world, local);
	assert.equal(hit.path, '/tmp/local.txt');
	assert.equal(hit.cwd, '/work');
});

test('ambient world routes cwd-less absolute remote paths', () => {
	const { router, remote } = makeRouter();
	const outside = ambientWorld.run(remote, () => router.routePath('/home/me/project/README.md'));
	assert.equal(outside.world, remote);
	assert.equal(outside.path, '/home/me/project/README.md');
	const localLookup = ambientWorld.run(remote, () => router.routePath('/tmp/x'));
	assert.equal(localLookup.world, remote);
	const relative = ambientWorld.run(remote, () => router.routePath('README.md'));
	assert.equal(relative.world, remote);
	assert.equal(relative.path, '/home/me/project/README.md');
	const record = ambientWorld.run({ world: remote, cwd: '/home/me/project/sub' }, () => router.routePath('a.txt'));
	assert.equal(record.world, remote);
	assert.equal(record.path, '/home/me/project/sub/a.txt');
});

test('longest mount wins for nested registrations', () => {
	const { router, remote } = makeRouter();
	const outer = router.mounts[0];
	const inner = {
		...outer,
		id: 'mixed_2',
		mountPath: outer.mountPath + '/vendor',
		remotePath: '/home/me/project/vendor',
	};
	router.mounts = [inner, outer];
	assert.equal(router.routePath(outer.mountPath + '/vendor/lib.js').path, '/home/me/project/vendor/lib.js');
	assert.equal(router.routePath(outer.mountPath + '/other/lib.js').path, '/home/me/project/other/lib.js');
	assert.equal(router.matchMount(outer.mountPath + '/vendor/lib.js').id, 'mixed_2');
});

test('sandbox policies are translated into the remote namespace', () => {
	const { router, remote } = makeRouter();
	const mount = router.mounts[0].mountPath;
	const policy = router.mapPolicy(remote, { mode: 'workspace-write', workspaceRoot: mount });
	assert.equal(policy.workspaceRoot, '/home/me/project');
	const local = router.mapPolicy(router.local, { mode: 'workspace-write', workspaceRoot: '/work' });
	assert.equal(local.workspaceRoot, '/work');
	assert.equal(router.mapPolicy(remote, undefined), undefined);
});

test('local-only Node processes bypass remote routing', async () => {
	const { router } = makeRouter();
	router.localExecutableRoots = [process.execPath, '/opt/dsh'];
	assert.equal(router.maybeForceLocal([process.execPath, '/tmp/program.mjs']), true);
	assert.equal(router.maybeForceLocal(['/bin/sh', '-c', 'echo hi']), false);
	assert.equal(router.maybeForceLocal(['bash', '-c', 'echo hi']), false);
	const dir = await mkdtemp(join(tmpdir(), 'rssh-router-'));
	try {
		const script = join(dir, 'program.mjs');
		await writeFile(script, 'export {}\n', 'utf8');
		router.runtimeDir = '/opt/dsh';
		router.resourcesRoot = '/opt/resources';
		router.localExecutableRoots = [process.execPath, '/opt/dsh'];
		assert.equal(router.maybeForceLocal([process.execPath, script]), true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('path helpers agree on containment', () => {
	assert.equal(isUnder('/a', '/a'), true);
	assert.equal(isUnder('/a', '/a/b'), true);
	assert.equal(isUnder('/a', '/ab'), false);
	assert.equal(normalizePath('/a//b/../c'), '/a/c');
});
