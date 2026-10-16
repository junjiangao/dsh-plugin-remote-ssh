# @junjiangao/dsh-plugin-remote-ssh

> English version: [README.en.md](./README.en.md)

面向 DeepSeek Harness 的模型可用 SSH 工具。该 bundle 注册四个 Host 工具，让 agent
通过**系统 OpenSSH CLI**（`ssh`、`scp`）在远程主机上执行命令、传输文件。

- **零 npm 依赖。** 插件只导入 Node 内置模块，以及 harness 已提供的两个包
  （`@deepseek-ai/dsh-tools` 与 `@deepseek-ai/schemastery`），它们在运行时从 dsh
  安装目录解析。
- **无需预配置主机。** 任意 OpenSSH 目标都可用：ssh_config 别名
  （`MyOracleCloud`）、`user@hostname`，或裸主机名/IP。别名与密钥由 OpenSSH
  自行解析。
- **永不交互、永不挂起。** 每次调用都传入 `BatchMode=yes` 与 `ConnectTimeout`，
  每个子进程都有硬超时，并按 SIGTERM→SIGKILL 逐级终止。

## 安装

该 bundle 通过插件管理器安装到某个 profile（此步骤由 Lead 或用户执行）：

```
plugin_manager install_bundle target=/work/Repos/github/dsh-plugin-remote-ssh
```

清单声明了 `dsh.bundle.patch`，因此安装会把下面这一行插入 profile 组合：

```yaml
- insert:
    - id: remote-ssh
      name: '@junjiangao/dsh-plugin-remote-ssh'
      config: {}
```

该行以 `config: {}` 激活：不预配置任何主机，且允许所有目标。用新的构建替换该包后，
需要重启 harness 才能加载新的 JavaScript 模块代际。

## 配置

在 profile 的 `cordis.patch.yml` 中为 `remote-ssh` 行添加覆盖（行覆盖会替换整个
`config`，因此需要重新写全你用到的每个键）：

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

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `hosts` | `[]` | 可按 `name` 寻址的预配置主机。可选：不配置任何条目也能使用原始 OpenSSH 目标。 |
| `connectTimeoutMs` | `15000` | 以 `-o ConnectTimeout=<ceil(ms/1000)>` 传给 OpenSSH。 |
| `commandTimeoutMs` | `120000` | 单条命令或单次传输的默认硬超时。 |
| `maxOutputBytes` | `262144` | 每个输出流的捕获上限；超出时置 `truncated`。 |
| `strictHostKeyChecking` | `accept-new` | 取值之一：`accept-new`、`yes`、`no`。 |
| `allowedHosts` | `[]` | 为空表示允许任意目标。否则目标必须与某个条目精确匹配，或匹配简单 `*` 通配（例如 `*.internal.example.com`）。同时匹配 `host` 参数与解析后的 `user@hostname`。 |
| `sshExecutable` | `ssh` | ssh 可执行文件的名称或路径。 |
| `scpExecutable` | `scp` | scp 可执行文件的名称或路径。 |

已配置的 `name` 会展开为 `hostname`/`user`/`port`/`identityFile`/`proxyJump`/
`extraOptions`/`defaultCwd`；其余目标字符串原样交给 OpenSSH。

## 工具

### `ssh_hosts`

`{ check?: boolean }` —— 列出已配置的主机。当 `check: true` 时，会用一条简短的非交互
`true` 命令探测每台主机，并报告 `reachable`、`latencyMs` 与 `error`。结果中还会给出
解析后的 ssh 可执行文件路径、实际生效的 `allowedHosts`，以及接受原始 OpenSSH 目标。

### `ssh_exec`

`{ host, command, cwd?, env?, timeoutMs?, pty?, stdin? }` —— 在远程主机上执行一条
命令。返回
`{ host, target, exitCode, signal, stdout, stderr, durationMs, timedOut, truncated }`。

- 先 `cd` 到 `cwd`，再逐条导出 `env`，然后运行 `command` —— 全部在同一个远程脚本中
  用 `&&` 连接，并做 POSIX 单引号转义。
- `env` 的键必须是合法的 POSIX 名称（`/^[A-Za-z_][A-Za-z0-9_]*$/`）。
- `timeoutMs` 覆盖本次调用的 `commandTimeoutMs`。超时后 ssh 进程会被终止
  （先 SIGTERM，约 2 秒后 SIGKILL），并以 `timedOut: true` 返回部分输出。
- `pty: true` 会加上 `-tt`，供需要终端的命令使用。
- `stdin` 会转发给远程命令。

### `ssh_upload`

`{ host, localPath, remotePath, recursive?, timeoutMs? }` —— 用 `scp` 把本地文件或
目录传到远程主机。返回
`{ host, localPath, remotePath, exitCode, stderr, durationMs }`。

### `ssh_download`

`{ host, remotePath, localPath, recursive?, timeoutMs? }` —— 用 `scp` 把远程文件或
目录取回本机。返回结构与 `ssh_upload` 相同。

本地路径按原样使用（绝对路径，或相对于 harness 进程的工作目录）。远程路径原样传给
远端。

## 认证模型

插件从不处理凭据，一切交给 OpenSSH：

- 每次 ssh/scp 调用都带 `BatchMode=yes`，因此缺少密钥时会立即失败，而不是提示输入
  密码。
- 只接受密钥文件与 ssh-agent 两种方式。`identityFile` 会为已配置的主机加上
  `-i <path>`。
- `StrictHostKeyChecking` 默认为 `accept-new`：未知主机密钥会被接受一次并固定到
  `known_hosts`；密钥发生变化时仍然失败。对预先配置好的严格主机可设为 `yes`，仅在
  一次性测试机上设为 `no`。
- `proxyJump` 会为经跳板机的主机加上 `-J`。

## 设计说明

传输层通过 shell 调用系统 OpenSSH CLI，而不是用 JavaScript 实现协议。这样 bundle
无需依赖，复用用户现有的 `~/.ssh/config`、密钥、agent、`known_hosts` 与跳板机配置，
并使认证行为与用户在终端中的测试完全一致。代价是每次调用一个进程；每个进程都受硬
超时、输出上限与 `BatchMode` 约束。

四个工具都在 `apply()` 中注册到 `ctx.tools`；所有失败都以结构化结果返回（参数、
权限与配置错误则抛出清晰的错误消息）——绝不产生未处理的 rejection。

## 已知限制

- **超时的命令可能仍在远程主机上运行。** 硬超时只终止本地 `ssh` 客户端，无法停止
  OpenSSH 已在远程会话中启动的进程。`ssh_exec` 会报告 `timedOut: true`，其渲染输出
  会明确说明只终止了本地客户端；因此在假定命令已停止之前，请复查远程主机（进程
  列表、哨兵文件、日志）。若要限制远程耗时，请让命令自带时限，例如
  `timeout 30 <command>`。
- **以 `-` 开头的 `scp` 操作数。** `ssh_upload` 与 `ssh_download` 会在操作数之前传入
  `--`——本 OpenSSH `scp` 接受它作为选项结束符——因此像 `-draft.txt` 这样的相对路径
  会被当作路径传输，而不会被当成未知选项拒绝。远程路径仍原样传给远端。
