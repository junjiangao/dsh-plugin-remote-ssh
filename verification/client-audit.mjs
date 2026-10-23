#!/usr/bin/env node
/**
 * Static audit of the Web client half (`client.js`): module format, slot
 * registration, RPC contract, locale parity, forbidden legacy symbols.
 *
 *   node verification/client-audit.mjs [--json verification/out/client-audit.json]
 *
 * No browser involved. Read-only.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import strict from 'node:assert/strict';
import { createSuite, assert } from './lib/checks.mjs';
import { repoRoot } from './lib/harness.mjs';
import { ENDPOINTS } from '../lib/rpc.js';

const suite = createSuite('client-audit');
const CLIENT = readFileSync(path.join(repoRoot, 'client.js'), 'utf8');
const PKG = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

/** Slice a balanced `{ … }` literal that starts at or after `start`. */
function objectLiteral(text, start) {
	const open = text.indexOf('{', start);
	assert(open !== -1, 'object literal not found');
	let depth = 0;
	let quote;
	for (let i = open; i < text.length; i += 1) {
		const ch = text[i];
		if (quote !== undefined) {
			if (ch === '\\') i += 1;
			else if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === "'" || ch === '"' || ch === '`') quote = ch;
		else if (ch === '{') depth += 1;
		else if (ch === '}') {
			depth -= 1;
			if (depth === 0) return text.slice(open + 1, i);
		}
	}
	throw new Error('unterminated object literal');
}

/** Flat locale keys, including quoted dotted keys. */
function localeKeys(block, label) {
	const keys = [];
	for (const match of block.matchAll(/^\s*(?:'([^']+)'|([A-Za-z_$][\w$]*))\s*:/gm)) {
		keys.push(match[1] ?? match[2]);
	}
	assert(keys.length > 100, `${label}: expected a populated dictionary, got ${keys.length}`);
	return keys;
}

const zh = localeKeys(objectLiteral(CLIENT, CLIENT.indexOf('const zh = ')), 'zh');
const en = localeKeys(objectLiteral(CLIENT, CLIENT.indexOf('const en = ')), 'en');
const REQUIRED_LOCALE = [
	'panel', 'addHost', 'editTitle', 'deleteTitle', 'save', 'cancel', 'test', 'open',
	'installTitle', 'installCommandLabel', 'helperMissing', 'helperMismatch', 'remoteHelperRootLabel',
	'errors.aliasFormat', 'errors.remoteHelperRootPath',
	'workspacePanel', 'workspaceEmptyTitle', 'workspaceOpenHost', 'workspaceSessionOpen', 'workspaceHelperHint',
];

await suite.check('module.loader', 'client uses the Harness ModuleLoader entry', () => {
	assert(/window\.__ModuleLoader__\.load\(\{/.test(CLIENT), 'missing ModuleLoader.load');
	strict.match(CLIENT, /id: '@junjiangao\/dsh-plugin-remote-ssh'/);
	strict.match(PKG.dsh.client.inject.join(','), /connection/);
	const requires = [...new Set([...CLIENT.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]))];
	strict.deepEqual(requires, ['react']);
	return 'module id + react-only require';
});

await suite.check('slots.registration', 'both sidebar entries share stable ids with their main panels', () => {
	strict.match(CLIENT, /const PANEL_ID = 'remote-ssh'/);
	strict.match(CLIENT, /const WORKSPACE_PANEL_ID = 'remote-workspace'/);
	const sidebarIds = [...CLIENT.matchAll(/name: 'sidebar\.panellist',\s*\n\s*id: (\w+),/g)].map((match) => match[1]);
	strict.deepEqual(sidebarIds, ['PANEL_ID', 'WORKSPACE_PANEL_ID']);
	const mainKeys = [...CLIENT.matchAll(/name: 'main',\s*\n\s*key: (\w+),/g)].map((match) => match[1]);
	strict.deepEqual(mainKeys, ['PANEL_ID', 'WORKSPACE_PANEL_ID']);
	strict.match(CLIENT, /order: 20,/);
	strict.match(CLIENT, /order: 21,/);
	assert(CLIENT.includes("ctx.slots.inject('sidebar.panellist'"), 'sidebar inject');
	assert(CLIENT.includes("ctx.slots.inject('main'"), 'main inject');
	return 'remote-ssh(20) + remote-workspace(21) ↔ matching main keys';
});

await suite.check('rpc.contract', 'client endpoints and bridge match the Host contract', () => {
	strict.match(CLIENT, /const API_CHANNEL = '\/api'/);
	strict.match(CLIENT, /const API_PREFIX = 'remote-ssh'/);
	const called = [...CLIENT.matchAll(/call\('([A-Za-z]+)'/g)].map((m) => m[1]);
	strict.deepEqual(called.sort(), [...ENDPOINTS].sort());
	strict.match(CLIENT, /rpc\.call\(API_CHANNEL, `\$\{API_PREFIX\}\/\$\{endpoint\}`/);
	assert(CLIENT.includes("failure.code = error.code"), 'structured error code');
	assert(CLIENT.includes("failure.details = error.details"), 'structured error details');
	return `${called.length} endpoints`;
});

await suite.check('locale.parity', 'zh/en locale dictionaries have identical keys', () => {
	strict.deepEqual([...zh].sort(), [...en].sort());
	for (const key of REQUIRED_LOCALE) assert(zh.includes(key), `missing zh key ${key}`);
	return `${zh.length} keys in both dictionaries`;
});

await suite.check('ux.open-confirm', 'open path checks helper and asks before installing', () => {
	assert(CLIENT.includes("status !== 'installed'"), 'missing helper status guard');
	assert(CLIENT.includes('const diagnosis = await api.doctor('), 'preflight must use read-only doctor');
	assert(CLIENT.includes('openHostNow(host, false)'), 'direct open must not auto-install');
	assert(CLIENT.includes('openHostNow(host, true)'), 'confirmed install must pass allowInstall');
	assert(CLIENT.includes('setInstallDetails('), 'install details shown');
	assert(CLIENT.includes('installCommand'), 'install command displayed');
	return 'doctor preflight → confirm → installHelper → openHost(allowInstall)';
});

await suite.check('workspace.panel', 'remote workspace panel scans hosts and opens a session deep link', () => {
	assert(CLIENT.includes('api.remoteWorkspaces('), 'workspace scan uses the RPC bridge');
	assert(CLIENT.includes('const WORKSPACE_POLL_MS'), 'visible-only poll interval');
	assert(CLIENT.includes('host.workspaces'), 'panel groups sessions by host workspace');
	assert(CLIENT.includes('payload.sessionId = sessionId'), 'session click forwards the session id to openHost');
	assert(CLIENT.includes('await api.openHost(payload)'), 'session click starts the remote window');
	assert(CLIENT.includes('await api.openUrl({ id })'), 'running window URL is fetched before opening');
	assert(CLIENT.includes("window.open(url, '_blank', 'noopener')"), 'URL opens in a new tab without opener');
	assert(CLIENT.includes("instance.phase === 'failed'"), 'failed start surfaces the instance error');
	assert(CLIENT.includes("'session:' + str(host.id) + ':' + sessionId"), 'per-session pending key');
	assert(CLIENT.includes('workspaceSessionBlank'), 'blank sessions are kept and visually weakened');
	assert(CLIENT.includes('workspaceEmptyHost'), 'hosts without sessions have an empty state');
	return 'scan → group by host/workspace → openHost(sessionId) → poll snapshot → openUrl → window.open';
});

await suite.check('ux.advanced-fields', 'advanced HostView fields round-trip through the form', () => {
	for (const key of ['identitiesOnly', 'forwardAgent', 'serverAliveInterval', 'serverAliveCountMax',
		'strictHostKeyChecking', 'userKnownHostsFile', 'connectionAttempts', 'connectTimeout',
		'extraOptions', 'remoteHelperRoot']) {
		assert(CLIENT.includes(`'${key}'`) || CLIENT.includes(`\"${key}\"`), `missing field ${key}`);
		assert(CLIENT.includes(`fieldId('${key}')`) || CLIENT.includes(`key: '${key}'`), `missing form control ${key}`);
	}
	assert(CLIENT.includes('advancedKnown'), 'missing unknown-field preservation');
	assert(CLIENT.includes("put('remoteHelperRoot')"), 'remoteHelperRoot serialization');
	return '10 advanced fields + advancedKnown';
});

await suite.check('security.client', 'no direct fetch, HTML injection, or token logging', () => {
	assert(!/\bfetch\s*\(/.test(CLIENT), 'client must use connection.rpc, not fetch');
	assert(!CLIENT.includes('innerHTML'), 'no innerHTML');
	assert(!CLIENT.includes('dangerouslySetInnerHTML'), 'no dangerouslySetInnerHTML');
	assert(!/console\.(log|info|debug)\(/.test(CLIENT), 'no console logging');
	assert(!CLIENT.includes('localStorage'), 'no persistence of URLs/tokens');
	return 'rpc-only, no DOM injection, no client persistence';
});

await suite.check('hygiene.legacy', 'old settings-section/tool-era client code is gone', () => {
	for (const legacy of ['settings.section', 'ssh_exec', 'ssh_upload', 'ssh_download', '@deepseek-ai/dsh-tools']) {
		assert(!CLIENT.includes(legacy), `legacy symbol ${legacy}`);
	}
	assert(PKG.files.includes('client.js'));
	return 'no legacy symbols';
});

await suite.check('theme.tokens', 'both panels use Harness theme variables and scoped prefixes', () => {
	assert((CLIENT.match(/--dsw-/g) ?? []).length >= 5, 'expected theme tokens');
	strict.match(CLIENT, /const PREFIX = 'rssh'/);
	strict.match(CLIENT, /const WORKSPACE_PREFIX = 'rsw'/);
	assert(CLIENT.includes('${PREFIX}_'), 'expected remote-ssh class prefix');
	assert(CLIENT.includes('${WORKSPACE_PREFIX}_'), 'expected remote-workspace class prefix');
	return `${(CLIENT.match(/--dsw-/g) ?? []).length} theme token uses, 2 prefixes`;
});

const summary = suite.summary();
const outJson = path.join(repoRoot, 'verification/out/client-audit.json');
const outTxt = path.join(repoRoot, 'verification/out/client-audit.txt');
const payload = { generatedAt: new Date().toISOString(), title: suite.title, ...summary, results: suite.results };
mkdirSync(path.dirname(outJson), { recursive: true });
writeFileSync(outJson, `${JSON.stringify(payload, null, 2)}\n`);
writeFileSync(outTxt, `${suite.results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.id}  ${r.description}  ${r.notes.split('\n')[0]}`).join('\n')}\n\n${summary.passed} passed, ${summary.failed} failed, ${summary.total} total\n`);
process.exitCode = summary.failed === 0 ? 0 : 1;
