> This is the English version. The primary documentation is in Simplified Chinese: [README.md](./README.md).

# @junjiangao/dsh-plugin-remote-ssh

Model-facing SSH tools for the DeepSeek Harness. The bundle registers four Host
tools that let the agent run commands and move files on remote machines through
the **system OpenSSH CLI** (`ssh`, `scp`).

- **No npm dependencies.** The plugin imports only Node built-ins plus the two
  packages the harness already provides (`@deepseek-ai/dsh-tools` and
  `@deepseek-ai/schemastery`), which resolve from the dsh installation at runtime.
- **No host configuration required.** Any OpenSSH target works: an ssh_config
  alias (`MyOracleCloud`), `user@hostname`, or a bare hostname/IP. OpenSSH
  resolves aliases and keys itself.
- **Never interactive, never hanging.** Every invocation passes
  `BatchMode=yes` and `ConnectTimeout`, and every spawn has a hard timeout with
  a SIGTERM→SIGKILL escalation.

## Install

The bundle is installed into a profile with the plugin manager (the Lead or the
user owns this step):

```
plugin_manager install_bundle target=/work/Repos/github/dsh-plugin-remote-ssh
```

The manifest declares `dsh.bundle.patch`, so the install inserts this row into
the profile composition:

```yaml
- insert:
    - id: remote-ssh
      name: '@junjiangao/dsh-plugin-remote-ssh'
      config: {}
```

The row activates with `config: {}`: no hosts are pre-configured and all targets
are allowed. Replacing the package with a new build requires a harness restart
to load a fresh JavaScript module generation.

## Configuration

Add an override of the `remote-ssh` row in the profile's `cordis.patch.yml`
(a row override replaces the whole `config`, so restate every key you need):

```yaml
- id: remote-ssh
  config:
    connectTimeoutMs: 15000
    commandTimeoutMs: 120000
    maxOutputBytes: 262144
    strictHostKeyChecking: accept-new
    sshExecutable: ssh
    scpExecutable: scp
    allowedHosts: []
    hosts:
      - name: oracle
        hostname: 10.0.0.5
        user: ubuntu
        port: 22
        identityFile: ~/.ssh/oracle_ed25519
        proxyJump: bastion.example.com
        description: Oracle Cloud application host
        defaultCwd: /srv/app
        extraOptions:
          - -o
          - ServerAliveInterval=30
```

| Key | Default | Meaning |
| --- | --- | --- |
| `hosts` | `[]` | Pre-configured hosts addressable by `name`. Optional: raw OpenSSH targets work without any entry. |
| `connectTimeoutMs` | `15000` | Passed to OpenSSH as `-o ConnectTimeout=<ceil(ms/1000)>`. |
| `commandTimeoutMs` | `120000` | Default hard timeout for one command or transfer. |
| `maxOutputBytes` | `262144` | Cap per captured output stream; overflow sets `truncated`. |
| `strictHostKeyChecking` | `accept-new` | One of `accept-new`, `yes`, `no`. |
| `allowedHosts` | `[]` | Empty allows any target. Otherwise a target must match an entry exactly or through a simple `*` glob (for example `*.internal.example.com`). Both the `host` argument and the resolved `user@hostname` are matched. |
| `sshExecutable` | `ssh` | ssh binary name or path. |
| `scpExecutable` | `scp` | scp binary name or path. |

A configured `name` expands to `hostname`/`user`/`port`/`identityFile`/`proxyJump`/
`extraOptions`/`defaultCwd`. Anything else is handed to OpenSSH verbatim.

## Tools

### `ssh_hosts`

`{ check?: boolean }` — list the configured hosts. With `check: true` each host
is probed with a short non-interactive `true` command and reported with
`reachable`, `latencyMs`, and `error`. The result also reports the resolved ssh
executable path, the effective `allowedHosts`, and that raw OpenSSH targets are
accepted.

### `ssh_exec`

`{ host, command, cwd?, env?, timeoutMs?, pty?, stdin? }` — run one command on a
remote host. Returns
`{ host, target, exitCode, signal, stdout, stderr, durationMs, timedOut, truncated }`.

- `cwd` is `cd`-ed into first, then `env` entries are exported, then `command`
  runs — all in one remote script joined with `&&` and POSIX single-quote
  escaped.
- `env` keys must be valid POSIX names (`/^[A-Za-z_][A-Za-z0-9_]*$/`).
- `timeoutMs` overrides `commandTimeoutMs` for this call. On expiry the ssh
  process is killed (SIGTERM, then SIGKILL after ~2s) and the partial output is
  returned with `timedOut: true`.
- `pty: true` adds `-tt` for commands that need a terminal.
- `stdin` is forwarded to the remote command.

### `ssh_upload`

`{ host, localPath, remotePath, recursive?, timeoutMs? }` — `scp` a local file
or directory to the remote host. Returns
`{ host, localPath, remotePath, exitCode, stderr, durationMs }`.

### `ssh_download`

`{ host, remotePath, localPath, recursive?, timeoutMs? }` — `scp` a remote file
or directory to the local machine. Returns the same shape as `ssh_upload`.

Local paths are used as given (absolute, or relative to the harness process
working directory). Remote paths are passed to the remote side verbatim.

## Authentication model

The plugin never handles credentials. OpenSSH does:

- `BatchMode=yes` on every ssh/scp call, so a missing key fails immediately
  instead of prompting for a password.
- Key files and the ssh-agent are the only accepted mechanisms. `identityFile`
  adds `-i <path>` for a configured host.
- `StrictHostKeyChecking` defaults to `accept-new`: an unknown host key is
  accepted once and then pinned in `known_hosts`; a changed key still fails.
  Set it to `yes` for strict pre-provisioned hosts or `no` only for disposable
  test machines.
- `proxyJump` adds `-J` for bastion-routed hosts.

## Design note

The transport shells out to the system OpenSSH CLI rather than implementing the
protocol in JavaScript. That keeps the bundle dependency-free, reuses the user's
existing `~/.ssh/config`, keys, agent, `known_hosts`, and jump hosts, and keeps
authentication behaviour identical to what the user tests in a terminal. The
cost is one process per call; every process is bounded by a hard timeout, output
caps, and `BatchMode`.

All four tools are registered in `apply()` on `ctx.tools`, and every failure is
returned as a structured result (or a clear thrown message for argument,
permission, and configuration errors) — never as an unhandled rejection.

## Known limitations

- **A timed-out command may keep running on the remote host.** The hard timeout
  kills the local `ssh` client; it cannot stop the remote process, which
  OpenSSH already started in the remote session. `ssh_exec` reports
  `timedOut: true` and its rendered output says explicitly that only the local
  client was terminated, so re-check the remote host (process list, sentinel
  file, log) before assuming the command stopped. To bound remote work, make the
  command self-limiting, for example `timeout 30 <command>`.
- **`scp` operands beginning with `-`.** `ssh_upload` and `ssh_download` pass
  `--` before the operands — this OpenSSH `scp` accepts it as an end-of-options
  terminator — so a relative path such as `-draft.txt` is transferred as a path
  instead of being rejected as an unknown option. Remote paths are still passed
  to the remote side verbatim.
