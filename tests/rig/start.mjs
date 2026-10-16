#!/usr/bin/env node
/**
 * Start a hermetic, unprivileged sshd rig.
 *
 *   node tests/rig/start.mjs [--json-file <path>] [--port <n>] [--dir <path>] [--quiet]
 *
 * Prints exactly one JSON line on stdout with the connection coordinates, then
 * stays in the foreground until SIGTERM/SIGINT (or until sshd dies), at which
 * point it kills sshd and removes its temp directory.
 */

import { writeFile } from 'node:fs/promises';
import process from 'node:process';
import { startRig, stopRig } from './lib.mjs';

function parseArgs(argv) {
  const options = { quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json-file') options.jsonFile = argv[++i];
    else if (arg === '--port') options.port = Number(argv[++i]);
    else if (arg === '--dir') options.dir = argv[++i];
    else if (arg === '--quiet') options.quiet = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  process.stdout.write(
    'usage: node tests/rig/start.mjs [--json-file <path>] [--port <n>] [--dir <path>] [--quiet]\n',
  );
  process.exit(0);
}

if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535)) {
  process.stderr.write('start.mjs: --port must be an unprivileged port in [1024, 65535]\n');
  process.exit(2);
}

const rig = await startRig(options);

const coordinates = {
  port: rig.port,
  host: rig.host,
  user: rig.user,
  keyPath: rig.keyPath,
  dir: rig.dir,
  sshCommand: rig.sshCommand,
  scpCommand: rig.scpCommand,
  target: rig.target,
  sshdPid: rig.sshdPid,
  starterPid: process.pid,
  pidFile: rig.pidFile,
  logPath: rig.logPath,
  configPath: rig.configPath,
};

if (options.jsonFile) {
  await writeFile(options.jsonFile, `${JSON.stringify(coordinates, null, 2)}\n`);
}

process.stdout.write(`${JSON.stringify(coordinates)}\n`);

let shuttingDown = false;
async function shutdown(reason, exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (!options.quiet) process.stderr.write(`start.mjs: shutting down (${reason})\n`);
  try {
    await stopRig(rig);
  } catch (error) {
    process.stderr.write(`start.mjs: teardown error: ${error?.message ?? error}\n`);
    exitCode = exitCode || 1;
  }
  process.exit(exitCode);
}

process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
process.on('SIGINT', () => void shutdown('SIGINT', 0));

rig.child?.once('exit', (code, signal) => {
  void shutdown(`sshd exited code=${code} signal=${signal}`, code === 0 ? 0 : 1);
});

// Keep the event loop alive until a signal arrives.
await new Promise(() => {});
