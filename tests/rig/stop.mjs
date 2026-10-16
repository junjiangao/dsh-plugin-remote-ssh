#!/usr/bin/env node
/**
 * Stop a rig started by start.mjs.
 *
 *   node tests/rig/stop.mjs --json-file <path>
 *   node tests/rig/stop.mjs --pid <sshd-pid> [--dir <rig-dir>] [--port <n>]
 *   node tests/rig/stop.mjs <json-file>
 *
 * Sends SIGTERM to the start.mjs supervisor (which tears down its own sshd and
 * temp dir), then makes sure sshd is gone, the port is closed and the temp dir
 * is removed. Safe to run twice.
 */

import { readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import process from 'node:process';
import { isAlive, isPortListening, sleep } from './lib.mjs';

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json-file') options.jsonFile = argv[++i];
    else if (arg === '--pid') options.pid = Number(argv[++i]);
    else if (arg === '--dir') options.dir = argv[++i];
    else if (arg === '--port') options.port = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (!arg.startsWith('-') && !options.jsonFile) options.jsonFile = arg;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  process.stdout.write(
    'usage: node tests/rig/stop.mjs --json-file <path> | --pid <sshd-pid> [--dir <dir>] [--port <n>]\n',
  );
  process.exit(0);
}

let coordinates = {};
if (options.jsonFile) {
  if (!existsSync(options.jsonFile)) {
    process.stderr.write(`stop.mjs: json file not found: ${options.jsonFile}\n`);
    process.exit(2);
  }
  coordinates = JSON.parse(await readFile(options.jsonFile, 'utf8'));
}

const starterPid = coordinates.starterPid;
const sshdPid = options.pid ?? coordinates.sshdPid;
const dir = options.dir ?? coordinates.dir;
const port = options.port ?? coordinates.port;
const host = coordinates.host ?? '127.0.0.1';

const killAndWait = async (pid, signal, timeoutMs) => {
  if (!pid || !isAlive(pid)) return true;
  try {
    process.kill(pid, signal);
  } catch {
    return true;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(50);
  }
  return !isAlive(pid);
};

// The supervisor owns teardown; ask it first so it can run its own cleanup.
if (starterPid && isAlive(starterPid)) {
  await killAndWait(starterPid, 'SIGTERM', 6_000);
  if (isAlive(starterPid)) await killAndWait(starterPid, 'SIGKILL', 2_000);
}

// Fallback / belt-and-braces: make sure sshd itself is gone.
if (sshdPid && isAlive(sshdPid)) {
  await killAndWait(sshdPid, 'SIGTERM', 3_000);
  if (isAlive(sshdPid)) await killAndWait(sshdPid, 'SIGKILL', 2_000);
}

if (port) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && (await isPortListening(port, host, 150))) await sleep(50);
}

if (dir && existsSync(dir)) await rm(dir, { recursive: true, force: true });

const listening = port ? await isPortListening(port, host, 300) : false;
const report = {
  stopped: !listening && !isAlive(sshdPid) && !isAlive(starterPid),
  sshdPid,
  starterPid,
  port,
  portStillListening: listening,
  dir,
  dirStillExists: Boolean(dir && existsSync(dir)),
};
process.stdout.write(`${JSON.stringify(report)}\n`);

if (!report.stopped || report.portStillListening || report.dirStillExists) process.exit(1);
