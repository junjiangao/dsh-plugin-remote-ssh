import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { overlayPath, renderOverlay, writeOverlay, yamlString } from '../../lib/overlay.js';

const host = { id: 'host_0123456789abcdef', alias: 'prod' };
const base = {
	host,
	workspace: '/srv/app',
	nodePath: '/usr/bin/node',
	helperPath: '/home/me/.dsh-remote-ssh/helper/0.2.1-rc.2/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js',
	helperHash: 'a'.repeat(64),
	permissionMode: 'workspace-write',
};

test('renderOverlay disables local providers and inserts exactly one SSH family', () => {
	const text = renderOverlay(base);
	for (const id of ['subprocess', 'sandbox', 'fs-sandbox', 'ptc-runtime', 'workflow-ptc', 'open-in-app', 'ui-open-in-app']) {
		assert.match(text, new RegExp(`- id: ${id}\\n  disabled: true`));
	}
	assert.match(text, /workspaceRoot: '\/srv\/app'/);
	assert.match(text, /searchProvider: !!js undefined/);
	for (const id of ['ssh', 'fs-ssh', 'subprocess-ssh', 'sandbox-ssh']) {
		assert.match(text, new RegExp(`- id: ${id}\\n`));
	}
	assert.match(text, /host: 'prod'/);
	assert.match(text, /helperHash: 'a{64}'/);
	assert.doesNotMatch(text, /token|password|secret/i);
});

test('renderOverlay disables the local file scanner and inserts the remote provider', () => {
	const text = renderOverlay({ ...base, referencePluginPath: '/home/me/remote-file-reference.mjs' });
	assert.match(text, /- id: file-reference-local\n  disabled: true/);
	assert.match(text, /- id: remote-file-reference\n      name: '\/home\/me\/remote-file-reference\.mjs'/);
});

test('renderOverlay rejects non-absolute paths and an invalid digest', () => {
	assert.throws(() => renderOverlay({ ...base, workspace: 'relative' }), /workspace/);
	assert.throws(() => renderOverlay({ ...base, nodePath: 'node' }), /nodePath/);
	assert.throws(() => renderOverlay({ ...base, helperHash: 'ABC' }), /helperHash/);
});

test('yamlString quotes single quotes and rejects control characters', () => {
	assert.equal(yamlString("it's"), "'it''s'");
	assert.throws(() => yamlString('a\nb'), /control/);
});

test('renderOverlay keeps the legacy shape when the remote UI plugins are not configured', () => {
	const text = renderOverlay(base);
	assert.doesNotMatch(text, /directory-picker/);
	assert.doesNotMatch(text, /remote-session-deeplink/);
});

test('renderOverlay replaces the auto picker and mounts the remote browse backend', () => {
	const text = renderOverlay({
		...base,
		directoryPickerPluginPath: '/home/me/.dsh/profiles/dsh-remote/remote-directory-picker.mjs',
		mirrorWorkspace: true,
	});
	assert.match(text, /- id: directory-picker\n  disabled: true/);
	assert.match(
		text,
		/- id: remote-directory-picker\n      name: '\/home\/me\/\.dsh\/profiles\/dsh-remote\/remote-directory-picker\.mjs'\n      config:\n        mirrorWorkspace: true\n        workspace: '\/srv\/app'/,
	);
	assert.match(text, /- id: ui-directory-picker-browse\n      name: '@deepseek-ai\/dsh-client-ui-directory-picker-browse'/);
	// The legacy file-reference row is independent of the picker replacement.
	assert.doesNotMatch(text, /- id: remote-file-reference/);
});

test('renderOverlay maps mirrorWorkspace off unless it is exactly true', () => {
	const path = '/home/me/remote-directory-picker.mjs';
	assert.match(renderOverlay({ ...base, directoryPickerPluginPath: path }), /mirrorWorkspace: false/);
	assert.match(renderOverlay({ ...base, directoryPickerPluginPath: path, mirrorWorkspace: 'yes' }), /mirrorWorkspace: false/);
	assert.match(renderOverlay({ ...base, directoryPickerPluginPath: path, mirrorWorkspace: false }), /mirrorWorkspace: false/);
});

test('renderOverlay mounts the one-shot Session deeplink entry by absolute path', () => {
	const text = renderOverlay({
		...base,
		deeplinkEntryPath: "/home/me/remote-ssh's/profile/plugins/remote-session-deeplink/index.js",
	});
	assert.match(text, /- id: remote-session-deeplink\n      name: '\/home\/me\/remote-ssh''s\/profile\/plugins\/remote-session-deeplink\/index\.js'/);
	assert.doesNotMatch(text, /- id: directory-picker/);
});

test('renderOverlay rejects relative remote-UI plugin paths', () => {
	assert.throws(() => renderOverlay({ ...base, directoryPickerPluginPath: 'remote-directory-picker.mjs' }), /directoryPickerPluginPath/);
	assert.throws(() => renderOverlay({ ...base, deeplinkEntryPath: 'plugins/remote-session-deeplink/index.js' }), /deeplinkEntryPath/);
});

test('writeOverlay writes a 0600 file at the documented path', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'rssh-overlay-'));
	const text = renderOverlay(base);
	const file = await writeOverlay(dir, 'host_x', text);
	assert.equal(file, overlayPath(dir, 'host_x'));
	assert.equal((await stat(file)).mode & 0o777, 0o600);
	assert.equal(await readFile(file, 'utf8'), text);
});
