/**
 * Shared helpers for the independent verification of the remote-ssh plugin.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findDshRoot, dshVersion } from './dsh-root.mjs';

/** Absolute path of the dsh installation (the "app.asar.unpacked/dsh" directory). */
export const dshRoot = findDshRoot();

/** Version directory of the resolved installation (for reporting). */
export const harnessVersion = dshVersion(dshRoot);

/** `require` rooted at the dsh installation, for its own dependency tree. */
export const dshRequire = createRequire(path.join(dshRoot, 'package.json'));

/** Repository root (the plugin bundle under test). */
export const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

export const REPO = repoRoot;
