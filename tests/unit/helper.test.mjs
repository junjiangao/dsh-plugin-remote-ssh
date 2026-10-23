import test from 'node:test';
import assert from 'node:assert/strict';
import { helperInstallCommand, isSupportedNode, parseNodeVersion } from '../../lib/helper.js';

const config = {
	helperPackage: '@deepseek-ai/dsh-ssh',
	sshPackageVersion: '0.2.1-rc.2',
	helperRoot: '~/.dsh-remote-ssh/helper',
};

test('parse and range-check remote Node versions', () => {
	assert.deepEqual(parseNodeVersion('v24.15.0'), { major: 24, minor: 15, patch: 0 });
	assert.deepEqual(parseNodeVersion('22.19.0'), { major: 22, minor: 19, patch: 0 });
	assert.equal(parseNodeVersion('not-a-version'), undefined);
	assert.equal(isSupportedNode('22.19.0'), true);
	assert.equal(isSupportedNode('22.18.9'), false);
	assert.equal(isSupportedNode('24.0.0'), true);
	assert.equal(isSupportedNode('20.11.1'), false);
});

test('helperInstallCommand uses the discovered absolute npm and node directory', () => {
	const command = helperInstallCommand(config, { alias: 'remote' }, '/home/user', '0.2.1-rc.2', {
		nodePath: '/home/user/.local/share/fnm/aliases/default/bin/node',
		npmPath: '/home/user/.local/share/fnm/aliases/default/bin/npm',
	});
	assert.match(command, /^PATH='\/home\/user\/\.local\/share\/fnm\/aliases\/default\/bin':\$PATH '\/home\/user\/\.local\/share\/fnm\/aliases\/default\/bin\/npm' install /);
	assert.match(command, /--prefix '\/home\/user\/\.dsh-remote-ssh\/helper\/0\.2\.1-rc\.2'/);
	assert.match(command, /'@deepseek-ai\/dsh-ssh@0\.2\.1-rc\.2'$/);
});

test('helperInstallCommand prefers a configured remoteNode directory', () => {
	const command = helperInstallCommand(config, { alias: 'remote' }, '/home/user', '0.2.1-rc.2', {
		nodePath: '/home/user/.local/share/fnm/aliases/default/bin/node',
		npmPath: '/home/user/.local/share/fnm/aliases/default/bin/npm',
	});
	assert.match(command, /PATH='\/home\/user\/\.local\/share\/fnm\/aliases\/default\/bin':\$PATH/);
	const overridden = helperInstallCommand(
		{ ...config, remoteNode: '/opt/node-24/bin/node' },
		{ alias: 'remote' },
		'/home/user',
		'0.2.1-rc.2',
		{ nodePath: '/home/user/.local/share/fnm/aliases/default/bin/node', npmPath: '/usr/bin/npm' },
	);
	assert.match(overridden, /^PATH='\/opt\/node-24\/bin':\$PATH '\/usr\/bin\/npm' install /);
});

test('helperInstallCommand falls back to plain npm without remote facts', () => {
	const command = helperInstallCommand(config, { alias: 'remote' }, '~', '0.2.1-rc.2');
	assert.match(command, /^npm install --prefix /);
});
