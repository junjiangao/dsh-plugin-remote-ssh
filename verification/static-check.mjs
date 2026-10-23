#!/usr/bin/env node
/**
 * Static verification of the remote-SSH bundle: manifest, module shape,
 * syntax, bundle patch, Config coverage and repository hygiene.
 *
 *   node verification/static-check.mjs [--json verification/out/static-check.json]
 *
 * Read-only.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import strict from 'node:assert/strict';
import { createSuite, assert, assertEqual } from './lib/checks.mjs';
import { repoRoot, dshRequire } from './lib/harness.mjs';

const suite = createSuite('static-check');
const read = (relative) => readFileSync(path.join(repoRoot, relative), 'utf8');
const json = (relative) => JSON.parse(read(relative));

const CONFIG_KEYS = [
	'sshExecutable', 'sshConfigPath', 'dataDir', 'profileName', 'sshPackageVersion',
	'helperPackage', 'helperRoot', 'npmRegistry', 'remoteNode', 'connectTimeoutMs',
	'commandTimeoutMs', 'installTimeoutMs', 'openTimeoutMs', 'inheritDesktopSettings',
	'mirrorWorkspace', 'permissionMode',
];
const LEGACY = ['ssh_exec', 'ssh_upload', 'ssh_download', 'ssh_hosts', '@deepseek-ai/dsh-tools', 'settings.section'];

await suite.check('pkg.identity', 'package name, version and engines', () => {
	const pkg = json('package.json');
	assertEqual(pkg.name, '@junjiangao/dsh-plugin-remote-ssh', 'name');
	strict.match(pkg.version, /^\d+\.\d+\.\d+$/);
	strict.equal(pkg.type, 'module');
	strict.equal(pkg.engines.node, '^22.19.0 || >=24.0.0');
	strict.match(pkg.engines.dsh, /0\.2\.1-rc\.2/);
	return `${pkg.name}@${pkg.version}`;
});

await suite.check('pkg.bundle', 'dsh.bundle patch and client entry are declared', () => {
	const pkg = json('package.json');
	assertEqual(pkg.dsh.bundle.patch, './cordis.patch.yml');
	strict.equal(pkg.dsh.client.platform, 'web');
	assert(Array.isArray(pkg.dsh.client.inject) && pkg.dsh.client.inject.length >= 4);
	assert(existsSync(path.join(repoRoot, 'cordis.patch.yml')));
	assert(existsSync(path.join(repoRoot, 'client.js')));
	for (const file of ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'README.md', 'README.en.md']) {
		assert(pkg.files.includes(file), `${file} missing from files[]`);
	}
	return `${pkg.dsh.client.inject.length} client packages in inject`;
});

await suite.check('bundle.patch', 'bundle patch disables the three base providers and inserts one remote-ssh row', () => {
	const yaml = dshRequire('js-yaml');
	const parsed = yaml.load(read('cordis.patch.yml'));
	assert(Array.isArray(parsed) && parsed.length === 4);
	const disabled = parsed.filter((row) => row.disabled === true).map((row) => row.id);
	strict.deepEqual(disabled, ['subprocess', 'sandbox', 'fs-sandbox']);
	const inserts = parsed.filter((row) => Array.isArray(row.insert));
	assert(inserts.length === 1);
	const rows = inserts[0].insert;
	assert(Array.isArray(rows) && rows.length === 1);
	assertEqual(rows[0].id, 'remote-ssh');
	assertEqual(rows[0].name, '@junjiangao/dsh-plugin-remote-ssh');
	strict.deepEqual(rows[0].config, {});
	return 'disable subprocess/sandbox/fs-sandbox + insert remote-ssh';
});

await suite.check('source.syntax', 'every JavaScript module parses', () => {
	const files = ['index.js', 'client.js', ...readdirSync(path.join(repoRoot, 'lib')).filter((f) => f.endsWith('.js')).map((f) => `lib/${f}`)];
	for (const file of files) {
		const result = spawnSync(process.execPath, ['--check', path.join(repoRoot, file)], { encoding: 'utf8' });
		if (result.status !== 0) throw new Error(`${file}: ${result.stderr.trim()}`);
	}
	return `${files.length} modules`;
});

await suite.check('index.shape', 'Host entry exports name/inject/Config/apply and no tools', () => {
	const text = read('index.js');
	assert(/export const name = 'remote-ssh'/.test(text), 'name export');
	assert(/export const inject = \['connection'\]/.test(text), 'inject export');
	assert(/export \{ Config \}/.test(text), 'Config export');
	assert(/export async function apply\(/.test(text), 'apply export');
	assert(!text.includes('ctx.tools'), 'must not register tools');
	for (const legacy of LEGACY) assert(!text.includes(legacy), `legacy symbol ${legacy}`);
	return 'connection-only Host plugin';
});

await suite.check('config.keys', 'Config covers every documented key', () => {
	const text = read('lib/config.js');
	for (const key of CONFIG_KEYS) assert(new RegExp(`\\b${key}:`).test(text), `missing ${key}`);
	assert(!text.includes('allowedHosts'), 'old allowlist must be gone');
	return `${CONFIG_KEYS.length} keys`;
});

await suite.check('client.module', 'client module uses the Harness loader and only react', () => {
	const text = read('client.js');
	assert(/window\.__ModuleLoader__\.load\(\{/.test(text), 'ModuleLoader.load');
	assert(/id: '@junjiangao\/dsh-plugin-remote-ssh'/.test(text), 'module id');
	const requires = [...new Set([...text.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]))];
	strict.deepEqual(requires, ['react']);
	assert(
		text.includes("inject = ['connection', 'slots', 'locale', 'workspaces', 'uiWorkspace']"),
		'client inject',
	);
	assert(!text.includes('document.cookie'));
	return `requires ${requires.join(', ')}`;
});

await suite.check('locale.files', 'locale JSON files are valid', () => {
	for (const file of ['locale/zh.json', 'locale/en.json']) {
		const value = json(file);
		assert(value.meta && typeof value.meta.title === 'string' && value.meta.title.length > 0);
	}
	return 'zh/en metadata';
});

await suite.check('icon.svg', 'icon is a self-contained SVG', () => {
	const text = read('icon.svg').trim();
	assert(text.startsWith('<svg') && text.endsWith('</svg>'));
	assert(/viewBox="0 0 24 24"/.test(text));
	assert(!/(?:href|src)="https?:\/\//.test(text), 'no remote references');
	return '24x24 inline SVG';
});

await suite.check('hygiene.legacy', 'no legacy tool-era source files or symbols', () => {
	for (const file of ['lib/tools.js', 'lib/hosts.js', 'lib/shell.js']) assert(!existsSync(path.join(repoRoot, file)), `${file} must be deleted`);
	const packageText = read('package.json');
	for (const legacy of ['ssh_exec', 'ssh_upload', 'ssh_download', 'dsh-tools']) assert(!packageText.includes(legacy), legacy);
	return 'legacy files and strings absent';
});

await suite.check('docs.exist', 'documentation and verification entry points exist', () => {
	for (const file of ['README.md', 'README.en.md', 'docs/architecture.md', 'verification/static-check.mjs', 'verification/client-audit.mjs', 'verification/docs-audit.mjs', 'verification/e2e.mjs']) {
		assert(existsSync(path.join(repoRoot, file)), `${file} missing`);
	}
	return 'README + architecture + 4 verification scripts';
});

const summary = suite.summary();
const outJson = path.join(repoRoot, 'verification/out/static-check.json');
const outTxt = path.join(repoRoot, 'verification/out/static-check.txt');
const payload = { generatedAt: new Date().toISOString(), title: suite.title, ...summary, results: suite.results };
const { mkdirSync, writeFileSync } = await import('node:fs');
mkdirSync(path.dirname(outJson), { recursive: true });
writeFileSync(outJson, `${JSON.stringify(payload, null, 2)}\n`);
writeFileSync(outTxt, `${suite.results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.id}  ${r.description}  ${r.notes.split('\n')[0]}`).join('\n')}\n\n${summary.passed} passed, ${summary.failed} failed, ${summary.total} total\n`);
process.exitCode = summary.failed === 0 ? 0 : 1;
