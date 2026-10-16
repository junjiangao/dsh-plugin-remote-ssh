# Hermetic unprivileged sshd rig

A throwaway OpenSSH server for testing SSH-based code without touching the user's
`~/.ssh`, without root, and without a fixed port.

- `lib.mjs` — `startRig()` / `stopRig()` / `withRig()` helpers (Node builtins only).
- `start.mjs` — CLI: start a rig, print one JSON line, stay in the foreground.
- `stop.mjs` — CLI: stop a rig started by `start.mjs`.
- `selftest.mjs` — proves the rig works: `node --test tests/rig/selftest.mjs`.

## How it works

Each rig gets its own directory from `mkdtemp($TMPDIR/dsh-ssh-rig-XXXXXX)` containing:

| file | purpose |
| --- | --- |
| `hostkey`, `hostkey.pub` | sshd host key (`ssh-keygen -t ed25519`) |
| `clientkey`, `clientkey.pub` | client key; public half is the rig's `authorized_keys` |
| `authorized_keys` | `AuthorizedKeysFile`, mode 600 |
| `sshd_config` | private config (see below) |
| `sshd.log` | sshd log (`-E`), contains `Server listening on 127.0.0.1 port <port>.` |
| `sshd.pid` | `PidFile` |

sshd runs **as the current user** (`id -un`) in the foreground (`sshd -D -f <config> -E <log>`)
on an ephemeral high port bound to `127.0.0.1`. The config disables PAM, password
auth, root login and strict modes, and enables `Subsystem sftp internal-sftp` so that
`scp` (which speaks SFTP by default on OpenSSH ≥ 9) works. The free port is found by
binding a temporary TCP server to port 0 and closing it; startup retries on a fresh
port if the address is taken.

## Start / stop from a shell

```sh
node tests/rig/start.mjs --json-file /tmp/rig.json
# stdout: one JSON line, e.g.
# {"port":34907,"host":"127.0.0.1","user":"you","keyPath":"/tmp/dsh-ssh-rig-XXXX/clientkey",
#  "dir":"/tmp/dsh-ssh-rig-XXXX","sshCommand":"...","scpCommand":"...", ...}
# stays in the foreground until SIGTERM/SIGINT, then kills sshd and rm -rf's the dir

node tests/rig/stop.mjs --json-file /tmp/rig.json
# {"stopped":true,...,"portStillListening":false,"dirStillExists":false}
```

`start.mjs` also accepts `--port <n>` (fixed unprivileged port, no retry), `--dir <path>`
and `--quiet`. `stop.mjs` also accepts `--pid <sshd-pid> [--dir <dir>] [--port <n>]`, or a
bare JSON-file path.

## From `node:test` / other Node code

```js
import { startRig, stopRig, runSsh, runScp } from './tests/rig/lib.mjs';

const rig = await startRig();          // or withRig(async (rig) => { ... })
try {
  runSsh(rig, 'echo RIG_OK');          // { status, stdout, stderr, signal, timedOut }
  runScp(rig, [localFile, `${rig.target}:${remoteFile}`]);
} finally {
  await stopRig(rig);                  // idempotent; kills sshd, closes port, rm -rf dir
}
```

`rig` exposes `{ host, port, user, target, keyPath, dir, sshCommand, scpCommand,
sshBaseArgs, scpBaseArgs, bins, sshdPid, logPath, configPath, pidFile, stop(), cleanup() }`.

## The exact command line the rig accepts

`rig.sshCommand` is the ready-to-use ssh prefix (everything before the remote command):

```
/usr/bin/ssh -i <rig>/clientkey -p <port> \
  -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -- <user>@127.0.0.1
```

so a full invocation is:

```sh
/usr/bin/ssh -i /tmp/dsh-ssh-rig-XXXX/clientkey -p 34907 \
  -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -- "$(id -un)@127.0.0.1" 'echo RIG_OK'
```

and the matching scp prefix (`-P` for the port, no target):

```sh
/usr/bin/scp -i /tmp/dsh-ssh-rig-XXXX/clientkey -P 34907 \
  -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  <local> "$(id -un)@127.0.0.1:<remote>"
```

`-r` works for directories. `/usr/bin/ssh` etc. are resolved to absolute paths when
present; override with `sshBin` / `scpBin` / `sshdBin` / `sshKeygenBin` options.

## Guarantees and limits

- Never reads or writes `~/.ssh`; clients always pass `UserKnownHostsFile=/dev/null`
  and `StrictHostKeyChecking=no`.
- Never requires root and never binds a privileged port (`--port` is validated to
  `[1024, 65535]`).
- Teardown always kills sshd, waits for the port to close and removes the rig dir;
  `stopRig` is idempotent and `withRig`/the self-test clean up in `finally` blocks.
- **Non-root sshd logs the client in as the current user**, so the rig's remote side
  is the local filesystem. Remote paths are ordinary local paths; that is what makes
  `scp` round-trips byte-comparable. It is not a security boundary.
- The rig is a test double for the *transport*: it exercises real OpenSSH handshakes,
  key auth, `scp`/SFTP and exit-code propagation. It says nothing about hosts reached
  through `~/.ssh/config` aliases or `ProxyJump`.
