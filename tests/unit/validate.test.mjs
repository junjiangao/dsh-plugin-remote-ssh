import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAlias, validateHostDraft, expandRemotePath, STRICT_MODES } from '../../lib/validate.js';

test('validateHostDraft normalizes the supported ssh parameters', () => {
	const draft = validateHostDraft({
		alias: 'prod-web',
		hostname: '10.0.0.5',
		user: 'ubuntu',
		port: '2222',
		identityFile: '~/.ssh/id_ed25519',
		proxyJump: 'bastion.example.com',
		proxyCommand: 'nc -X 5 -x 127.0.0.1:7897 %h %p',
		identitiesOnly: true,
		forwardAgent: false,
		serverAliveInterval: '30',
		serverAliveCountMax: '3',
		strictHostKeyChecking: 'yes',
		userKnownHostsFile: '~/.ssh/known_hosts',
		connectionAttempts: '2',
		connectTimeout: '10',
		extraOptions: [{ key: 'Compression', value: 'yes' }],
		remoteWorkspace: '~/code',
		remoteHelperRoot: '/opt/dsh-helper',
	});
	assert.equal(draft.alias, 'prod-web');
	assert.equal(draft.port, 2222);
	assert.equal(draft.serverAliveInterval, 30);
	assert.equal(draft.strictHostKeyChecking, 'yes');
	assert.deepEqual(draft.extraOptions, [{ key: 'Compression', value: 'yes' }]);
	assert.equal(draft.remoteWorkspace, '~/code');
	assert.equal(draft.remoteHelperRoot, '/opt/dsh-helper');
});

test('validateAlias rejects unsafe or empty aliases', () => {
	for (const value of ['', 'a b', '-bad', 'bad\nhost', 'x'.repeat(65), '中文']) {
		assert.throws(() => validateAlias(value), /alias/);
	}
	assert.equal(validateAlias('A.b_c-1'), 'A.b_c-1');
});

test('validateHostDraft enforces ranges and emits field names', () => {
	assert.throws(() => validateHostDraft({ alias: 'a', hostname: 'h', port: 0 }), /port/);
	assert.throws(() => validateHostDraft({ alias: 'a', hostname: 'h', port: 65536 }), /port/);
	assert.throws(() => validateHostDraft({ alias: 'a', hostname: 'h', connectTimeout: 601 }), /connectTimeout/);
	assert.throws(() => validateHostDraft({ alias: 'a', hostname: 'h', strictHostKeyChecking: 'ask' }), /strictHostKeyChecking/);
	assert.throws(() => validateHostDraft({ alias: 'a', hostname: 'h', remoteWorkspace: 'relative/path' }), /remoteWorkspace/);
});

test('extraOptions rejects reserved or duplicate directives', () => {
	assert.throws(
		() => validateHostDraft({ alias: 'a', hostname: 'h', extraOptions: [{ key: 'Host', value: 'x' }] }),
		/extraOptions/,
	);
	assert.throws(
		() => validateHostDraft({ alias: 'a', hostname: 'h', extraOptions: [{ key: 'Compression', value: 'yes' }, { key: 'compression', value: 'no' }] }),
		/repeats/,
	);
});

test('STRICT_MODES is the documented closed set', () => {
	assert.deepEqual(STRICT_MODES, ['accept-new', 'yes', 'no']);
});

test('expandRemotePath expands only ~ and ~/ prefixes', () => {
	assert.equal(expandRemotePath('~', '/home/me'), '/home/me');
	assert.equal(expandRemotePath('~/code', '/home/me'), '/home/me/code');
	assert.equal(expandRemotePath('/srv/code', '/home/me'), '/srv/code');
	assert.equal(expandRemotePath(undefined, '/home/me'), undefined);
});
