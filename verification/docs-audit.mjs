#!/usr/bin/env node
/**
 * Documentation audit: README (zh/en), architecture, locale and verification
 * command consistency.
 *
 *   node verification/docs-audit.mjs [--json verification/out/docs-audit.json]
 *
 * Read-only.
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import strict from 'node:assert/strict';
import { createSuite, assert, assertEqual } from './lib/checks.mjs';
import { repoRoot, dshRequire } from './lib/harness.mjs';

const yaml = dshRequire('js-yaml');
const suite = createSuite('docs-audit');
const read = (relative) => readFileSync(path.join(repoRoot, relative), 'utf8');

const ZH = read('README.md');
const EN = read('README.en.md');
const ARCH = read('docs/architecture.md');
const PKG = JSON.parse(read('package.json'));

const CONFIG_KEYS = [
	'sshExecutable', 'sshConfigPath', 'dataDir', 'profileName', 'sshPackageVersion',
	'helperPackage', 'helperRoot', 'npmRegistry', 'remoteNode', 'connectTimeoutMs',
	'commandTimeoutMs', 'installTimeoutMs', 'openTimeoutMs', 'inheritDesktopSettings',
	'mirrorWorkspace', 'permissionMode',
];
const HOST_FIELDS = [
	'alias', 'displayName', 'description', 'hostname', 'user', 'port', 'identityFile',
	'proxyJump', 'proxyCommand', 'identitiesOnly', 'forwardAgent', 'serverAliveInterval',
	'serverAliveCountMax', 'strictHostKeyChecking', 'userKnownHostsFile',
	'connectionAttempts', 'connectTimeout', 'extraOptions', 'remoteWorkspace', 'remoteHelperRoot',
];
const MODULES = [
	'index.js', 'lib/config.js', 'lib/paths.js', 'lib/store.js', 'lib/ssh-config.js',
	'lib/ssh.js', 'lib/validate.js', 'lib/errors.js', 'lib/helper.js', 'lib/doctor.js',
	'lib/runtime-profile.js', 'lib/overlay.js', 'lib/instance.js', 'lib/controller.js', 'lib/rpc.js',
	'lib/remote-reference.js', 'lib/remote-directory-picker.js', 'lib/pending-session.js',
	'lib/remote-workspaces.js', 'lib/remote-home.js',
	'lib/execution-router.js', 'lib/mixed-registry.js', 'lib/mixed-runtime.js',
	'runtime/remote-session-deeplink/index.js', 'runtime/remote-session-deeplink/client.js', 'client.js',
];
const ENDPOINTS = [
	'snapshot', 'saveHost', 'deleteHost', 'testConnection', 'doctor',
	'installHelper', 'openHost', 'openUrl', 'stopHost', 'remoteWorkspaces',
	'mixedWorkspaces', 'registerMixedWorkspace', 'removeMixedWorkspace',
];
const LEGACY = ['ssh_hosts', '@deepseek-ai/dsh-tools', 'settings.section', '四个 Host 工具', '模型可用 SSH 工具'];

/** Split fenced blocks, asserting that every fence is closed. */
function fences(text, language) {
	const lines = text.split('\n');
	const blocks = [];
	let current;
	for (const line of lines) {
		const match = /^```([\w+-]*)\s*$/.exec(line.trim());
		if (match === null) {
			if (current !== undefined) current.lines.push(line);
			continue;
		}
		if (current === undefined) current = { language: match[1], lines: [] };
		else {
			blocks.push({ language: current.language, body: current.lines.join('\n') });
			current = undefined;
		}
	}
	assert(current === undefined, `${language}: unclosed code fence`);
	return blocks;
}

/** Count the cells of every markdown table row, ignoring escaped pipes. */
function tables(text) {
	const tables = [];
	let block = [];
	const flush = () => {
		if (block.length === 0) return;
		const rows = block.filter((line) => !/^\s*\|?[\s:-]+\|/.test(line)).map((line) => line.replace(/\\\|/g, '').split('|').length);
		if (rows.length > 0) tables.push(rows);
		block = [];
	};
	for (const line of text.split('\n')) {
		if (/^\s*\|/.test(line)) block.push(line);
		else flush();
	}
	flush();
	return tables;
}

function keysInTable(text) {
	const keys = [];
	for (const match of text.matchAll(/^\|\s*`([A-Za-z][A-Za-z0-9]*)`\s*\|/gm)) keys.push(match[1]);
	return keys;
}

await suite.check('readme.headings', 'both READMEs carry the required sections', () => {
	for (const [label, text, headings] of [
		['zh', ZH, ['## 功能', '## 系统要求', '## 安装', '## 快速使用', '## 存储与 ssh_config', '## 配置项', '## 打开流程', '## 安全', '## 已知限制', '## 故障排查', '## 开发与验证']],
		['en', EN, ['## Features', '## Requirements', '## Installation', '## Quick start', '## Storage and ssh_config', '## Configuration', '## Open flow', '## Security', '## Known limitations', '## Troubleshooting', '## Development and verification']],
	]) {
		for (const heading of headings) assert(text.includes(heading), `${label}: missing ${heading}`);
	}
	return 'zh + en section parity';
});

await suite.check('readme.links', 'documented links resolve to real files', () => {
	const links = [...`${ZH}\n${EN}`.matchAll(/\]\(([^)#]+)\)/g)].map((m) => m[1]).filter((href) => !/^https?:/.test(href));
	for (const href of links) {
		assert(existsSync(path.join(repoRoot, href)), `broken link: ${href}`);
	}
	assert(existsSync(path.join(repoRoot, 'docs/architecture.md')));
	assert(existsSync(path.join(repoRoot, 'tests/rig/README.md')));
	return `${links.length} relative links`;
});

await suite.check('readme.config', 'config table lists all documented keys', () => {
	for (const [label, text] of [['zh', ZH], ['en', EN]]) {
		const keys = keysInTable(text);
		for (const key of CONFIG_KEYS) assert(keys.includes(key), `${label}: missing config key ${key}`);
		assert(keys.length >= CONFIG_KEYS.length, `${label}: too few keys`);
	}
	return `${CONFIG_KEYS.length} keys in both READMEs`;
});

await suite.check('readme.host-fields', 'host-level fields are documented', () => {
	for (const [label, text] of [['zh', ZH], ['en', EN]]) {
		for (const key of HOST_FIELDS) assert(text.includes(`\`${key}\``), `${label}: missing host field ${key}`);
	}
	return `${HOST_FIELDS.length} host fields`;
});

await suite.check('readme.fences', 'code fences are balanced and machine-readable blocks parse', () => {
	let total = 0;
	for (const [label, text] of [['zh', ZH], ['en', EN], ['architecture', ARCH]]) {
		const blocks = fences(text, label);
		total += blocks.length;
		for (const block of blocks) {
			if (block.language === 'yaml' || block.language === 'yml') yaml.load(block.body);
			if (block.language === 'json') JSON.parse(block.body);
		}
	}
	return `${total} fenced blocks`;
});

await suite.check('readme.tables', 'markdown tables have a consistent column count', () => {
	for (const [label, text] of [['zh', ZH], ['en', EN], ['architecture', ARCH]]) {
		const found = tables(text);
		assert(found.length > 0, `${label}: no tables`);
		for (const rows of found) {
			const reference = rows[0];
			for (const width of rows) strict.equal(width, reference, `${label}: table row has ${width} cells, expected ${reference}`);
		}
	}
	return 'consistent pipe tables';
});

await suite.check('architecture.modules', 'architecture maps every implementation module', () => {
	for (const module of MODULES) assert(ARCH.includes(module), `missing module ${module}`);
	for (const phase of ['checking', 'installing-helper', 'preparing-runtime', 'starting', 'running']) assert(ARCH.includes(phase), `missing phase ${phase}`);
	for (const endpoint of ENDPOINTS) assert(ARCH.includes(endpoint), `missing endpoint ${endpoint}`);
	return `${MODULES.length} modules, state machine, ${ENDPOINTS.length} endpoints`;
});

await suite.check('docs.legacy', 'no tool-era names survive in documentation', () => {
	for (const [label, text] of [['README.md', ZH], ['README.en.md', EN], ['docs/architecture.md', ARCH]]) {
		for (const legacy of LEGACY) assert(!text.includes(legacy), `${label}: legacy ${legacy}`);
	}
	return 'no model-tool residues';
});

await suite.check('docs.verification', 'documented verification commands exist', () => {
	for (const [name, command] of Object.entries(PKG.scripts)) {
		if (name.startsWith('verify:')) {
			const file = command.replace(/^node\s+/, '').trim();
			assert(existsSync(path.join(repoRoot, file)), `missing ${file}`);
			assert(ZH.includes(name) || ZH.includes('npm run verify'), `README does not mention ${name}`);
		}
	}
	assert(existsSync(path.join(repoRoot, 'verification/live-e2e.mjs')));
	return `${Object.keys(PKG.scripts).filter((name) => name.startsWith('verify:')).length} verify scripts`;
});

await suite.check('locale.metadata', 'locale JSON metadata agrees with package identity', () => {
	for (const file of ['locale/zh.json', 'locale/en.json']) {
		const value = JSON.parse(read(file));
		assert(typeof value.meta.description === 'string' && value.meta.description.length > 0, `${file} meta.description`);
		assert(typeof value.meta.title === 'string' && value.meta.title.length > 0, `${file} meta.title`);
	}
	return 'locale metadata';
});

await suite.check('readme.claims', 'README claims match the manifest', () => {
	for (const text of [ZH, EN]) {
		assert(text.includes('0.2.1-rc.2'), 'harness version');
		assert(text.includes('22.19.0'), 'node version');
		assert(text.includes('dsh-remote'), 'profile name');
		assert(text.includes('remote-ssh/hosts.json'), 'hosts path');
		assert(text.includes('ssh_config'), 'ssh config fragment');
	}
	return 'versions, profile and paths consistent';
});

const summary = suite.summary();
const outJson = path.join(repoRoot, 'verification/out/docs-audit.json');
const outTxt = path.join(repoRoot, 'verification/out/docs-audit.txt');
const payload = { generatedAt: new Date().toISOString(), title: suite.title, ...summary, results: suite.results };
mkdirSync(path.dirname(outJson), { recursive: true });
writeFileSync(outJson, `${JSON.stringify(payload, null, 2)}\n`);
writeFileSync(outTxt, `${suite.results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.id}  ${r.description}  ${r.notes.split('\n')[0]}`).join('\n')}\n\n${summary.passed} passed, ${summary.failed} failed, ${summary.total} total\n`);
process.exitCode = summary.failed === 0 ? 0 : 1;
