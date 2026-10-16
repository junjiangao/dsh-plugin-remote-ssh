/**
 * Hermetic, unprivileged sshd test rig.
 *
 * Starts a private OpenSSH server bound to 127.0.0.1 on an ephemeral high port,
 * using only files inside a throwaway directory under the OS temp dir. Nothing
 * outside that directory is touched:
 *
 *   - no ~/.ssh reads or writes (clients always use
 *     `-o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no`)
 *   - no system sshd_config
 *   - no root, no privileged port, no PAM, no password auth
 *
 * Node builtins only.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile, chmod, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

/** Absolute paths are preferred so the rig does not depend on the caller's PATH. */
const DEFAULT_BINS = {
  ssh: '/usr/bin/ssh',
  scp: '/usr/bin/scp',
  sshd: '/usr/bin/sshd',
  'ssh-keygen': '/usr/bin/ssh-keygen',
};

const CLIENT_HARDENING = [
  '-o', 'BatchMode=yes',
  '-o', 'StrictHostKeyChecking=no',
  '-o', 'UserKnownHostsFile=/dev/null',
];

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** POSIX single-quote escaping. */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function resolveBin(explicit, name) {
  if (explicit) return explicit;
  const fallback = DEFAULT_BINS[name];
  if (fallback && existsSync(fallback)) return fallback;
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`rig: cannot locate executable "${name}" (looked at ${fallback} and PATH)`);
}

function runSync(bin, args, { timeoutMs = 30_000, cwd, env, input } = {}) {
  const result = spawnSync(bin, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    cwd,
    env: env ?? process.env,
    input,
  });
  const timedOut = result.error?.code === 'ETIMEDOUT';
  if (result.error && !timedOut) {
    throw new Error(`rig: ${bin} ${args.join(' ')} failed: ${result.error.message}`);
  }
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    timedOut,
  };
}

export function currentUser() {
  const result = spawnSync('id', ['-un'], { encoding: 'utf8' });
  if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  return process.env.USER || process.env.LOGNAME || 'nobody';
}

export function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** Ask the kernel for a currently-free ephemeral port. */
export function freePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

/** True when a TCP connect to host:port succeeds within timeoutMs. */
export function isPortListening(port, host = '127.0.0.1', timeoutMs = 500) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    const socket = connect({ port, host });
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function waitFor(predicate, timeoutMs, intervalMs = 25) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      let value = false;
      try {
        value = predicate();
      } catch {
        value = false;
      }
      if (value) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function sshdConfigText({ port, dir }) {
  const q = (value) => (/[\s#"']/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value);
  return [
    `Port ${port}`,
    'ListenAddress 127.0.0.1',
    `HostKey ${q(path.join(dir, 'hostkey'))}`,
    `PidFile ${q(path.join(dir, 'sshd.pid'))}`,
    `AuthorizedKeysFile ${q(path.join(dir, 'authorized_keys'))}`,
    'UsePAM no',
    'PasswordAuthentication no',
    'KbdInteractiveAuthentication no',
    'PermitRootLogin no',
    'StrictModes no',
    'LogLevel VERBOSE',
    'PrintMotd no',
    'AllowAgentForwarding no',
    'X11Forwarding no',
    // scp uses the SFTP protocol by default on modern OpenSSH; internal-sftp is
    // built into sshd, so no external sftp-server path is required.
    'Subsystem sftp internal-sftp',
    '',
  ].join('\n');
}

function buildRig({ bins, host, port, user, dir, keyPath, child, logPath, configPath }) {
  const target = `${user}@${host}`;
  const sshBaseArgs = ['-i', keyPath, '-p', String(port), ...CLIENT_HARDENING];
  const scpBaseArgs = ['-i', keyPath, '-P', String(port), ...CLIENT_HARDENING];
  const sshCommand = [bins.ssh, ...sshBaseArgs, '--', target].map(shellQuote).join(' ');
  const scpCommand = [bins.scp, ...scpBaseArgs].map(shellQuote).join(' ');

  const rig = {
    host,
    port,
    user,
    target,
    keyPath,
    dir,
    sshCommand,
    scpCommand,
    sshBaseArgs,
    scpBaseArgs,
    bins,
    child,
    sshdPid: child?.pid ?? null,
    starterPid: null,
    logPath,
    configPath,
    pidFile: path.join(dir, 'sshd.pid'),
    stopped: false,
    stop: () => stopRig(rig),
  };
  rig.cleanup = rig.stop;
  return rig;
}

async function readLogTail(logPath, lines = 20) {
  try {
    const text = await readFile(logPath, 'utf8');
    return text.trim().split('\n').slice(-lines).join('\n');
  } catch {
    return '(no sshd log)';
  }
}

/**
 * Start an isolated sshd.
 *
 * @param {object} [options]
 * @param {number} [options.port]       force a port (no retry) instead of an ephemeral one
 * @param {string} [options.dir]        force the rig directory (default: mkdtemp under tmpdir())
 * @param {string} [options.tmpRoot]    parent for the auto-created rig directory
 * @param {string} [options.user]       login name to authorize (default: `id -un`)
 * @param {number} [options.startTimeoutMs=15000]
 * @param {boolean} [options.verify=true] also prove readiness with a real ssh handshake
 * @returns {Promise<object>} rig coordinates + `stop()`/`cleanup()`
 */
export async function startRig(options = {}) {
  const bins = {
    ssh: resolveBin(options.sshBin, 'ssh'),
    scp: resolveBin(options.scpBin, 'scp'),
    sshd: resolveBin(options.sshdBin, 'sshd'),
    'ssh-keygen': resolveBin(options.sshKeygenBin, 'ssh-keygen'),
  };
  const host = options.host ?? '127.0.0.1';
  const user = options.user ?? currentUser();
  const startTimeoutMs = options.startTimeoutMs ?? 15_000;
  const attempts = options.port ? 1 : 5;

  let dir = options.dir;
  if (dir) {
    await mkdir(dir, { recursive: true });
  } else {
    dir = await mkdtemp(path.join(options.tmpRoot ?? tmpdir(), 'dsh-ssh-rig-'));
  }

  const keyPath = path.join(dir, 'clientkey');
  const logPath = path.join(dir, 'sshd.log');
  const configPath = path.join(dir, 'sshd_config');

  // Keys are generated once; each start attempt reuses them.
  if (!existsSync(path.join(dir, 'hostkey'))) {
    const hostKey = runSync(bins['ssh-keygen'], ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(dir, 'hostkey')]);
    if (hostKey.status !== 0) throw new Error(`rig: host key generation failed: ${hostKey.stderr}`);
  }
  if (!existsSync(keyPath)) {
    const clientKey = runSync(bins['ssh-keygen'], ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath]);
    if (clientKey.status !== 0) throw new Error(`rig: client key generation failed: ${clientKey.stderr}`);
  }
  const authorizedKeys = path.join(dir, 'authorized_keys');
  const publicKey = await readFile(`${keyPath}.pub`, 'utf8');
  await writeFile(authorizedKeys, publicKey, { mode: 0o600 });
  await chmod(authorizedKeys, 0o600);

  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const port = options.port ?? (await freePort(host));
    await writeFile(configPath, sshdConfigText({ port, dir }), { mode: 0o600 });

    const child = spawn(bins.sshd, ['-D', '-f', configPath, '-E', logPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: process.env,
    });
    let exitInfo = null;
    child.once('exit', (code, signal) => {
      exitInfo = { code, signal };
    });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const deadline = Date.now() + startTimeoutMs;
    let listening = false;
    while (Date.now() < deadline) {
      if (exitInfo) break;
      if (await isPortListening(port, host, 200)) {
        listening = true;
        break;
      }
      await sleep(40);
    }

    const rig = buildRig({ bins, host, port, user, dir, keyPath, child, logPath, configPath });

    let ready = listening;
    if (ready && options.verify !== false) {
      ready = false;
      for (let probe = 0; probe < 3 && !ready; probe += 1) {
        const result = runSync(
          bins.ssh,
          [...rig.sshBaseArgs, '--', rig.target, 'exit 0'],
          { timeoutMs: 8_000 },
        );
        ready = result.status === 0;
        if (!ready) await sleep(150);
      }
    }

    if (ready) return rig;

    // Failed to come up: reap the child and retry on a fresh port.
    if (!exitInfo) {
      child.kill('SIGTERM');
      await waitFor(() => exitInfo !== null, 3_000);
      if (!exitInfo) {
        child.kill('SIGKILL');
        await waitFor(() => exitInfo !== null, 2_000);
      }
    }
    lastError = new Error(
      `rig: sshd did not become ready on ${host}:${port}`
      + (exitInfo ? ` (exited code=${exitInfo.code} signal=${exitInfo.signal})` : '')
      + (stderr.trim() ? ` stderr=${stderr.trim()}` : '')
      + `\nsshd log:\n${await readLogTail(logPath)}`,
    );
    if (options.port) break;
  }

  await rm(dir, { recursive: true, force: true });
  throw lastError ?? new Error('rig: failed to start sshd');
}

/** Stop a rig (idempotent). Kills sshd, waits for the port to close, removes the temp dir. */
export async function stopRig(rig) {
  if (!rig || rig.stopped) {
    if (rig?.dir && existsSync(rig.dir)) await rm(rig.dir, { recursive: true, force: true });
    return;
  }
  rig.stopped = true;

  const child = rig.child;
  const childAlive = child && child.exitCode === null && child.signalCode === null;
  if (childAlive) {
    child.kill('SIGTERM');
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, 3_000);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await waitFor(() => child.exitCode !== null || child.signalCode !== null, 2_000);
    }
  } else if (isAlive(rig.sshdPid)) {
    try {
      process.kill(rig.sshdPid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    await waitFor(() => !isAlive(rig.sshdPid), 3_000);
    if (isAlive(rig.sshdPid)) {
      try {
        process.kill(rig.sshdPid, 'SIGKILL');
      } catch {
        /* already gone */
      }
      await waitFor(() => !isAlive(rig.sshdPid), 2_000);
    }
  }

  if (rig.port) {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && (await isPortListening(rig.port, rig.host, 150))) {
      await sleep(50);
    }
  }

  if (rig.dir && existsSync(rig.dir)) await rm(rig.dir, { recursive: true, force: true });
}

/** Run a remote command over ssh. Returns spawnSync-shaped output (never throws on non-zero exit). */
export function runSsh(rig, command, { timeoutMs = 30_000, extraArgs = [] } = {}) {
  return runSync(
    rig.bins.ssh,
    [...rig.sshBaseArgs, ...extraArgs, '--', rig.target, command],
    { timeoutMs },
  );
}

/** Run scp with the rig's coordinates. `args` are the file operands, in order. */
export function runScp(rig, args, { timeoutMs = 30_000, extraArgs = [] } = {}) {
  return runSync(rig.bins.scp, [...rig.scpBaseArgs, ...extraArgs, ...args], { timeoutMs });
}

/** Convenience: start a rig, run `fn(rig)`, always stop it. */
export async function withRig(fn, options = {}) {
  const rig = await startRig(options);
  try {
    return await fn(rig);
  } finally {
    await stopRig(rig);
  }
}

export { readLogTail };
