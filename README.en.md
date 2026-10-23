> This is the English version. The primary documentation is in Simplified Chinese: [README.md](./README.md).

# @junjiangao/dsh-plugin-remote-ssh

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Manage SSH hosts from the DeepSeek Harness Web UI sidebar and bring remote workspaces in two ways:

- **Independent remote window**: open an official `dsh-ssh`-backed window per host, where files, commands, and terminals run on the remote machine;
- **Mixed mode in the current window**: register a remote directory as a regular Workspace of the current desktop window, so local and remote sessions coexist; the plugin's execution router dispatches `fs`/`subprocess`/`sandbox` by path.

The plugin registers no model-facing tools. It owns host management and remote-window orchestration only; the actual SSH capability comes from the official providers:

- `@deepseek-ai/dsh-ssh`: one helper connection per host
- `@deepseek-ai/dsh-fs-ssh`: remote filesystem exposed as `fs`
- `@deepseek-ai/dsh-subprocess-ssh`: remote processes/terminals exposed as `subprocess`
- `@deepseek-ai/dsh-sandbox-ssh`: remote sandbox

## Features

- **Sidebar entry**: a **Remote SSH** entry appears in the Web/desktop sidebar and opens the host list in the main column.
- **Host sources**: hosts are imported read-only from `~/.ssh/config`; plugin-managed hosts can be added, edited, and deleted.
- **One form for add/edit**: alias, display name, HostName, User, Port, IdentityFile, ProxyJump, ProxyCommand, IdentitiesOnly, ForwardAgent, keepalive, StrictHostKeyChecking, UserKnownHostsFile, ConnectionAttempts, ConnectTimeout, arbitrary extra directives, remote workspace, and remote helper root.
- **Check first, then install**: opening a host checks SSH, remote platform, Node/npm, helper version, workspace, and the local runtime. A missing or mismatched helper opens a confirmation dialog showing the exact npm command before anything is installed.
- **Independent remote window**: each open starts a separate DSH Web instance (own profile, own port) using the official SSH providers, then opens its authenticated URL in a new browser tab.
- **Remote directory picker**: "Add workspace" inside the remote window lists directories on the SSH host instead of the local machine, and creates new directories there too.
- **Remote workspaces sidebar**: a second, read-only sidebar entry in the main UI groups every managed host's remote workspaces and sessions by remote machine + workspace, with open/stop controls.
- **Session deep links**: clicking a session in that panel opens its remote window and reveals the session, using a short-lived marker in the isolated home rather than a URL parameter.
- **Mixed mode**: **Open in this window** in the remote-workspaces panel registers the remote directory as an ordinary Workspace; Bash, file reads/writes, and listings in new sessions use the SSH world while local workspaces stay local.
- **No model tools**: no `ssh_exec` / `ssh_upload` registrations, so the plugin does not duplicate the official agent capability.

## Requirements

- DeepSeek Harness `>= 0.2.1-rc.2 < 0.3.0`, Node.js `^22.19.0 || >=24.0.0`.
- **Local**: Linux or macOS; OpenSSH client (`ssh`) and a `~/.ssh/config` that supports `Include` (OpenSSH 7.3+).
- **Remote**: Linux or macOS; `/bin/sh`; Node.js `^22.19.0 || >=24.0.0`; npm; a writable remote workspace.
- Remote helper installation needs npm registry access (or a configured mirror); the local runtime profile install also needs registry access.

Windows clients are not supported; the official `dsh-ssh` provider is POSIX-client only.

## Installation

### Through the plugin manager (recommended)

The manifest declares `dsh.bundle.patch`. To own local/remote execution, the patch first disables the base provider rows and then inserts one Host row:

```yaml
- id: subprocess
  disabled: true
- id: sandbox
  disabled: true
- id: fs-sandbox
  disabled: true

- insert:
    - id: remote-ssh
      name: '@junjiangao/dsh-plugin-remote-ssh'
      config: {}
```

The router re-provides those three services: the local world still mounts the official `dsh-fs-sandbox` / `dsh-subprocess-local` / `dsh-sandbox-local`, so local behaviour is unchanged; remote worlds mount the SSH providers on demand.

The row activates with an empty config; see [Configuration](#configuration) for all defaults. Restart the Harness Host or reload the profile to load the new Host module.

### Local development

Point the profile at the local directory and add the package to the bundle list:

```json
{
  "dependencies": {
    "@junjiangao/dsh-plugin-remote-ssh": "link:/absolute/path/to/dsh-plugin-remote-ssh"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@junjiangao/dsh-plugin-remote-ssh"]
    }
  }
}
```

Install dependencies in that profile and restart the Host. The plugin has a single peer dependency, `@deepseek-ai/schemastery`; everything else is a Node built-in or a Harness-provided capability.

## Quick start

1. Open the Harness Web UI and click **Remote SSH** in the left sidebar.
2. The list has two groups:
   - **Managed hosts**: written to `~/.dsh/remote-ssh/ssh_config`; editable and removable.
   - **From ~/.ssh/config**: read-only imports; use **Copy as managed** to edit a copy.
3. Click **Add host**, fill in at least an alias and a hostname, and save. A managed `Include` block appears at the top of `~/.ssh/config`.
4. Use **Test** to verify SSH connectivity, then **Open** to start the preparation flow.
5. On first open, if the remote helper is missing, a confirmation dialog shows the npm command; after confirmation the plugin installs the helper, prepares the local runtime, and starts the window.
6. Once running, **Open window** opens the remote workspace in a new tab; **Stop** terminates that host's instance.
7. The **Remote workspaces** sidebar entry aggregates remote workspaces and sessions by remote machine + workspace; clicking a session opens its window and reveals that session.
8. To use local and remote workspaces in the same window, click **Open in this window** in that panel; see [Mixed mode](#mixed-mode-in-the-current-window).

Only one remote window instance is kept per host. Clicking **Open** again reuses the running instance. Inside the remote window, **Add workspace** browses the remote filesystem; after a new directory is selected, the plugin creates a same-path empty local directory when `mirrorWorkspace` is enabled so workspace realpath validation can succeed.

## Storage and ssh_config

| Path | Contents |
| --- | --- |
| `~/.dsh/remote-ssh/hosts.json` | Plugin-managed host records (0600) |
| `~/.dsh/remote-ssh/ssh_config` | Generated OpenSSH fragment; do not edit by hand |
| `~/.dsh/remote-ssh/instances/<id>.yml` | Per-host Loader overlay written for each open |
| `~/.dsh/remote-ssh/instances/<id>.pid` | Running remote-window process record used for crash recovery |
| `~/.dsh/remote-ssh/homes/<host-id>/` | Isolated DSH home per host; inherits credential/settings files and seeds a workspace pointing at the remote path |
| `~/.dsh/remote-ssh/homes/<host-id>/storages/pending-session.json` | Short-lived session marker written when a panel session is clicked (0600, 5-minute TTL, claimed and deleted by the remote window) |
| `~/.dsh/remote-ssh/mixed/workspaces.json` | Mixed-mode registry: host, remote path, and local mirror path (0600) |
| `~/.dsh/remote-ssh/mixed/mounts/<host-id>/` | Local mirror directories used only for Workspace realpath; no remote files are copied |
| `~/.dsh/remote-ssh/mixed/runtime/<version>/tree/` | Private module tree (official local providers + SSH packages) that keeps module identity consistent |
| `~/.ssh/config` | Managed `Include` block at the top; the first edit is backed up as `config.dsh-remote-ssh.bak` |
| `~/.dsh/profiles/dsh-remote` | Local remote-runtime profile prepared by the plugin |

The generated block looks like this (`Include` points at the managed fragment):

```sshconfig
# BEGIN dsh-plugin-remote-ssh (managed; do not edit)
Include /home/me/.dsh/remote-ssh/ssh_config
# END dsh-plugin-remote-ssh
```

Managed hosts default to `StrictHostKeyChecking yes`. The first connection is bootstrapped with `accept-new` so the host key lands in `known_hosts`; the official provider then uses strict checking. Per host, this can be changed to `accept-new` or `no`.

Deleting all managed hosts keeps the `Include` block pointing at an empty fragment. This is intentional and avoids rewriting the user's config repeatedly.

## Configuration

Override by row id in the profile's `cordis.patch.yml`. **A row override replaces the whole `config` object**, so you may list only the keys you need and let the rest fall back to `Config` defaults; restate old values if you depend on them.

```yaml
- id: remote-ssh
  config:
    profileName: dsh-remote
    inheritDesktopSettings: true
    sshPackageVersion: 0.2.1-rc.2
    remoteNode: /usr/bin/node
```

| Key | Default | Description |
| --- | --- | --- |
| `sshExecutable` | `ssh` | OpenSSH client used for bootstrap and diagnostics |
| `sshConfigPath` | `~/.ssh/config` | User config read for hosts and maintained with the managed `Include` |
| `dataDir` | `~/.dsh/remote-ssh` | Plugin data directory |
| `profileName` | `dsh-remote` | Local runtime profile prepared and started for remote windows |
| `sshPackageVersion` | running DSH version | Official SSH package version; empty uses the running Harness version |
| `helperPackage` | `@deepseek-ai/dsh-ssh` | npm package installed on the remote for the helper |
| `helperRoot` | `~/.dsh-remote-ssh/helper` | Remote parent directory; one subdirectory per version |
| `npmRegistry` | unset | npm registry used for remote helper installation |
| `remoteNode` | auto-discovered | Absolute remote Node path; checks SSH PATH first, then common fnm/nvm/volta locations |
| `connectTimeoutMs` | `15000` | Per-connection SSH timeout |
| `commandTimeoutMs` | `30000` | Per-diagnostic remote command timeout |
| `installTimeoutMs` | `600000` | Remote helper or local runtime installation timeout |
| `openTimeoutMs` | `90000` | Deadline for the remote window to print its URL |
| `inheritDesktopSettings` | `true` | Apply the desktop profile user patch to the remote window (models/UI settings) |
| `mirrorWorkspace` | `true` | Create a same-path empty directory locally to satisfy workspace realpath checks |
| `permissionMode` | `workspace-write` | Sandbox mode: `workspace-write` / `read-only` / `danger-full-access` |

Per-host fields are stored in `hosts.json` and written to `ssh_config`:

`alias`, `displayName`, `description`, `hostname`, `user`, `port`, `identityFile`, `proxyJump`, `proxyCommand`, `identitiesOnly`, `forwardAgent`, `serverAliveInterval`, `serverAliveCountMax`, `strictHostKeyChecking`, `userKnownHostsFile`, `connectionAttempts`, `connectTimeout`, `extraOptions`, `remoteWorkspace`, `remoteHelperRoot`.

`extraOptions` rejects `Host`, `Match`, and `Include`, and rejects duplicate directives.

## Open flow

`openHost` runs on the Host and writes its phase back into the snapshot for the panel to poll:

1. `checking`: `doctor` checks SSH, remote platform, Node/npm, helper version, workspace, host key, and the local profile.
2. `installing-helper`: if the helper is missing or mismatched and the caller passed `allowInstall: true`, install it over npm and compute the entry-point sha256. The absolute npm discovered by doctor is preferred, and the Node directory is added to PATH for the install command (so fnm/nvm installations outside the non-interactive SSH PATH work too).
3. `preparing-runtime`: prepare the local `dsh-remote` profile (first run installs the four official SSH packages).
4. `starting`: prepare an isolated DSH home (linked profile, inherited credentials/settings, one remote workspace record), then start an independent Web instance with this host's overlay and wait for `dsh web: http://127.0.0.1:<port>/?<token>`. The overlay also mounts the remote directory picker and the session-deeplink plugin.
5. `running`: the URL is available; `openUrl` returns it and the panel calls `window.open`.
6. `failed` / `stopping` / `idle`: failure, stopping, and idle states.

Before start the plugin prepares an isolated DSH home: the prepared profile is linked in, `.credentials.yaml`, `.env`, `settings.yaml`, and `AGENTS.md` are inherited, and one workspace record points at the remote workspace. The remote window therefore does not reuse the desktop's local projects/sessions, and its default workspace is the remote directory. The overlay disables local `subprocess`, `sandbox`, and `fs-sandbox`, inserts the four official SSH rows, and points `sandbox-policy.workspaceRoot` at the remote workspace. It also replaces the shipped local `@file` scanner with a small provider that follows the mounted SSH filesystem, replaces the default `directory-picker` (which opens a native local folder dialog on desktop) with the plugin's remote browse backend, and mounts a small session-deeplink plugin that claims the pending session posted by the main UI. The official provider is a singleton: **one remote window serves one host**, so each host gets its own instance and overlay.

## Mixed mode in the current window

Besides independent remote windows, the plugin can place a remote directory directly in the **current** desktop window:

1. Open the **Remote workspaces** sidebar entry and click **Open in this window** on a host or one of its remote workspaces.
2. The plugin checks the host, expands `~`, confirms the remote directory is writable, verifies the helper and the `dsh-remote` profile, and creates the local mirror directory `~/.dsh/remote-ssh/mixed/mounts/<host-id>/<name>-<hash>` when needed.
3. The panel registers that mirror path through the ordinary Workspace API and navigates to it; new sessions use the mirror path as their cwd.
4. Bash, file reads/writes, and listings in those sessions are routed to that host's SSH world; sessions in local workspaces keep using the local world.

Routing priority: mounted mirror prefix → the current tool session's remote environment (the session cwd from `tools/execute`) → the cwd mount → local. Inside a remote session, absolute paths such as `/etc/hostname` are interpreted remotely and never read local files.

**Note**: mixed mode owns only `fs`, `subprocess`, and `sandbox`. Content search still uses the bundled local ripgrep (the mirror has no remote files), and `@` candidates, LSP, open-in-app, and spill keep their local implementations; use an independent remote window when you need full remote semantics.

The registry lives at `~/.dsh/remote-ssh/mixed/workspaces.json`; the `removeMixedWorkspace` RPC removes a registration and disconnects that host world, but does not delete the ordinary Workspace record.


## Security

- No SSH passwords or tokens are stored in `hosts.json`, `ssh_config`, overlays, or logs; authentication is left to OpenSSH (keys, agent, ProxyCommand).
- `ssh`/`scp` are not composed through a local shell; arguments are passed as argv. Remote commands use an explicit `/bin/sh -c`.
- The browser reaches the Host through Harness Connection's authenticated Fetch channel with one exact route per endpoint.
- The remote window URL token is only returned by `openUrl`; instance logs and error details are redacted before reaching the browser.
- `hosts.json`, the generated `ssh_config`, overlays, and pid records are written with mode 0600; `~/.ssh/config` is backed up before its first edit.
- The official provider launches the helper with `BatchMode=yes`, `StrictHostKeyChecking=yes`, `ForwardAgent=no`, and `ClearAllForwardings=yes`; the plugin does not bypass these.

## Known limitations

- **One host per remote window**: the official `dsh-ssh` provider is a singleton per composition, so a window cannot switch hosts.
- **Not full VS Code Remote**: `@` file references and the directory picker now use the remote filesystem, but workspace changes, open-in-app, spill, and skill filesystem still use local workspace semantics and may be unavailable or inconsistent. A same-path local mirror mitigates workspace realpath validation.
- **PTC unavailable**: the node-script helper has no executable bootstrap, so the overlay disables `ptc-runtime` and `workflow-ptc`.
- **Globs/grep**: remote `glob`/`grep` may rely on remote ripgrep; without it the tools can fail or fall back.
- **No file watching**: remote file changes are not pushed through local fs watch.
- **Port/agent forwarding**: the official provider fixes `ClearAllForwardings=yes` and `ForwardAgent=no`; use `ProxyCommand` / `ProxyJump` in `~/.ssh/config` when forwarding is required.
- **Helper install needs npm and network**: npm 12 warns that install scripts are blocked, but `node-pty` ships prebuilds, so the helper normally still works. Node/npm managed by fnm, nvm, or volta is auto-discovered from common locations; `remoteNode` can pin an absolute path.
- **Local mirror side effect**: `mirrorWorkspace: true` creates a same-path local directory (directories only, never files); if the remote path cannot be created locally (such as `/root`), adding the workspace fails instead of registering a non-existent path.
- **Session deep links are best effort**: the marker expires after 5 minutes and is consumed on read; a deleted session or a slow client only opens the window without revealing a session, and a missing helper surfaces the usual failure/install hint.
- **Mixed mode does not cover every subsystem**: only `fs`/`subprocess`/`sandbox` are routed; search uses local ripgrep, `@` candidates scan the local mirror, and LSP/open-in-app/spill stay local. Use an independent remote window for full remote semantics.
- **Mixed-mode cwd is the mirror path**: the model sees the local mirror path as its working directory; absolute remote paths still work inside the same session, but the two namespaces coexist and must be distinguished when debugging.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| No **Remote SSH** in the sidebar | Ensure the bundle is in the profile and the Host restarted; hard-refresh the browser assets |
| Imported list is empty | Check `~/.ssh/config` for wildcard hosts (not imported) and whether `ssh -G <alias>` succeeds |
| Saving a host fails | Check for duplicate aliases and invalid ports/paths; the Host rolls back and keeps the previous files |
| Connection test fails | Run `ssh -v <alias>` in a terminal; check the proxy used by `ProxyCommand` |
| Helper is reported missing | Verify remote Node/npm and registry access; fnm/nvm/volta installations are auto-discovered, otherwise set `remoteNode` or run the dialog command manually |
| Window start times out | Open **Details** for the log tail; common causes are a crashing remote helper, inactive SSH rows, or host-key verification |
| Window opens but files/terminals fail | Check that the remote workspace is writable and whether `ssh`, `fs-ssh`, or `subprocess-ssh` are pending or failing in the log; the workspace should show the remote path, not `default-workspace` |
| Strict host-key verification fails | Let the plugin bootstrap with `accept-new` first, or run `ssh <alias>` manually to populate known_hosts |

## Development and verification

```bash
npm test                 # unit tests + sshd-rig integration tests
npm run verify:static    # bundle manifest/structure/syntax
npm run verify:client    # client contract and locale consistency
npm run verify:docs      # README/architecture consistency
npm run verify:e2e       # end-to-end orchestration with test fixtures
node verification/live-e2e.mjs --alias <alias> --version 0.2.1-rc.2  # optional: full flow against a real SSH host
node verification/live-remote-window.mjs --alias <alias> --version 0.2.1-rc.2  # optional: real remote-window UI (picker + session deeplink + reused window)
```

See [docs/architecture.md](./docs/architecture.md) for implementation details and [tests/rig/README.md](./tests/rig/README.md) for the test fixture.

## License

Released under the [MIT](./LICENSE) license, copyright junjiangao.