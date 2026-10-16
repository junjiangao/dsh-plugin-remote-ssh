/**
 * Node module-resolution hook used by verification runs.
 *
 * The plugin under test imports two installation-scope packages that do not
 * resolve from this workspace under plain `node`:
 *
 *   @deepseek-ai/dsh-tools
 *   @deepseek-ai/schemastery
 *
 * This loader maps exactly those two bare specifiers onto the REAL modules that
 * ship inside the dsh installation, so `defineTool`, the tool-registry types and
 * `schemastery`'s `z` are the genuine harness implementations - not stubs.
 * Every other specifier is resolved normally.
 *
 * Only these two specifiers are rewritten; nothing else is intercepted.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_DSH_ROOT =
  '/home/xyzhuanjian/.local/opt/deepseek-harness/versions/0.2.1-alpha.5.20261016.2/resources/app.asar.unpacked/dsh';

function findDshRoot() {
  const candidates = [
    process.env.DSH_INSTALL_ROOT,
    DEFAULT_DSH_ROOT,
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'node_modules', '@deepseek-ai', 'dsh-tools'))) return candidate;
  }
  throw new Error(
    `verification loader: cannot locate the dsh installation root; tried ${candidates.join(', ')}. `
    + 'Set DSH_INSTALL_ROOT to the ".../app.asar.unpacked/dsh" directory.',
  );
}

const dshRoot = findDshRoot();

/** specifier -> absolute file inside the dsh installation. */
const REAL_MODULES = {
  '@deepseek-ai/dsh-tools': path.join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'),
  '@deepseek-ai/schemastery': path.join(dshRoot, 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs'),
};

for (const [specifier, file] of Object.entries(REAL_MODULES)) {
  if (!existsSync(file)) {
    throw new Error(`verification loader: ${specifier} -> ${file} does not exist`);
  }
}

export async function resolve(specifier, context, nextResolve) {
  const target = REAL_MODULES[specifier];
  if (target) {
    return { url: pathToFileURL(target).href, shortCircuit: true, format: 'module' };
  }
  return nextResolve(specifier, context);
}

export { REAL_MODULES, dshRoot };
