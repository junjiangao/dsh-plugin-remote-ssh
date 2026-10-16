/**
 * Shared helpers for the independent verification of the remote-ssh plugin.
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_DSH_ROOT =
  '/home/xyzhuanjian/.local/opt/deepseek-harness/versions/0.2.1-alpha.5.20261016.2/resources/app.asar.unpacked/dsh';

function findDshRoot() {
  const candidates = [process.env.DSH_INSTALL_ROOT, DEFAULT_DSH_ROOT].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'node_modules', '@deepseek-ai', 'dsh-tools'))) return candidate;
  }
  throw new Error(`verification: cannot locate dsh install root; tried ${candidates.join(', ')}`);
}

/** Absolute path of the dsh installation (the "app.asar.unpacked/dsh" directory). */
export const dshRoot = findDshRoot();

/** `require` rooted at the dsh installation, for its own dependency tree. */
export const dshRequire = createRequire(path.join(dshRoot, 'package.json'));

/** Repository root (the plugin bundle under test). */
export const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

export const REPO = repoRoot;
