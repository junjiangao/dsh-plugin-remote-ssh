#!/usr/bin/env node
/**
 * Documentation audit for the translated READMEs (task-7 item 6).
 *
 *   node verification/docs-audit.mjs [--json verification/out/docs-audit.json]
 *
 * Translation is exactly the kind of change that silently renames an identifier
 * or breaks a table, so this checks the Chinese README against the English one
 * mechanically instead of trusting it:
 *   - fenced code blocks are balanced and every ```yaml block parses,
 *   - the YAML override examples are deep-equal (same keys AND values),
 *   - the config-key table lists all eight keys, in the same order,
 *   - every markdown table has a consistent column count,
 *   - the four tool headings and all frozen identifiers survive untranslated,
 *   - inline code spans are balanced per line,
 *   - the Chinese rig README keeps every command/flag/JSON field verbatim.
 *
 * Read-only.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createSuite, assert, assertEqual } from './lib/checks.mjs';
import { repoRoot, dshRequire } from './lib/harness.mjs';

const yaml = dshRequire('js-yaml');
const suite = createSuite('docs-audit');

const read = (relative) => readFileSync(path.join(repoRoot, relative), 'utf8');

const ZH = read('README.md');
const EN = read('README.en.md');
const RIG = read('tests/rig/README.md');

const CONFIG_KEYS = [
  'hosts', 'connectTimeoutMs', 'commandTimeoutMs', 'maxOutputBytes',
  'strictHostKeyChecking', 'allowedHosts', 'sshExecutable', 'scpExecutable',
];
const HOST_ENTRY_KEYS = [
  'name', 'hostname', 'user', 'port', 'identityFile', 'proxyJump',
  'description', 'defaultCwd', 'extraOptions',
];
const TOOLS = ['ssh_hosts', 'ssh_exec', 'ssh_upload', 'ssh_download'];
const TOOL_PARAMS = [
  'check', 'host', 'command', 'cwd', 'env', 'timeoutMs', 'pty', 'stdin',
  'localPath', 'remotePath', 'recursive',
];
const RESULT_FIELDS = [
  'target', 'exitCode', 'signal', 'stdout', 'stderr', 'durationMs', 'timedOut', 'truncated',
];
// Flags the *plugin* README documents. The rig-only flags (`UserKnownHostsFile=/dev/null`,
// `-P`) live in tests/rig/README.md and are covered by D12 instead.
const FLAGS = [
  'BatchMode=yes', 'ConnectTimeout', 'StrictHostKeyChecking',
  '-tt', '-i', '-J', '-o', '--', 'SIGTERM', 'SIGKILL', 'accept-new', 'known_hosts',
];
const FROZEN = new Set([...TOOLS, ...TOOL_PARAMS, ...RESULT_FIELDS, ...CONFIG_KEYS, ...HOST_ENTRY_KEYS, ...FLAGS]);

/** All inline code spans (`...`). */
function inlineSpans(text) {
  const spans = [];
  for (const line of text.split('\n')) {
    for (const match of line.matchAll(/`([^`\n]+)`/g)) spans.push(match[1]);
  }
  return spans;
}

/**
 * Identifier-like tokens inside inline code spans. Spans often bundle several
 * identifiers (`{ host, target, exitCode, … }`, `-o ConnectTimeout=<ceil(ms/1000)>`),
 * so each span is tokenised rather than taken whole.
 */
function identifiers(text) {
  const out = new Set();
  for (const span of inlineSpans(text)) {
    for (const match of span.matchAll(/[A-Za-z_@][A-Za-z0-9_@./*<>=:-]*/g)) out.add(match[0]);
    for (const match of span.matchAll(/-{1,2}[A-Za-z][A-Za-z0-9]*/g)) out.add(match[0]);
    if (span.trim() === '--') out.add('--');
  }
  return out;
}

/** Fenced code blocks with their language tag and body. */
function codeBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  let open = null;
  lines.forEach((line, index) => {
    const fence = /^\s*```(.*)$/.exec(line);
    if (!fence) {
      if (open) open.body.push(line);
      return;
    }
    if (open) {
      blocks.push({ lang: open.lang, body: open.body.join('\n'), start: open.start, end: index + 1 });
      open = null;
    } else {
      open = { lang: fence[1].trim(), body: [], start: index + 1 };
    }
  });
  return { blocks, unclosed: open };
}

/** Markdown tables: consecutive `|` lines, as cell arrays. */
function tables(text) {
  const lines = text.split('\n');
  const found = [];
  let current = null;
  const flush = () => {
    if (current && current.rows.length > 0) found.push(current);
    current = null;
  };
  lines.forEach((line, index) => {
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (!current) current = { start: index + 1, rows: [] };
      const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      current.rows.push({ line: index + 1, cells });
    } else {
      flush();
    }
  });
  flush();
  return found;
}

function headings(text) {
  return text.split('\n')
    .map((line, index) => ({ line: index + 1, match: /^(#{1,6})\s+(.*)$/.exec(line) }))
    .filter((h) => h.match)
    .map((h) => ({ line: h.line, level: h.match[1].length, title: h.match[2].trim() }));
}

const zhIds = identifiers(ZH);
const enIds = identifiers(EN);
const zhBlocks = codeBlocks(ZH);
const enBlocks = codeBlocks(EN);

// ---------------------------------------------------------------------------
await suite.check('D1-files', 'both READMEs exist and the primary one is Chinese', () => {
  assert(ZH.length > 0 && EN.length > 0, 'both READMEs must be non-empty');
  const cjk = (text) => (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  assert(cjk(ZH) > 100, `README.md should be predominantly Chinese, found ${cjk(ZH)} CJK chars`);
  assert(cjk(EN) < 20, `README.en.md should be English, found ${cjk(EN)} CJK chars`);
  assert(EN.startsWith('>'), 'README.en.md should open with its pointer note to README.md');
  assert(/README\.md/.test(EN.split('\n')[0]), 'README.en.md line 1 must link to README.md');
  assert(/README\.en\.md/.test(ZH.split('\n').slice(0, 5).join('\n')), 'README.md must link to README.en.md near the top');
  return `zh=${ZH.length}B (${cjk(ZH)} CJK), en=${EN.length}B (${cjk(EN)} CJK)`;
});

await suite.check('D2-fences-balanced', 'no unbalanced code fence in either README', () => {
  assert(!zhBlocks.unclosed, `README.md has an unclosed fence opened at line ${zhBlocks.unclosed?.start}`);
  assert(!enBlocks.unclosed, `README.en.md has an unclosed fence opened at line ${enBlocks.unclosed?.start}`);
  assert(zhBlocks.blocks.length === enBlocks.blocks.length,
    `fence count differs: zh=${zhBlocks.blocks.length} en=${enBlocks.blocks.length}`);
  const langs = (b) => b.blocks.map((x) => x.lang).join(',');
  assertEqual(langs(zhBlocks), langs(enBlocks), 'code-fence languages/order');
  return `${zhBlocks.blocks.length} fences in each, same languages in the same order (${langs(zhBlocks)})`;
});

await suite.check('D3-inline-code-balanced', 'backticks balance per paragraph (outside fences), allowing multi-line spans', () => {
  const offenders = [];
  for (const [label, text] of [['README.md', ZH], ['README.en.md', EN], ['tests/rig/README.md', RIG]]) {
    let inFence = false;
    let paragraph = 0;
    let paragraphStart = 0;
    let count = 0;
    const closeParagraph = () => {
      if (count % 2 !== 0) offenders.push(`${label}:${paragraphStart}`);
      count = 0;
    };
    text.split('\n').forEach((line, index) => {
      if (/^\s*```/.test(line)) {
        closeParagraph();
        inFence = !inFence;
        return;
      }
      if (inFence) return;
      if (line.trim() === '') {
        closeParagraph();
        return;
      }
      if (count === 0) {
        paragraph += 1;
        paragraphStart = index + 1;
      }
      count += (line.match(/`/g) ?? []).length;
    });
    closeParagraph();
  }
  assert(offenders.length === 0, `unbalanced inline backticks in paragraph(s) starting at: ${offenders.join(', ')}`);
  return 'all three READMEs clean (multi-line code spans counted as one paragraph)';
});

await suite.check('D4-yaml-parses-and-matches', 'every ```yaml block parses and the Chinese one is deep-equal to the English one', () => {
  const zhYaml = zhBlocks.blocks.filter((b) => b.lang === 'yaml');
  const enYaml = enBlocks.blocks.filter((b) => b.lang === 'yaml');
  assert(zhYaml.length > 0, 'no ```yaml block found in README.md');
  assertEqual(zhYaml.length, enYaml.length, 'yaml block count');
  const parsed = [];
  zhYaml.forEach((block, index) => {
    let zhDoc;
    let enDoc;
    try {
      zhDoc = yaml.load(block.body);
    } catch (error) {
      assert(false, `README.md yaml block #${index + 1} (line ${block.start}) does not parse: ${error.message}`);
    }
    try {
      enDoc = yaml.load(enYaml[index].body);
    } catch (error) {
      assert(false, `README.en.md yaml block #${index + 1} does not parse: ${error.message}`);
    }
    assertEqual(JSON.stringify(zhDoc), JSON.stringify(enDoc),
      `README.md yaml block #${index + 1} differs from the English one`);
    parsed.push(zhDoc);
  });
  return `${parsed.length} yaml block(s) parse and are identical to the English version`;
});

await suite.check('D5-config-yaml-keys', 'the configuration override carries exactly the eight config keys', () => {
  const zhYaml = zhBlocks.blocks.filter((b) => b.lang === 'yaml');
  const override = zhYaml.map((b) => yaml.load(b.body))
    .find((doc) => Array.isArray(doc) && doc[0]?.id === 'remote-ssh');
  assert(override, 'no `- id: remote-ssh` override block found in README.md');
  const config = override[0].config;
  assert(config && typeof config === 'object', 'the override must carry a `config` object');
  const keys = Object.keys(config);
  const missing = CONFIG_KEYS.filter((k) => !keys.includes(k));
  const extra = keys.filter((k) => !CONFIG_KEYS.includes(k));
  assert(missing.length === 0, `config example is missing keys: ${missing.join(', ')}`);
  assert(extra.length === 0, `config example has unexpected keys: ${extra.join(', ')}`);
  assertEqual(JSON.stringify(Object.keys(config.hosts[0])), JSON.stringify(HOST_ENTRY_KEYS), 'host entry keys');
  return `id=remote-ssh + all 8 config keys + all 9 host-entry keys, in order`;
});

await suite.check('D6-tables-consistent', 'every markdown table has a consistent column count', () => {
  const report = [];
  for (const [label, text] of [['README.md', ZH], ['README.en.md', EN], ['tests/rig/README.md', RIG]]) {
    const blocks = tables(text);
    blocks.forEach((block, index) => {
      const widths = new Set(block.rows.map((r) => r.cells.length));
      assert(widths.size === 1,
        `${label} table #${index + 1} (line ${block.start}) has inconsistent column counts: ${[...widths].join(' vs ')}`);
      assert(block.rows.length >= 2, `${label} table #${index + 1} has no separator row`);
      assert(block.rows[1].cells.every((c) => /^:?-{2,}:?$/.test(c)),
        `${label} table #${index + 1} line ${block.rows[1].line} is not a valid separator row`);
      report.push(`${label}#${index + 1}=${block.rows[0].cells.length}cols×${block.rows.length}rows`);
    });
  }
  return report.join(', ');
});

await suite.check('D7-config-key-table', 'the config-key table lists all eight keys, in the English order', () => {
  const zhTable = tables(ZH).map((t) => t.rows.map((r) => r.cells[0]))
    .find((first) => CONFIG_KEYS.every((k) => first.some((c) => c === `\`${k}\``)));
  const enTable = tables(EN).map((t) => t.rows.map((r) => r.cells[0]))
    .find((first) => CONFIG_KEYS.every((k) => first.some((c) => c === `\`${k}\``)));
  assert(zhTable, 'README.md has no table listing all eight config keys in backticks');
  assert(enTable, 'README.en.md has no table listing all eight config keys in backticks');
  // rows[0] is the header, rows[1] the `| --- |` separator.
  const zhKeys = zhTable.slice(2).map((c) => c.replace(/`/g, ''));
  const enKeys = enTable.slice(2).map((c) => c.replace(/`/g, ''));
  assertEqual(JSON.stringify(zhKeys), JSON.stringify(enKeys), 'config-key table key order');
  assertEqual(zhKeys.length, 8, 'config-key table row count');
  return `8 keys, identical order: ${zhKeys.join(', ')}`;
});

await suite.check('D8-tool-headings', 'all four `### ssh_*` headings survive untranslated in both READMEs', () => {
  const zh = headings(ZH).filter((h) => h.level === 3).map((h) => h.title);
  const en = headings(EN).filter((h) => h.level === 3).map((h) => h.title);
  const expected = TOOLS.map((t) => `\`${t}\``);
  assertEqual(JSON.stringify(zh), JSON.stringify(expected), 'README.md level-3 headings');
  assertEqual(JSON.stringify(en), JSON.stringify(expected), 'README.en.md level-3 headings');
  return expected.join(' ');
});

await suite.check('D9-heading-structure', 'heading level sequence maps 1:1 between the two READMEs', () => {
  const zh = headings(ZH).map((h) => h.level);
  const en = headings(EN).map((h) => h.level);
  assertEqual(zh.length, en.length, 'heading count');
  assertEqual(JSON.stringify(zh), JSON.stringify(en), 'heading level sequence');
  assertEqual(headings(ZH)[0].title, headings(EN)[0].title, 'H1 title');
  return `${zh.length} headings, identical levels; H1 = ${headings(ZH)[0].title}`;
});

await suite.check('D10-frozen-identifiers', 'every frozen tool/param/result/config identifier appears untranslated in both READMEs', () => {
  const missingZh = [...FROZEN].filter((id) => !ZH.includes(id));
  const missingEn = [...FROZEN].filter((id) => !EN.includes(id));
  assert(missingEn.length === 0, `README.en.md is missing: ${missingEn.join(', ')}`);
  assert(missingZh.length === 0, `README.md is missing (possible accidental translation): ${missingZh.join(', ')}`);
  return `${FROZEN.size} frozen identifiers present verbatim in both`;
});

await suite.check('D11-no-identifier-rename', 'no frozen identifier was renamed, and no identifier-like span was invented', () => {
  const missingInZh = [...enIds].filter((id) => !zhIds.has(id)).sort();
  const extraInZh = [...zhIds].filter((id) => !enIds.has(id)).sort();
  const frozenMissing = missingInZh.filter((id) => FROZEN.has(id));
  assert(frozenMissing.length === 0, `frozen identifiers absent from README.md: ${frozenMissing.join(', ')}`);
  const inventedFrozen = extraInZh.filter((id) => FROZEN.has(id));
  assert(inventedFrozen.length === 0, `README.md mentions frozen identifiers not in the English version: ${inventedFrozen.join(', ')}`);
  return `code-span identifiers: ${enIds.size} in en, ${zhIds.size} in zh; en-only=[${missingInZh.join(', ') || 'none'}], zh-only=[${extraInZh.join(', ') || 'none'}]`;
});

await suite.check('D12-rig-readme-identifiers', 'the Chinese rig README keeps every command, flag and JSON field verbatim', () => {
  const required = [
    'lib.mjs', 'start.mjs', 'stop.mjs', 'selftest.mjs',
    'startRig()', 'stopRig()', 'withRig()', 'runSsh', 'runScp',
    '--json-file', '--port', '--dir', '--quiet', '--pid',
    'node --test tests/rig/selftest.mjs',
    'ssh-keygen -t ed25519',
    'sshd -D -f <config> -E <log>',
    'Subsystem sftp internal-sftp',
    'Server listening on 127.0.0.1 port <port>.',
    'mkdtemp($TMPDIR/dsh-ssh-rig-XXXXXX)',
    'hostkey', 'hostkey.pub', 'clientkey', 'clientkey.pub',
    'authorized_keys', 'AuthorizedKeysFile', 'sshd_config', 'sshd.log', 'sshd.pid', 'PidFile',
    'port', 'host', 'user', 'keyPath', 'dir', 'sshCommand', 'scpCommand',
    'target', 'sshBaseArgs', 'scpBaseArgs', 'bins', 'sshdPid', 'logPath', 'configPath', 'pidFile',
    'cleanup()', 'stop()', 'timedOut', 'status', 'stdout', 'stderr', 'signal',
    '-o BatchMode=yes', '-o StrictHostKeyChecking=no', '-o UserKnownHostsFile=/dev/null',
    'UserKnownHostsFile=/dev/null', '-P', '-r',
    '--port <n>', '--dir <path>', '--pid <sshd-pid>',
    '[1024, 65535]', 'sshBin', 'scpBin', 'sshdBin', 'sshKeygenBin',
    '/usr/bin/ssh', '/usr/bin/scp', 'ProxyJump',
  ];
  const missing = required.filter((token) => !RIG.includes(token));
  assert(missing.length === 0, `tests/rig/README.md lost these verbatim tokens: ${missing.join(', ')}`);
  const cjk = (RIG.match(/[\u4e00-\u9fff]/g) ?? []).length;
  assert(cjk > 100, `tests/rig/README.md should be Chinese, found ${cjk} CJK chars`);
  // `starterPid` is emitted by start.mjs but was never documented in the English
  // rig README either (confirmed against git HEAD), so it is not required here;
  // see REPORT.md round 4 for that pre-existing documentation gap.
  const jsonFields = ['port', 'host', 'user', 'keyPath', 'dir', 'sshCommand', 'scpCommand',
    'target', 'sshdPid', 'pidFile', 'logPath', 'configPath', 'stopped', 'portStillListening', 'dirStillExists'];
  const missingJson = jsonFields.filter((f) => !RIG.includes(f));
  assert(missingJson.length === 0, `rig README lost JSON field names: ${missingJson.join(', ')}`);
  return `${required.length} verbatim tokens + ${jsonFields.length} JSON fields intact; ${cjk} CJK chars`;
});

await suite.check('D13-package-files', 'package.json ships README.en.md and still lists every runtime file', () => {
  const pkg = JSON.parse(read('package.json'));
  assert(pkg.files.includes('README.en.md'), 'package.json `files` must include README.en.md');
  assert(pkg.files.includes('README.md'), 'package.json `files` must include README.md');
  for (const required of ['index.js', 'lib/*.js', 'cordis.patch.yml', 'locale/*.json', 'icon.svg']) {
    assert(pkg.files.includes(required), `package.json \`files\` must still include ${required}`);
  }
  assert(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0, 'dependencies must stay empty');
  return `files = ${JSON.stringify(pkg.files)}`;
});

const summary = suite.summary();

const jsonFlag = process.argv.indexOf('--json');
if (jsonFlag !== -1 && process.argv[jsonFlag + 1]) {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const out = path.resolve(process.argv[jsonFlag + 1]);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify({ suite: 'docs-audit', results: suite.results, summary }, null, 2)}\n`);
  process.stdout.write(`wrote ${out}\n`);
}

process.exit(summary.failed === 0 ? 0 : 1);
