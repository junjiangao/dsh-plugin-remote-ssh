#!/usr/bin/env node
/**
 * STATIC verification of the @junjiangao/dsh-plugin-remote-ssh bundle
 * (task-3 checks 1 & 2, re-run for task-5 after the package rename).
 *
 *   node verification/static-check.mjs [--json verification/out/static-check.json]
 *
 * Read-only: inspects the bundle, never modifies it.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { register } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { createSuite, assert, assertEqual, fail } from './lib/checks.mjs';
import { repoRoot, dshRequire } from './lib/harness.mjs';

// Map the two installation-scope bare specifiers onto the real harness modules
// so the plugin can be imported and its definitions validated by real code.
register('./resolution/loader.mjs', import.meta.url);

const yaml = dshRequire('js-yaml');
const { SaxesParser } = dshRequire('saxes');

const EXPECTED_NAME = '@junjiangao/dsh-plugin-remote-ssh';
/**
 * The pre-rename package name, assembled from parts so that this file itself
 * does not contain the literal: task-5 requires
 * `grep -rn "<legacy-name>" . --exclude-dir=.git` to match nothing repo-wide.
 */
const LEGACY_NAME = '@' + 'local/dsh-plugin-remote-ssh';

const FROZEN_TOOLS = {
  ssh_hosts: { check: { type: 'boolean' } },
  ssh_exec: {
    host: { type: 'string', required: true },
    command: { type: 'string', required: true },
    cwd: { type: 'string' },
    env: { type: 'object' },
    timeoutMs: { type: 'number' },
    pty: { type: 'boolean' },
    stdin: { type: 'string' },
  },
  ssh_upload: {
    host: { type: 'string', required: true },
    localPath: { type: 'string', required: true },
    remotePath: { type: 'string', required: true },
    recursive: { type: 'boolean' },
    timeoutMs: { type: 'number' },
  },
  ssh_download: {
    host: { type: 'string', required: true },
    remotePath: { type: 'string', required: true },
    localPath: { type: 'string', required: true },
    recursive: { type: 'boolean' },
    timeoutMs: { type: 'number' },
  },
};

/** Walk the *bundle* (excluding the verifier's own trees and VCS metadata). */
function walk(dir, predicate, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    if (dir === repoRoot && (entry.name === 'verification' || entry.name === 'tests')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, predicate, out);
    else if (predicate(full)) out.push(full);
  }
  return out;
}

const suite = createSuite('static-check');

// ---------------------------------------------------------------- package.json
let pkg = null;
await suite.check('S1-package-json', 'package.json parses and declares the frozen manifest fields', () => {
  const file = path.join(repoRoot, 'package.json');
  assert(existsSync(file), `package.json missing at ${file}`);
  pkg = JSON.parse(readFileSync(file, 'utf8'));
  assertEqual(pkg.name, EXPECTED_NAME, 'package.json name');
  assertEqual(pkg.version, '1.0.0', 'package.json version');
  assertEqual(pkg.private, true, 'package.json private');
  assertEqual(pkg.type, 'module', 'package.json type');
  const main = pkg.main ?? pkg.exports?.['.'];
  assert(main, 'package.json must declare main or exports["."]');
  assertEqual(pkg.icon, './icon.svg', 'package.json icon');
  assertEqual(pkg.dsh?.bundle?.patch, './cordis.patch.yml', 'package.json dsh.bundle.patch');
  for (const key of ['.', './locale/*.json', './icon', './package.json']) {
    assert(pkg.exports?.[key], `package.json exports is missing "${key}"`);
  }
  assert(Array.isArray(pkg.files) && pkg.files.length > 0, 'package.json files must be a non-empty array');
  return `name=${pkg.name} version=${pkg.version} files=${pkg.files.length} exports=${Object.keys(pkg.exports).join(',')}`;
});

await suite.check('S2-no-dependencies', 'package.json declares NO dependencies; only installation-scope peerDependencies', () => {
  assert(pkg, 'package.json was not parsed');
  const deps = Object.keys(pkg.dependencies ?? {});
  const optional = Object.keys(pkg.optionalDependencies ?? {});
  const peers = Object.keys(pkg.peerDependencies ?? {});
  assert(deps.length === 0, `dependencies must be empty, found: ${deps.join(', ')}`);
  assert(optional.length === 0, `optionalDependencies must be empty, found: ${optional.join(', ')}`);
  // The bundle is linked from a workspace path. The harness only routes
  // installation-scope packages for a linked bundle when the importing
  // package.json declares them as peerDependencies (Lead-confirmed after the
  // first install_bundle failed activation). So peerDependencies is required
  // and must contain exactly the two installation-scope specifiers.
  const allowedPeers = ['@deepseek-ai/dsh-tools', '@deepseek-ai/schemastery'];
  const unexpected = peers.filter((p) => !allowedPeers.includes(p));
  assert(unexpected.length === 0, `unexpected peerDependencies: ${unexpected.join(', ')}`);
  const missing = allowedPeers.filter((p) => !peers.includes(p));
  assert(missing.length === 0,
    `peerDependencies must declare the installation-scope packages for linked-bundle resolution; missing: ${missing.join(', ')}`);
  return `dependencies={} optionalDependencies={} peerDependencies=${JSON.stringify(pkg.peerDependencies)}`;
});

await suite.check('S3-referenced-files-exist', 'every file referenced by main/exports/files exists on disk', () => {
  assert(pkg, 'package.json was not parsed');
  const missing = [];
  const referenced = new Set();
  const addRef = (ref) => {
    if (typeof ref !== 'string' || ref.includes('*')) return;
    referenced.add(ref.replace(/^\.\//, ''));
  };
  addRef(typeof pkg.main === 'string' ? pkg.main : undefined);
  for (const value of Object.values(pkg.exports ?? {})) {
    if (typeof value === 'string') addRef(value);
    else if (value && typeof value === 'object') for (const v of Object.values(value)) addRef(v);
  }
  for (const entry of pkg.files ?? []) addRef(entry);
  for (const ref of referenced) {
    if (!existsSync(path.join(repoRoot, ref))) missing.push(ref);
  }
  assert(missing.length === 0, `referenced but missing: ${missing.join(', ')}`);
  return `${referenced.size} referenced paths exist`;
});

await suite.check('S4-cordis-patch', 'cordis.patch.yml parses as YAML and inserts exactly one remote-ssh row', () => {
  const file = path.join(repoRoot, 'cordis.patch.yml');
  assert(existsSync(file), 'cordis.patch.yml missing');
  const doc = yaml.load(readFileSync(file, 'utf8'));
  assert(Array.isArray(doc), `cordis.patch.yml must be a top-level YAML array, got ${typeof doc}`);
  assertEqual(doc.length, 1, 'cordis.patch.yml top-level array length');
  const insert = doc[0]?.insert;
  assert(Array.isArray(insert), 'first patch row must be an `insert:` array');
  assertEqual(insert.length, 1, 'insert array length');
  const row = insert[0];
  assertEqual(row.id, 'remote-ssh', 'insert row id');
  assertEqual(row.name, EXPECTED_NAME, 'insert row name');
  assert(row.config !== undefined, 'insert row should carry a config key');
  assertEqual(Object.keys(row.config ?? {}).length, 0, 'insert config should be empty ({})');
  return `insert: id=${row.id} name=${row.name} config=${JSON.stringify(row.config)}`;
});

// -------------------------------------------------------------------- locales
let locales = null;
await suite.check('S5-locales', 'locale/en.json and locale/zh.json parse and carry real meta copy', () => {
  locales = {};
  for (const lang of ['en', 'zh']) {
    const file = path.join(repoRoot, 'locale', `${lang}.json`);
    assert(existsSync(file), `locale/${lang}.json missing`);
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    const title = doc?.meta?.title;
    const description = doc?.meta?.description;
    assert(typeof title === 'string' && title.trim().length > 0, `locale/${lang}.json meta.title must be a non-empty string`);
    assert(typeof description === 'string' && description.trim().length > 0, `locale/${lang}.json meta.description must be a non-empty string`);
    for (const [field, value] of [['title', title], ['description', description]]) {
      assert(!/todo|lorem ipsum|placeholder|xxx|{{|}}/i.test(value), `locale/${lang}.json meta.${field} looks like a template placeholder: ${JSON.stringify(value)}`);
    }
    locales[lang] = { title, description };
  }
  assert(locales.en.title !== locales.zh.title, 'en/zh meta.title must differ (localized copy, not a copy-paste)');
  assert(locales.en.description !== locales.zh.description, 'en/zh meta.description must differ');
  assert(/[\u4e00-\u9fff]/.test(locales.zh.title + locales.zh.description), 'zh locale must contain Chinese text');
  assert(!/[\u4e00-\u9fff]/.test(locales.en.title), 'en locale title should not be Chinese');
  return `en="${locales.en.title}" zh="${locales.zh.title}"`;
});

// ------------------------------------------------------------------- icon.svg
await suite.check('S6-icon-svg', 'icon.svg is well-formed SVG < 256 KiB with a viewBox and no external references', () => {
  const file = path.join(repoRoot, 'icon.svg');
  assert(existsSync(file), 'icon.svg missing');
  const size = statSync(file).size;
  assert(size > 0, 'icon.svg is empty');
  assert(size < 256 * 1024, `icon.svg is ${size} bytes, must be < 256 KiB`);
  const text = readFileSync(file, 'utf8');
  const errors = [];
  const elements = [];
  let root = null;
  const parser = new SaxesParser({ xmlns: true });
  parser.on('error', (error) => errors.push(error.message));
  parser.on('opentag', (tag) => {
    if (root === null) root = tag.name;
    elements.push(tag.name);
  });
  parser.write(text).close();
  assert(errors.length === 0, `icon.svg is not well-formed XML: ${errors.join('; ')}`);
  assertEqual(root, 'svg', 'icon.svg root element');
  assert(/viewBox\s*=/.test(text), 'icon.svg must declare a viewBox');
  const external = [];
  for (const match of text.matchAll(/\b(?:xlink:)?href\s*=\s*["']([^"']*)["']/gi)) {
    const value = match[1].trim();
    if (!value.startsWith('#')) external.push(`href=${value}`);
  }
  for (const match of text.matchAll(/\bsrc\s*=\s*["']([^"']*)["']/gi)) external.push(`src=${match[1]}`);
  for (const match of text.matchAll(/url\(\s*["']?([^"')]+)/gi)) {
    if (!match[1].startsWith('#')) external.push(`url(${match[1]})`);
  }
  assert(external.length === 0, `icon.svg has external references: ${external.join(', ')}`);
  return `${size} bytes, root=<${root}>, ${elements.length} elements, viewBox present, 0 external refs`;
});

// ------------------------------------------------------------------- JS syntax
const jsFiles = walk(repoRoot, (f) => f.endsWith('.js') || f.endsWith('.mjs'));
await suite.check('S7-node-check', `every .js/.mjs file passes \`node --check\` (${jsFiles.length} files)`, () => {
  assert(jsFiles.length > 0, 'no .js files found in the bundle');
  const failures = [];
  for (const file of jsFiles) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) failures.push(`${path.relative(repoRoot, file)}: ${(result.stderr || '').trim().split('\n')[0]}`);
  }
  assert(failures.length === 0, `node --check failures:\n${failures.join('\n')}`);
  return `${jsFiles.length} files checked, 0 syntax errors`;
});

// --------------------------------------------------------------- import audit
await suite.check('S8-bare-imports', 'the only bare imports are @deepseek-ai/dsh-tools and @deepseek-ai/schemastery', () => {
  const allowed = new Set(['@deepseek-ai/dsh-tools', '@deepseek-ai/schemastery']);
  const found = new Map();
  const bare = [];
  for (const file of jsFiles) {
    const text = readFileSync(file, 'utf8');
    const specs = [
      ...text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
      ...text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
      ...text.matchAll(/\bimport\s+['"]([^'"]+)['"]/g),
    ].map((m) => m[1]);
    for (const spec of specs) {
      const isRelative = spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:');
      if (isRelative) continue;
      bare.push(`${path.relative(repoRoot, file)} -> ${spec}`);
      found.set(spec, (found.get(spec) ?? 0) + 1);
    }
  }
  const unexpected = bare.filter((entry) => !allowed.has(entry.split(' -> ')[1]));
  assert(unexpected.length === 0, `unexpected bare imports:\n${unexpected.join('\n')}`);
  return bare.length === 0
    ? 'no bare imports at all'
    : [...found.entries()].map(([spec, n]) => `${spec} x${n}`).join(', ');
});

// ------------------------------------------------------- harness contract probe
await suite.check('S9-tool-definitions', 'the REAL harness defineTool accepts all four definitions with frozen params', async () => {
  const { defineTool, assertSupportedJsonSchema } = await import('@deepseek-ai/dsh-tools');
  const entry = path.join(repoRoot, 'index.js');
  assert(existsSync(entry), 'index.js missing');
  const mod = await import(`${entry}?static-check=${Date.now()}`);
  assert(typeof mod.apply === 'function', 'index.js must export apply(ctx, config)');
  assert(typeof mod.Config === 'function' || typeof mod.Config === 'object', 'index.js must export Config');
  const captured = [];
  const ctx = makeFakeCtx(captured);
  const raw = {};
  const config = typeof mod.Config === 'function' ? mod.Config(raw) : raw;
  await mod.apply(ctx, config);
  assert(captured.length >= 4, `apply() registered ${captured.length} tools, expected at least 4`);
  const byName = new Map(captured.map((d) => [d.name, d]));
  const problems = [];
  for (const [name, params] of Object.entries(FROZEN_TOOLS)) {
    const def = byName.get(name);
    if (!def) {
      problems.push(`tool "${name}" was not registered`);
      continue;
    }
    if (typeof def.output?.render !== 'function') problems.push(`${name}: output.render is not a function`);
    try {
      assertSupportedJsonSchema(def.output?.schema);
    } catch (error) {
      problems.push(`${name}: output.schema rejected by harness: ${error.message}`);
    }
    for (const [param, spec] of Object.entries(params)) {
      const declared = def.parameters?.properties?.[param];
      if (!declared) {
        problems.push(`${name}: parameter "${param}" is missing`);
        continue;
      }
      if (declared.type !== spec.type) problems.push(`${name}.${param}: type ${declared.type} != ${spec.type}`);
      if (Boolean(spec.required) !== (def.parameters.required ?? []).includes(param)) {
        problems.push(`${name}.${param}: required=${(def.parameters.required ?? []).includes(param)} != ${Boolean(spec.required)}`);
      }
    }
  }
  assert(problems.length === 0, problems.join('\n'));
  return `${captured.length} tools registered: ${[...byName.keys()].sort().join(', ')}`;
});

// ------------------------------------------------------------- rename hygiene
await suite.check('S10-no-legacy-name', 'no stale pre-rename package reference remains anywhere in the repo', () => {
  const skip = new Set(['.git', 'node_modules']);
  const hits = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      if (!entry.isFile()) continue;
      let text;
      try {
        text = readFileSync(full, 'utf8');
      } catch {
        continue; // binary or unreadable
      }
      if (text.includes(LEGACY_NAME)) hits.push(path.relative(repoRoot, full));
    }
  };
  visit(repoRoot);
  assert(hits.length === 0,
    `stale pre-rename reference found in: ${hits.join(', ')} (expected: the rename is complete)`);
  return `0 files contain the pre-rename name (scanned the whole repo except .git/ and node_modules/)`;
});

function makeFakeCtx(captured) {
  return {
    tools: {
      register(definition) {
        captured.push(definition);
        return () => {};
      },
    },
    on() {},
    effect() {},
    get() {
      return undefined;
    },
  };
}

const summary = suite.summary();

const jsonFlag = process.argv.indexOf('--json');
if (jsonFlag !== -1 && process.argv[jsonFlag + 1]) {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const out = path.resolve(process.argv[jsonFlag + 1]);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify({ suite: 'static-check', results: suite.results, summary }, null, 2)}\n`);
  process.stdout.write(`wrote ${out}\n`);
}

process.exit(summary.failed === 0 ? 0 : 1);
