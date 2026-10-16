/**
 * Self-test for the hermetic sshd rig.
 *
 *   node --test tests/rig/selftest.mjs
 *
 * Proves the rig itself works before it is used as evidence for the plugin:
 * start -> ssh -> scp both directions -> stop -> temp dir gone, port closed.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import {
  startRig,
  stopRig,
  isPortListening,
  isAlive,
  runSsh,
  runScp,
} from './lib.mjs';

let rig;
let work;
let sshDirBefore = null;

function sshDirSnapshot() {
  const dir = path.join(homedir(), '.ssh');
  if (!existsSync(dir)) return '(absent)';
  const entries = readdirSync(dir).sort();
  return entries
    .map((name) => {
      try {
        return `${name}:${readFileSync(path.join(dir, name)).length}`;
      } catch {
        return `${name}:?`;
      }
    })
    .join(',');
}

before(async () => {
  sshDirBefore = sshDirSnapshot();
  work = await mkdtemp(path.join(tmpdir(), 'dsh-rig-selftest-'));
  rig = await startRig();
});

after(async () => {
  // Always clean up, even if a test failed or the suite was interrupted.
  await stopRig(rig);
  if (work) await rm(work, { recursive: true, force: true });
});

test('rig exposes sane coordinates', () => {
  assert.ok(rig, 'rig should be started');
  assert.equal(rig.host, '127.0.0.1');
  assert.ok(Number.isInteger(rig.port) && rig.port > 1023 && rig.port < 65536, `port ${rig.port}`);
  assert.match(rig.user, /^[A-Za-z0-9._-]+$/);
  assert.ok(rig.dir.startsWith(tmpdir()), `rig dir ${rig.dir} must live under ${tmpdir()}`);
  assert.ok(!rig.dir.startsWith(process.cwd()), 'rig dir must not be inside the repo');
  assert.ok(existsSync(rig.keyPath), 'client key must exist');
  assert.ok(existsSync(path.join(rig.dir, 'hostkey')), 'host key must exist');
  assert.ok(existsSync(rig.configPath), 'sshd_config must exist');
  assert.ok(existsSync(rig.logPath), 'sshd log must exist');
  assert.ok(rig.sshdPid && isAlive(rig.sshdPid), 'sshd must be alive');
  assert.ok(rig.sshCommand.includes('-p'), 'sshCommand should carry the port');
  assert.ok(rig.sshCommand.includes('-o'), 'sshCommand should carry hardening options');
});

test('sshd log reports the listening port', () => {
  const log = readFileSync(rig.logPath, 'utf8');
  assert.match(log, new RegExp(`Server listening on 127\\.0\\.0\\.1 port ${rig.port}\\.`));
});

test('ssh runs a remote command with BatchMode and exit code 0', () => {
  const result = runSsh(rig, 'echo RIG_OK');
  assert.equal(result.status, 0, `ssh stderr: ${result.stderr}`);
  assert.match(result.stdout, /RIG_OK/);
});

test('ssh propagates a non-zero remote exit code', () => {
  const result = runSsh(rig, 'exit 42');
  assert.equal(result.status, 42, `ssh stderr: ${result.stderr}`);
});

test('ssh honours a working directory and exported environment', () => {
  const dir = path.join(rig.dir, 'cwd-probe');
  const result = runSsh(
    rig,
    `export RIG_ENV=RIG_ENV_VALUE && mkdir -p ${dir} && cd ${dir} && printf '%s\\n%s\\n' "$RIG_ENV" "$PWD"`,
  );
  assert.equal(result.status, 0, `ssh stderr: ${result.stderr}`);
  assert.match(result.stdout, /RIG_ENV_VALUE/);
  assert.match(result.stdout, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('scp uploads and downloads byte-identical content', async () => {
  const bytes = Buffer.alloc(8192);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 37 + 11) % 256;
  const localSource = path.join(work, 'source.bin');
  const remotePath = path.join(rig.dir, 'roundtrip.bin');
  const localBack = path.join(work, 'back.bin');
  await writeFile(localSource, bytes);

  const up = runScp(rig, [localSource, `${rig.target}:${remotePath}`]);
  assert.equal(up.status, 0, `scp upload stderr: ${up.stderr}`);
  assert.ok(existsSync(remotePath), 'uploaded file must exist on the rig');

  const down = runScp(rig, [`${rig.target}:${remotePath}`, localBack]);
  assert.equal(down.status, 0, `scp download stderr: ${down.stderr}`);
  assert.deepEqual(await readFile(localBack), bytes, 'round-tripped bytes must match');
});

test('scp -r uploads and downloads a directory tree', async () => {
  const srcDir = path.join(work, 'tree');
  await mkdir(srcDir, { recursive: true });
  await writeFile(path.join(srcDir, 'a.txt'), 'alpha\n');
  await writeFile(path.join(srcDir, 'b.txt'), 'beta\n');

  const remoteDir = path.join(rig.dir, 'tree-remote');
  const up = runScp(rig, ['-r', srcDir, `${rig.target}:${remoteDir}`]);
  assert.equal(up.status, 0, `scp -r upload stderr: ${up.stderr}`);

  const backDir = path.join(work, 'tree-back');
  const down = runScp(rig, ['-r', `${rig.target}:${remoteDir}`, backDir]);
  assert.equal(down.status, 0, `scp -r download stderr: ${down.stderr}`);
  assert.equal(await readFile(path.join(backDir, 'a.txt'), 'utf8'), 'alpha\n');
  assert.equal(await readFile(path.join(backDir, 'b.txt'), 'utf8'), 'beta\n');
});

test('rig never touches ~/.ssh', () => {
  assert.equal(sshDirSnapshot(), sshDirBefore, '~/.ssh must be byte-identical before/after');
});

test('stop removes the temp dir, kills sshd and frees the port', async () => {
  const { dir, port, sshdPid } = rig;
  await stopRig(rig);

  assert.equal(existsSync(dir), false, `rig dir ${dir} must be removed`);
  assert.equal(isAlive(sshdPid), false, `sshd pid ${sshdPid} must be gone`);
  assert.equal(await isPortListening(port), false, `port ${port} must be closed`);

  // stopRig must be idempotent.
  await stopRig(rig);
  assert.equal(existsSync(dir), false);
  assert.equal(await isPortListening(port), false);
});
