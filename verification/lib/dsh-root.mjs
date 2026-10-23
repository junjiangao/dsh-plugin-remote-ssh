/**
 * Locate the dsh installation that the running harness uses.
 *
 * The installation lives under a version directory that changes whenever the
 * harness is upgraded (e.g. `…/versions/0.2.1-alpha.5.20261016.2/resources/
 * app.asar.unpacked/dsh`), so the path must never be hard-coded: this module
 * discovers it, preferring `$DSH_INSTALL_ROOT`, then the newest version
 * directory that actually contains the packages the plugin needs.
 */

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const VERSIONS_DIR = path.join(homedir(), '.local', 'opt', 'deepseek-harness', 'versions');
/** A version directory is usable only if it really ships the shared packages. */
const MARKER = path.join('node_modules', '@deepseek-ai', 'dsh-tools');

function versionDirectories() {
  if (!existsSync(VERSIONS_DIR)) return [];
  return readdirSync(VERSIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
}

export function dshRootCandidates() {
  const candidates = [];
  if (process.env.DSH_INSTALL_ROOT) candidates.push(process.env.DSH_INSTALL_ROOT);
  for (const version of versionDirectories()) {
    candidates.push(path.join(VERSIONS_DIR, version, 'resources', 'app.asar.unpacked', 'dsh'));
  }
  return candidates;
}

/** @returns {string} absolute path of the `…/app.asar.unpacked/dsh` directory */
export function findDshRoot() {
  const candidates = dshRootCandidates();
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, MARKER))) return candidate;
  }
  throw new Error(
    `verification: cannot locate a usable dsh installation root; tried:\n  ${candidates.join('\n  ')}\n`
    + 'Set DSH_INSTALL_ROOT to the ".../app.asar.unpacked/dsh" directory.',
  );
}

/** The version directory name the resolved root belongs to (for reporting). */
export function dshVersion(root) {
  const match = /\/versions\/([^/]+)\//.exec(root);
  return match ? match[1] : '(unknown)';
}
