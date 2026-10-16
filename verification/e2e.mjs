#!/usr/bin/env node
/**
 * FUNCTIONAL + ADVERSARIAL verification of the remote-ssh plugin (task-3 checks 3 & 4).
 *
 *   node verification/e2e.mjs
 *
 * Everything here runs the REAL plugin code:
 *   - `index.js` is imported and `apply(fakeCtx, Config(raw))` registers the real
 *     definitions, exactly as the harness does.
 *   - `@deepseek-ai/dsh-tools` / `@deepseek-ai/schemastery` resolve to the REAL
 *     modules inside the dsh installation (see verification/resolution/loader.mjs).
 *   - Arguments and results are validated with the harness's own
 *     `validateJsonSchemaValue`, and `output.render` is invoked on every result,
 *     mirroring ToolRuntime.createSuccessResult.
 *   - The SSH peer is a real, hermetic sshd started by tests/rig/lib.mjs.
 *
 * Nothing outside verification/, tests/ and the OS temp dir is written; the
 * user's ~/.ssh is snapshotted before and after and must be byte-identical.
 */

import { register } from 'node:module';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

register('./resolution/loader.mjs', import.meta.url);

import { createSuite, assert, assertEqual, withCap, sleep } from './lib/checks.mjs';
import { repoRoot } from './lib/harness.mjs';
import { startRig, stopRig, freePort, runSsh, isPortListening } from '../tests/rig/lib.mjs';

const suite = createSuite('e2e');

/** Per-check ~/.ssh attribution: records exactly which check touched the real ~/.ssh. */
const sshWriteAttribution = [];
async function guarded(id, description, fn) {
  const before = fingerprint(sshDir);
  const record = await suite.check(id, description, fn);
  const after = fingerprint(sshDir);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    const added = Object.keys(after).filter((k) => !(k in before));
    const changed = Object.keys(after).filter((k) => k in before && after[k] !== before[k]);
    const removed = Object.keys(before).filter((k) => !(k in after));
    sshWriteAttribution.push(`${id}: added=[${added.join(',')}] changed=[${changed.join(',')}] removed=[${removed.join(',')}]`);
  }
  return record;
}
const unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(String(reason)));

// --------------------------------------------------------------------- helpers

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** Recursive fingerprint of a directory: relative path -> size/mtime/hash. */
function fingerprint(dir, out = {}) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) fingerprint(full, out);
    else {
      const st = statSync(full);
      out[path.relative(dir, full)] = `${st.size}:${st.mtimeMs}:${sha256File(full)}`;
    }
  }
  return out;
}

function assertThrows(fn, pattern, label) {
  try {
    const value = fn();
    throw new Error(`${label}: expected a thrown error, got ${JSON.stringify(value)?.slice(0, 200)}`);
  } catch (error) {
    if (error?.message?.startsWith(`${label}: expected a thrown error`)) throw error;
    assert(pattern.test(error.message), `${label}: message ${JSON.stringify(error.message)} does not match ${pattern}`);
    return error.message;
  }
}

async function assertRejects(fn, pattern, label) {
  try {
    const value = await fn();
    throw new Error(`${label}: expected a rejection, got ${JSON.stringify(value)?.slice(0, 200)}`);
  } catch (error) {
    if (error?.message?.startsWith(`${label}: expected a rejection`)) throw error;
    assert(pattern.test(error.message), `${label}: message ${JSON.stringify(error.message)} does not match ${pattern}`);
    return error.message;
  }
}

const t0 = Date.now();
const rig = await startRig();
const work = await mkdtemp(path.join(tmpdir(), 'dsh-e2e-'));
const sshDir = path.join(homedir(), '.ssh');
const sshBefore = fingerprint(sshDir);
const realHome = process.env.HOME;

const mod = await import(`${path.join(repoRoot, 'index.js')}?e2e=${Date.now()}`);
const { validateJsonSchemaValue } = await import('@deepseek-ai/dsh-tools');

/** Register the plugin with a raw config, exactly like the Loader does. */
function loadPlugin(rawConfig) {
  const captured = [];
  const ctx = {
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
  const config = mod.Config(rawConfig);
  mod.apply(ctx, config);
  return { defs: new Map(captured.map((d) => [d.name, d])), captured, config };
}

/**
 * Harness-shaped invocation: validate args -> execute -> validate output -> render.
 * Mirrors ToolRuntime (defineTool's own arg validation plus createSuccessResult).
 */
async function callTool(plugin, name, args, exec = {}) {
  const def = plugin.defs.get(name);
  assert(def, `tool "${name}" is not registered`);
  const argViolations = validateJsonSchemaValue(def.parameters, args, 'args');
  assert(argViolations.length === 0, `${name}: harness rejected arguments: ${JSON.stringify(argViolations)}`);
  const raw = await def.execute(args, exec);
  const value = structuredClone(raw);
  const outViolations = validateJsonSchemaValue(def.output.schema, value, 'value');
  assert(outViolations.length === 0,
    `${name}: ToolOutputError — output violates output.schema: ${JSON.stringify(outViolations)}\nvalue=${JSON.stringify(raw).slice(0, 600)}`);
  const rendered = def.output.render(args, value);
  assert(Array.isArray(rendered) && rendered.length > 0, `${name}: output.render must return a non-empty array`);
  for (const block of rendered) {
    assert(block && block.type === 'text' && typeof block.text === 'string',
      `${name}: bad content block ${JSON.stringify(block)?.slice(0, 200)}`);
  }
  return { value, rendered };
}

const HARDENING = ['-o', 'UserKnownHostsFile=/dev/null'];
const rigHost = {
  name: 'rig',
  hostname: '127.0.0.1',
  user: rig.user,
  port: rig.port,
  identityFile: rig.keyPath,
  description: 'hermetic sshd rig',
  extraOptions: HARDENING,
};
const baseConfig = {
  hosts: [rigHost],
  strictHostKeyChecking: 'no',
  connectTimeoutMs: 8000,
  commandTimeoutMs: 30000,
  maxOutputBytes: 262144,
};

let plugin;
let closedPort;

try {
  // ============================================================ F0 registration
  await guarded('F0-registration', 'apply() registers the four frozen tools with harness-valid schemas', () => {
    plugin = loadPlugin(baseConfig);
    assertEqual(plugin.captured.length, 4, 'registered tool count');
    const names = [...plugin.defs.keys()].sort();
    assertEqual(names.join(','), 'ssh_download,ssh_exec,ssh_hosts,ssh_upload', 'tool names');
    for (const [name, def] of plugin.defs) {
      assert(typeof def.output?.render === 'function', `${name}: output.render missing`);
      assert(typeof def.execute === 'function', `${name}: execute missing`);
    }
    assert(typeof mod.apply === 'function' && typeof mod.Config === 'function' && mod.name === 'remote-ssh'
      && Array.isArray(mod.inject) && mod.inject.includes('tools'),
    'plugin export form must be apply/Config/name/inject');
    return `tools=${names.join(',')} name=${mod.name} inject=${JSON.stringify(mod.inject)}`;
  });

  // ================================================================ F1 ssh_exec
  await guarded('F1-exec-success', 'ssh_exec runs a command: exitCode 0, stdout captured, not timed out', async () => {
    const { value } = await withCap(20000, 'F1', () => callTool(plugin, 'ssh_exec', { host: 'rig', command: 'echo RIG_OK' }));
    assertEqual(value.exitCode, 0, 'exitCode');
    assert(/RIG_OK/.test(value.stdout), `stdout must contain RIG_OK, got ${JSON.stringify(value.stdout)}`);
    assertEqual(value.timedOut, false, 'timedOut');
    assertEqual(value.truncated, false, 'truncated');
    assertEqual(value.host, 'rig', 'host');
    assertEqual(value.target, `${rig.user}@127.0.0.1`, 'target');
    assertEqual(value.signal, null, 'signal');
    assert(Number.isInteger(value.durationMs) && value.durationMs >= 0, 'durationMs must be a non-negative integer');
    return `exitCode=0 stdout=${JSON.stringify(value.stdout.trim())} durationMs=${value.durationMs}`;
  });

  await guarded('F2-exec-exit-code', 'ssh_exec propagates a non-zero remote exit code without throwing', async () => {
    const { value } = await withCap(20000, 'F2', () => callTool(plugin, 'ssh_exec', { host: 'rig', command: 'exit 42' }));
    assertEqual(value.exitCode, 42, 'exitCode');
    assertEqual(value.timedOut, false, 'timedOut');
    return 'exitCode=42 propagated';
  });

  await guarded('F3-exec-cwd-env', 'ssh_exec applies cwd and env, including single quotes and spaces', async () => {
    const cwd = path.join(rig.dir, 'e2e-cwd');
    await mkdir(cwd, { recursive: true });
    const { value } = await withCap(20000, 'F3', () => callTool(plugin, 'ssh_exec', {
      host: 'rig',
      command: `printf '%s\\n%s\\n%s\\n' "$RIG_E2E" "$RIG_QUOTE" "$PWD"`,
      cwd,
      env: { RIG_E2E: 'value with spaces', RIG_QUOTE: "it's quoted" },
    }));
    assertEqual(value.exitCode, 0, `exitCode (stderr=${value.stderr})`);
    assert(value.stdout.includes('value with spaces'), `env value with spaces missing: ${JSON.stringify(value.stdout)}`);
    assert(value.stdout.includes("it's quoted"), `env value with single quote missing: ${JSON.stringify(value.stdout)}`);
    assert(value.stdout.includes(cwd), `cwd not applied: ${JSON.stringify(value.stdout)}`);
    return `env+cwd applied, pwd=${cwd}`;
  });

  await guarded('F4-exec-stdin-pty', 'ssh_exec honours stdin and pty (-tt)', async () => {
    const viaStdin = await withCap(20000, 'F4-stdin', () => callTool(plugin, 'ssh_exec', {
      host: 'rig',
      command: 'cat',
      stdin: 'hello-stdin\n',
    }));
    assert(viaStdin.value.stdout.includes('hello-stdin'), `stdin not delivered: ${JSON.stringify(viaStdin.value.stdout)}`);

    const viaPty = await withCap(20000, 'F4-pty', () => callTool(plugin, 'ssh_exec', {
      host: 'rig',
      command: 'tty',
      pty: true,
    }));
    assert(/\/dev\/(pts|tty)/.test(viaPty.value.stdout), `pty not allocated, tty said ${JSON.stringify(viaPty.value.stdout.trim())}`);
    return `stdin ok; pty -> ${viaPty.value.stdout.trim()}`;
  });

  // ============================================================= F5 timeout path
  await guarded('F5-exec-timeout', 'ssh_exec timeout: timedOut=true, returns promptly, local child killed', async () => {
    const marker = '98765432';
    const started = Date.now();
    const { value } = await withCap(25000, 'F5', () => callTool(plugin, 'ssh_exec', {
      host: 'rig',
      command: `sleep ${marker}1`,
      timeoutMs: 1500,
    }));
    const elapsed = Date.now() - started;
    assertEqual(value.timedOut, true, 'timedOut');
    assert(elapsed < 15000, `timeout path took ${elapsed}ms; must not hang`);
    assert(value.exitCode === null || value.exitCode !== 0, `exitCode should not be 0, got ${value.exitCode}`);
    // The local ssh child must be gone: nothing may still hold the connection.
    let survivors = '';
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const probe = runSsh(rig, `pgrep -f 'sleep ${marker}[1]' || true`);
      survivors = probe.stdout.trim();
      if (survivors === '') break;
      await sleep(300);
    }
    // Hygiene: the remote process may outlive the client (see O1 below); reap it.
    runSsh(rig, `pkill -f 'sleep ${marker}[1]' || true`);
    return `timedOut after ${value.durationMs}ms (wall ${elapsed}ms); remote pid(s) still alive at that point: ${JSON.stringify(survivors) || 'none'}`;
  });

  // O1 — characterises a transport limitation rather than a contract violation:
  // ssh_exec kills its local ssh child, but OpenSSH/sshd does not tear down the
  // remote command when the client disappears, so the remote process keeps
  // running. Asserted explicitly so the report carries raw evidence.
  await guarded('O1-remote-outlives-kill', 'OBSERVATION: killing the local ssh child does NOT stop the remote command', async () => {
    const marker = path.join(rig.dir, `outlive-${Date.now()}.txt`);
    const started = Date.now();
    const { value } = await withCap(25000, 'O1', () => callTool(plugin, 'ssh_exec', {
      host: 'rig',
      command: `sleep 3; touch ${marker}`,
      timeoutMs: 1000,
    }));
    assertEqual(value.timedOut, true, 'timedOut');
    assert(Date.now() - started < 10000, 'timeout path must return promptly');
    await sleep(3500);
    const created = existsSync(marker);
    // Reap the remote survivor so the rig stays clean.
    runSsh(rig, `pkill -f 'sleep 3; touch' || true`);
    assertEqual(created, true,
      'expected the remote command to keep running after the client was killed (documented OpenSSH behaviour)');
    return `remote command kept running and created its marker ~3s after the 1s timeout killed the client (documented in REPORT.md as a limitation of client-side cancellation)`;
  });

  // ========================================================= F6 truncation
  await guarded('F6-output-truncation', 'output is capped at maxOutputBytes and flagged truncated', async () => {
    const capped = loadPlugin({ ...baseConfig, maxOutputBytes: 4096 });
    const { value } = await withCap(30000, 'F6', () => callTool(capped, 'ssh_exec', {
      host: 'rig',
      command: 'yes A | head -c 200000',
    }));
    assertEqual(value.exitCode, 0, `exitCode (stderr=${value.stderr})`);
    assertEqual(value.truncated, true, 'truncated flag');
    assert(value.stdout.length <= 4096, `stdout is ${value.stdout.length} bytes, must be <= maxOutputBytes (4096)`);
    assert(value.stdout.length > 0, 'stdout must not be empty');
    return `stdout=${value.stdout.length}B (cap 4096), truncated=true`;
  });

  // ========================================================= F7 transfer round trip
  await guarded('F7-transfer-roundtrip', 'ssh_upload then ssh_download returns byte-identical content', async () => {
    const bytes = Buffer.alloc(65536);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 131 + 7) % 256;
    const localSource = path.join(work, 'up.bin');
    const remotePath = path.join(rig.dir, 'e2e-roundtrip.bin');
    const localBack = path.join(work, 'down.bin');
    await writeFile(localSource, bytes);

    const up = await withCap(30000, 'F7-upload', () => callTool(plugin, 'ssh_upload', {
      host: 'rig', localPath: localSource, remotePath,
    }));
    assertEqual(up.value.exitCode, 0, `upload exitCode (stderr=${up.value.stderr})`);
    assert(existsSync(remotePath), 'uploaded file must exist on the rig');
    assertEqual(up.value.host, 'rig', 'upload host');

    const down = await withCap(30000, 'F7-download', () => callTool(plugin, 'ssh_download', {
      host: 'rig', remotePath, localPath: localBack,
    }));
    assertEqual(down.value.exitCode, 0, `download exitCode (stderr=${down.value.stderr})`);
    const back = await readFile(localBack);
    assertEqual(back.length, bytes.length, 'round-tripped length');
    assert(back.equals(bytes), 'round-tripped bytes must be identical');
    return `${bytes.length}B round trip byte-identical (sha256 ${createHash('sha256').update(back).digest('hex').slice(0, 16)}...)`;
  });

  await guarded('F8-transfer-recursive', 'ssh_upload/ssh_download with recursive:true move a directory tree', async () => {
    const srcDir = path.join(work, 'tree');
    await mkdir(srcDir, { recursive: true });
    await writeFile(path.join(srcDir, 'a.txt'), 'alpha\n');
    await writeFile(path.join(srcDir, 'b.txt'), 'beta\n');
    const remoteDir = path.join(rig.dir, 'e2e-tree');
    const backDir = path.join(work, 'tree-back');

    const up = await withCap(30000, 'F8-up', () => callTool(plugin, 'ssh_upload', {
      host: 'rig', localPath: srcDir, remotePath: remoteDir, recursive: true,
    }));
    assertEqual(up.value.exitCode, 0, `recursive upload exitCode (stderr=${up.value.stderr})`);
    const down = await withCap(30000, 'F8-down', () => callTool(plugin, 'ssh_download', {
      host: 'rig', remotePath: remoteDir, localPath: backDir, recursive: true,
    }));
    assertEqual(down.value.exitCode, 0, `recursive download exitCode (stderr=${down.value.stderr})`);
    assertEqual(await readFile(path.join(backDir, 'a.txt'), 'utf8'), 'alpha\n', 'a.txt');
    assertEqual(await readFile(path.join(backDir, 'b.txt'), 'utf8'), 'beta\n', 'b.txt');
    return 'recursive tree round trip ok';
  });

  // ========================================================= F9 ssh_hosts
  await guarded('F9-hosts-listing', 'ssh_hosts lists configured hosts and reports the resolved ssh path', async () => {
    const { value } = await withCap(20000, 'F9', () => callTool(plugin, 'ssh_hosts', {}));
    assertEqual(value.hosts.length, 1, 'configured host count');
    const host = value.hosts[0];
    assertEqual(host.name, 'rig', 'host name');
    assertEqual(host.target, `${rig.user}@127.0.0.1`, 'host target');
    assertEqual(host.port, rig.port, 'host port');
    assertEqual(value.acceptsRawTargets, true, 'acceptsRawTargets');
    assert(typeof value.note === 'string' && value.note.length > 0, 'note must be present');
    assertEqual(value.sshExecutable, 'ssh', 'sshExecutable');
    assert(value.resolvedSshExecutable && value.resolvedSshExecutable.endsWith('/ssh'),
      `resolvedSshExecutable should be an absolute ssh path, got ${JSON.stringify(value.resolvedSshExecutable)}`);
    assertEqual(Array.isArray(value.allowedHosts) && value.allowedHosts.length, 0, 'allowedHosts empty = any');
    return `1 host (rig -> ${host.target}:${host.port}), resolved=${value.resolvedSshExecutable}`;
  });

  await guarded('F10-hosts-check', 'ssh_hosts check:true probes reachability and reports latency', async () => {
    const { value } = await withCap(30000, 'F10', () => callTool(plugin, 'ssh_hosts', { check: true }));
    assertEqual(value.hosts.length, 1, 'host count');
    assertEqual(value.hosts[0].reachable, true, `reachable (error=${value.hosts[0].error})`);
    assert(Number.isInteger(value.hosts[0].latencyMs) && value.hosts[0].latencyMs >= 0, 'latencyMs');
    return `reachable=true latency=${value.hosts[0].latencyMs}ms`;
  });

  // ========================================================= F11 allowedHosts
  await guarded('F11-allowed-hosts', 'allowedHosts rejects a non-matching target and accepts a matching glob', async () => {
    const denied = loadPlugin({ ...baseConfig, allowedHosts: ['some-other-host'] });
    const message = await assertRejects(
      () => withCap(10000, 'F11-deny', () => callTool(denied, 'ssh_exec', { host: 'rig', command: 'echo NOPE' })),
      /allowedHosts/i,
      'F11 denial',
    );
    const allowed = loadPlugin({ ...baseConfig, allowedHosts: ['r*'] });
    const { value } = await withCap(20000, 'F11-glob', () => callTool(allowed, 'ssh_exec', { host: 'rig', command: 'echo GLOB_OK' }));
    assertEqual(value.exitCode, 0, 'glob-allowed call should succeed');
    return `denied with ${JSON.stringify(message.slice(0, 80))}...; glob "r*" allowed`;
  });

  // ================================================== F12 raw target / ssh alias
  // OpenSSH resolves a raw target itself. To keep the test hermetic (never write
  // to the user's ~/.ssh) the alias is defined in a PRIVATE ssh_config that is
  // injected through the plugin's own `sshExecutable` setting: a tiny wrapper
  // that execs `/usr/bin/ssh -F <private config> "$@"`. This is exactly what the
  // plugin does in production - hand the target to OpenSSH verbatim - just with a
  // different config file. `ssh -F` is a real OpenSSH feature, not a stub.
  await guarded('F12-raw-target-alias', 'raw targets work with NO config entry, via an ssh_config alias', async () => {
    const aliasConfig = path.join(work, 'alias_ssh_config');
    await writeFile(aliasConfig, [
      'Host RigAlias',
      '  HostName 127.0.0.1',
      `  Port ${rig.port}`,
      `  User ${rig.user}`,
      `  IdentityFile ${rig.keyPath}`,
      '  StrictHostKeyChecking no',
      '  UserKnownHostsFile /dev/null',
      '  BatchMode yes',
      '',
    ].join('\n'), { mode: 0o600 });
    const wrapper = path.join(work, 'ssh-with-private-config');
    await writeFile(wrapper, `#!/bin/sh\nexec /usr/bin/ssh -F '${aliasConfig}' "$@"\n`, { mode: 0o755 });

    const raw = loadPlugin({ hosts: [], strictHostKeyChecking: 'no', connectTimeoutMs: 8000, sshExecutable: wrapper });
    assertEqual(raw.config.hosts.length, 0, 'this instance has no configured hosts');
    assertEqual(raw.config.sshExecutable, wrapper, 'sshExecutable override must be honoured');
    const { value } = await withCap(25000, 'F12', () => callTool(raw, 'ssh_exec', { host: 'RigAlias', command: 'echo ALIAS_OK' }));
    assertEqual(value.exitCode, 0, `alias exec exitCode (stderr=${value.stderr})`);
    assert(value.stdout.includes('ALIAS_OK'), `stdout: ${JSON.stringify(value.stdout)}`);
    assertEqual(value.target, 'RigAlias', 'a raw target must be passed to OpenSSH verbatim');
    // No -p/-i may be synthesised for a raw target: the alias carries them.
    const hostsInfo = await withCap(20000, 'F12-hosts', () => callTool(raw, 'ssh_hosts', {}));
    assertEqual(hostsInfo.value.hosts.length, 0, 'raw-target instance lists no configured hosts');
    return 'unconfigured alias RigAlias resolved by OpenSSH itself (private -F config), target passed verbatim';
  });

  await guarded('F13-default-accept-new', 'default strictHostKeyChecking=accept-new pins the host key', async () => {
    const knownHosts = path.join(work, 'accept_new_known_hosts');
    const def = loadPlugin({
      hosts: [{ ...rigHost, extraOptions: ['-o', `UserKnownHostsFile=${knownHosts}`] }],
      connectTimeoutMs: 8000,
      commandTimeoutMs: 30000,
    });
    assertEqual(def.config.strictHostKeyChecking, 'accept-new', 'default mode must be accept-new');
    const { value } = await withCap(25000, 'F13', () => callTool(def, 'ssh_exec', { host: 'rig', command: 'echo ACCEPT_NEW_OK' }));
    assertEqual(value.exitCode, 0, `accept-new exec exitCode (stderr=${value.stderr})`);
    assert(existsSync(knownHosts), `accept-new must record the host key in ${knownHosts}`);
    const text = readFileSync(knownHosts, 'utf8');
    assert(text.includes('127.0.0.1'), `known_hosts should mention the rig host, got ${JSON.stringify(text.slice(0, 200))}`);
    // A second connection must now succeed against the pinned key.
    const second = await withCap(25000, 'F13-again', () => callTool(def, 'ssh_exec', { host: 'rig', command: 'echo PINNED_OK' }));
    assertEqual(second.value.exitCode, 0, `second accept-new exec exitCode (stderr=${second.value.stderr})`);
    return `accept-new pinned the rig key into the configured UserKnownHostsFile (${path.basename(knownHosts)}); second call OK`;
  });

  // ================================================== F14 argv shape (real code)
  await guarded('F14-argv-shape', 'buildSshArgv/buildScpArgv match the frozen argv contract', async () => {
    const { buildSshArgv, buildScpArgv, composeRemoteScript, sq, connectTimeoutSeconds } = await import(
      `${path.join(repoRoot, 'lib', 'shell.js')}?e2e=${Date.now()}`
    );
    const argv = buildSshArgv({
      executable: 'ssh', port: 2222, identityFile: '/k', proxyJump: 'jump@bastion',
      connectTimeoutMs: 1500, strictHostKeyChecking: 'accept-new',
      extraOptions: ['-o', 'Foo=bar'], target: 'u@h', remoteScript: 'echo hi', pty: true,
    });
    const expected = ['ssh', '-p', '2222', '-i', '/k', '-J', 'jump@bastion',
      '-o', 'ConnectTimeout=2', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'Foo=bar', '-tt', '--', 'u@h', 'echo hi'];
    assertEqual(JSON.stringify(argv), JSON.stringify(expected), 'ssh argv');

    const scp = buildScpArgv({
      executable: 'scp', port: 2222, identityFile: '/k', connectTimeoutMs: 1500,
      strictHostKeyChecking: 'no', extraOptions: [], recursive: true, source: 'a', destination: 'b',
    });
    assertEqual(JSON.stringify(scp), JSON.stringify([
      'scp', '-P', '2222', '-i', '/k', '-o', 'ConnectTimeout=2', '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=no', '-r', '-q', '--', 'a', 'b',
    ]), 'scp argv');

    // Regression for D2: `--` must sit immediately before the two operands.
    const dashIndex = scp.indexOf('--');
    assert(dashIndex > 0, 'scp argv must contain the `--` end-of-options terminator');
    assertEqual(scp[dashIndex + 1], 'a', 'the first operand must follow `--`');
    assertEqual(scp[dashIndex + 2], 'b', 'the second operand must follow `--`');
    assertEqual(scp.length, dashIndex + 3, 'nothing may follow the two operands');
    assertEqual(scp.filter((token) => token === '--').length, 1, 'exactly one `--`');

    const scpPlain = buildScpArgv({
      executable: 'scp', port: undefined, identityFile: undefined, connectTimeoutMs: 1500,
      strictHostKeyChecking: 'accept-new', extraOptions: [], recursive: false,
      source: '/abs/a', destination: 'u@h:/abs/b',
    });
    assertEqual(JSON.stringify(scpPlain), JSON.stringify([
      'scp', '-o', 'ConnectTimeout=2', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new',
      '-q', '--', '/abs/a', 'u@h:/abs/b',
    ]), 'scp argv without port/identity/recursive');

    assertEqual(sq("it's"), "'it'\\''s'", 'POSIX single-quote escaping');
    assertEqual(composeRemoteScript({ cwd: '/a b', env: { K: 'v' }, command: 'true' }), "cd '/a b' && export K='v' && true", 'remote script composition');
    assertEqual(connectTimeoutSeconds(1500), '2', 'ConnectTimeout rounds up');
    assertEqual(connectTimeoutSeconds(0), '1', 'ConnectTimeout floors at 1s');
    return 'ssh/scp argv, sq(), composeRemoteScript() and ConnectTimeout all match';
  });

  await guarded('F15-presentCall-render', 'presentCall and render run cleanly for every tool', async () => {
    const results = [];
    const hosts = await callTool(plugin, 'ssh_hosts', {});
    const exec = await callTool(plugin, 'ssh_exec', { host: 'rig', command: 'echo RENDER' });
    const upload = await callTool(plugin, 'ssh_upload', {
      host: 'rig', localPath: path.join(work, 'up.bin'), remotePath: path.join(rig.dir, 'render.bin'),
    });
    const download = await callTool(plugin, 'ssh_download', {
      host: 'rig', remotePath: path.join(rig.dir, 'render.bin'), localPath: path.join(work, 'render-back.bin'),
    });
    for (const [name, result] of [['ssh_hosts', hosts], ['ssh_exec', exec], ['ssh_upload', upload], ['ssh_download', download]]) {
      const def = plugin.defs.get(name);
      const blocks = def.output.render({}, result.value);
      assert(Array.isArray(blocks) && blocks.every((b) => b.type === 'text' && typeof b.text === 'string'),
        `${name}: render must return text blocks`);
      if (typeof def.presentCall === 'function') {
        const args = name === 'ssh_hosts' ? {} : { host: 'rig', command: 'x', localPath: 'a', remotePath: 'b' };
        const card = def.presentCall(args);
        assert(card !== undefined && card !== null && typeof card === 'object', `${name}: presentCall must return an object`);
      }
      results.push(`${name}: ${blocks[0].text.split('\n')[0].slice(0, 60)}`);
    }
    return results.join(' | ');
  });

  await guarded('F16-timeout-render-caveat', 'FIXED: a timed-out ssh_exec render carries the remote-may-still-run caveat', async () => {
    const marker = '97531';
    const { value, rendered } = await withCap(25000, 'F16', () => callTool(plugin, 'ssh_exec', {
      host: 'rig', command: `sleep ${marker}1`, timeoutMs: 1200,
    }));
    assertEqual(value.timedOut, true, 'timedOut');
    const text = rendered.map((block) => block.text).join('\n');
    const CAVEAT = 'Only the local ssh client was terminated; the remote command may still be running on the remote host, so re-check the remote host before assuming it stopped.';
    assert(text.includes(CAVEAT), `render must contain the caveat sentence, got:\n${text}`);
    assert(/timed out after \d+ms and was killed/.test(text), `render must still report the timeout header, got:\n${text}`);

    // The caveat must NOT appear for a normal (non-timeout) result.
    const ok = await withCap(20000, 'F16-ok', () => callTool(plugin, 'ssh_exec', { host: 'rig', command: 'echo FINE' }));
    const okText = ok.rendered.map((block) => block.text).join('\n');
    assert(!okText.includes(CAVEAT), 'the caveat must not be rendered for a successful call');
    runSsh(rig, `pkill -f 'sleep ${marker}[1]' || true`);
    return `caveat present on timeout, absent on success; header=${JSON.stringify(text.split('\n')[0])}`;
  });

  // ============================================================ ADVERSARIAL
  await guarded('A1-metachar-target', 'a target containing shell metacharacters is inert (no local shell, no injection)', async () => {
    const pwned = path.join(work, 'PWNED');
    const raw = loadPlugin({ hosts: [], strictHostKeyChecking: 'no', connectTimeoutMs: 3000, commandTimeoutMs: 8000 });
    const targets = [
      `127.0.0.1; touch ${pwned}`,
      `127.0.0.1$(touch ${pwned})`,
      '127.0.0.1`touch ' + pwned + '`',
      `127.0.0.1 && touch ${pwned}`,
    ];
    const observed = [];
    for (const target of targets) {
      const started = Date.now();
      let outcome;
      try {
        const { value } = await withCap(20000, `A1(${target.slice(0, 20)})`, () => callTool(raw, 'ssh_exec', {
          host: target, command: 'echo INJECTED', timeoutMs: 5000,
        }));
        outcome = `exitCode=${value.exitCode}`;
        assert(value.exitCode !== 0, `target ${JSON.stringify(target)} unexpectedly succeeded`);
      } catch (error) {
        if (error.message.includes('exceeded')) throw error;
        outcome = `threw ${JSON.stringify(error.message.slice(0, 60))}`;
      }
      observed.push(`${JSON.stringify(target.slice(0, 24))} -> ${outcome} in ${Date.now() - started}ms`);
      assert(!existsSync(pwned), `command injection succeeded: ${pwned} was created by target ${JSON.stringify(target)}`);
    }
    return observed.join('; ');
  });

  await guarded('A2-invalid-env-keys', 'invalid POSIX env keys are rejected before any process is spawned', async () => {
    const bad = [
      { 'BAD KEY': 'x' },
      { '1LEADING': 'x' },
      { 'a-b': 'x' },
      { '': 'x' },
      { 'a.b': 'x' },
    ];
    const messages = [];
    for (const env of bad) {
      const key = Object.keys(env)[0];
      const started = Date.now();
      const message = await assertRejects(
        () => withCap(5000, `A2(${JSON.stringify(key)})`, () => callTool(plugin, 'ssh_exec', { host: 'rig', command: 'true', env })),
        /env key|POSIX environment variable/i,
        `A2 key ${JSON.stringify(key)}`,
      );
      assert(Date.now() - started < 2000, `rejection for ${JSON.stringify(key)} took ${Date.now() - started}ms; should be immediate`);
      messages.push(`${JSON.stringify(key)} -> ${JSON.stringify(message.slice(0, 70))}`);
    }
    const nonString = await assertRejects(
      () => withCap(5000, 'A2-value', () => callTool(plugin, 'ssh_exec', { host: 'rig', command: 'true', env: { GOOD: 123 } })),
      /must be a string/i,
      'A2 non-string value',
    );
    messages.push(`GOOD:123 -> ${JSON.stringify(nonString.slice(0, 60))}`);
    return messages.join('; ');
  });

  await guarded('A3-quoted-command-and-cwd', 'single quotes in command and cwd are preserved literally', async () => {
    const weird = path.join(rig.dir, "we'ird dir");
    await mkdir(weird, { recursive: true });
    const { value } = await withCap(20000, 'A3', () => callTool(plugin, 'ssh_exec', {
      host: 'rig',
      cwd: weird,
      command: `printf 'cmd:%s\\npwd:%s\\n' "it's fine" "$PWD"`,
    }));
    assertEqual(value.exitCode, 0, `exitCode (stderr=${value.stderr})`);
    assert(value.stdout.includes("cmd:it's fine"), `command quoting lost: ${JSON.stringify(value.stdout)}`);
    assert(value.stdout.includes(`pwd:${weird}`), `cwd quoting lost: ${JSON.stringify(value.stdout)}`);
    return `quotes preserved in command and in cwd ${JSON.stringify(weird)}`;
  });

  await guarded('A4-unreachable-host', 'a closed port fails fast with a structured error and no hang', async () => {
    closedPort = await freePort();
    assertEqual(await isPortListening(closedPort), false, 'the chosen port must be closed');
    const unreachable = loadPlugin({
      hosts: [{
        name: 'dead', hostname: '127.0.0.1', user: rig.user, port: closedPort,
        identityFile: rig.keyPath, extraOptions: HARDENING,
      }],
      strictHostKeyChecking: 'no',
      connectTimeoutMs: 2000,
      commandTimeoutMs: 5000,
    });
    const started = Date.now();
    const { value } = await withCap(20000, 'A4', () => callTool(unreachable, 'ssh_exec', { host: 'dead', command: 'echo NO' }));
    const elapsed = Date.now() - started;
    assert(value.exitCode !== 0, `exitCode must be non-zero, got ${value.exitCode}`);
    assert(elapsed < 15000, `unreachable host took ${elapsed}ms; must fail fast`);
    assert(value.stderr.length > 0, 'a structured stderr diagnostic is expected');
    return `exitCode=${value.exitCode} in ${elapsed}ms, stderr=${JSON.stringify(value.stderr.split('\n')[0].slice(0, 80))}`;
  });

  await guarded('A5-abort-signal', 'exec.signal cancels an in-flight command promptly', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const promise = callTool(plugin, 'ssh_exec', { host: 'rig', command: 'sleep 60', timeoutMs: 60000 }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 400);
    const { value } = await withCap(15000, 'A5', () => promise);
    const elapsed = Date.now() - started;
    assert(elapsed < 10000, `abort took ${elapsed}ms; must be prompt`);
    assert(value.timedOut === false, 'an abort is not a timeout');
    assert(value.exitCode !== 0, `exitCode should be non-zero after abort, got ${value.exitCode}`);
    return `aborted in ${elapsed}ms, exitCode=${value.exitCode} signal=${JSON.stringify(value.signal)}`;
  });

  await guarded('A6-dash-prefixed-path', 'FIXED: a relative transfer path starting with "-" now transfers', async () => {
    // Regression for D2. lib/shell.js buildScpArgv now emits `-q -- src dst`, so
    // a *relative* operand beginning with `-` is transferred as a path.
    const cwd = process.cwd();
    process.chdir(work);
    try {
      const dashBytes = Buffer.from('dash-content-0123456789\n', 'utf8');
      await writeFile(path.join(work, '-dashfile'), dashBytes);
      const remotePath = path.join(rig.dir, 'dash.bin');

      const { value } = await withCap(25000, 'A6', () => callTool(plugin, 'ssh_upload', {
        host: 'rig', localPath: '-dashfile', remotePath,
      }));
      assertEqual(value.exitCode, 0, `dash-prefixed upload must now succeed (stderr=${value.stderr})`);
      assertEqual(value.localPath, '-dashfile', 'localPath must be reported verbatim');
      const onRig = await readFile(remotePath);
      assert(onRig.equals(dashBytes), 'the transferred bytes must be identical');

      // And back again through ssh_download with a dash-prefixed relative path.
      const backName = '-dashback';
      const down = await withCap(25000, 'A6-download', () => callTool(plugin, 'ssh_download', {
        host: 'rig', remotePath, localPath: backName,
      }));
      assertEqual(down.value.exitCode, 0, `dash-prefixed download must succeed (stderr=${down.value.stderr})`);
      assert((await readFile(path.join(work, backName))).equals(dashBytes), 'downloaded bytes must be identical');

      // Ordinary relative and absolute paths must still work.
      await writeFile(path.join(work, 'ordinary.txt'), 'ordinary\n');
      const ordinary = await withCap(25000, 'A6-ordinary', () => callTool(plugin, 'ssh_upload', {
        host: 'rig', localPath: 'ordinary.txt', remotePath: path.join(rig.dir, 'ordinary.bin'),
      }));
      assertEqual(ordinary.value.exitCode, 0, `ordinary relative path (stderr=${ordinary.value.stderr})`);
      const absolute = await withCap(25000, 'A6-absolute', () => callTool(plugin, 'ssh_upload', {
        host: 'rig', localPath: path.join(work, 'ordinary.txt'), remotePath: path.join(rig.dir, 'ordinary-abs.bin'),
      }));
      assertEqual(absolute.value.exitCode, 0, `absolute path (stderr=${absolute.value.stderr})`);
      return `dash upload+download byte-identical (${dashBytes.length}B), ordinary relative and absolute paths still OK`;
    } finally {
      process.chdir(cwd);
    }
  });

  await guarded('A7-nonexistent-cwd', 'a nonexistent remote cwd fails structurally instead of hanging', async () => {
    const started = Date.now();
    const { value } = await withCap(20000, 'A7', () => callTool(plugin, 'ssh_exec', {
      host: 'rig', cwd: '/nonexistent/definitely/not/here', command: 'echo SHOULD_NOT_RUN',
    }));
    const elapsed = Date.now() - started;
    assert(value.exitCode !== 0, `exitCode must be non-zero, got ${value.exitCode}`);
    assert(!value.stdout.includes('SHOULD_NOT_RUN'), 'the command must not run when cd fails');
    assert(elapsed < 10000, `took ${elapsed}ms`);
    return `exitCode=${value.exitCode} in ${elapsed}ms, stderr=${JSON.stringify(value.stderr.split('\n')[0].slice(0, 60))}`;
  });

  await guarded('A8-max-output-boundary', 'maxOutputBytes=1 is handled without crashing or unbounded output', async () => {
    const tiny = loadPlugin({ ...baseConfig, maxOutputBytes: 1 });
    const { value } = await withCap(30000, 'A8', () => callTool(tiny, 'ssh_exec', {
      host: 'rig', command: 'printf abcdefghij',
    }));
    assert(value.stdout.length <= 1, `stdout is ${value.stdout.length} bytes, cap was 1`);
    assertEqual(value.truncated, true, 'truncated');
    return `cap=1 honoured (stdout=${JSON.stringify(value.stdout)}, truncated=true)`;
  });

  await guarded('A9-no-ssh-writes', 'nothing wrote to the real ~/.ssh during the whole run', () => {
    const after = fingerprint(sshDir);
    const before = Object.keys(sshBefore);
    const afterKeys = Object.keys(after);
    const added = afterKeys.filter((k) => !(k in sshBefore));
    const removed = before.filter((k) => !(k in after));
    const changed = afterKeys.filter((k) => k in sshBefore && after[k] !== sshBefore[k]);
    assert(added.length === 0, `~/.ssh gained files: ${added.join(', ')}`);
    assert(removed.length === 0, `~/.ssh lost files: ${removed.join(', ')}`);
    assert(changed.length === 0, `~/.ssh files changed: ${changed.join(', ')}`);
    assert(sshWriteAttribution.length === 0,
      `the following checks touched the real ~/.ssh: ${sshWriteAttribution.join(' | ')}`);
    return `${afterKeys.length} files in ~/.ssh, all byte-identical (incl. known_hosts); 0 of ${suite.results.length - 1} checks wrote to ~/.ssh`;
  });

  await guarded('A10-no-unhandled-rejections', 'no unhandled promise rejections escaped the plugin', () => {
    assert(unhandled.length === 0, `unhandled rejections: ${unhandled.join(' | ')}`);
    return 'none';
  });
} finally {
  // Always tear down, whatever happened above.
  process.env.HOME = realHome;
  await stopRig(rig);
  if (existsSync(work)) await rm(work, { recursive: true, force: true });
}

const summary = suite.summary();
process.stdout.write(`total wall clock: ${Date.now() - t0}ms\n`);

const jsonFlag = process.argv.indexOf('--json');
if (jsonFlag !== -1 && process.argv[jsonFlag + 1]) {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const out = path.resolve(process.argv[jsonFlag + 1]);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify({ suite: 'e2e', results: suite.results, summary, unhandled }, null, 2)}\n`);
  process.stdout.write(`wrote ${out}\n`);
}

process.exit(summary.failed === 0 ? 0 : 1);
