# 封闭式非特权 sshd 测试装置

一个用完即弃的 OpenSSH 服务器，用于测试基于 SSH 的代码：不触碰用户的 `~/.ssh`、
不需要 root，也不占用固定端口。

- `lib.mjs` —— `startRig()` / `stopRig()` / `withRig()` 辅助函数（仅使用 Node 内置模块）。
- `start.mjs` —— CLI：启动一套装置，打印一行 JSON，并保持在前台运行。
- `stop.mjs` —— CLI：停止由 `start.mjs` 启动的装置。
- `selftest.mjs` —— 证明装置可用：`node --test tests/rig/selftest.mjs`。

## 工作原理

每套装置都会通过 `mkdtemp($TMPDIR/dsh-ssh-rig-XXXXXX)` 获得自己的目录，其中包含：

| 文件 | 用途 |
| --- | --- |
| `hostkey`、`hostkey.pub` | sshd 主机密钥（`ssh-keygen -t ed25519`） |
| `clientkey`、`clientkey.pub` | 客户端密钥；公钥部分即该装置的 `authorized_keys` |
| `authorized_keys` | `AuthorizedKeysFile`，权限 600 |
| `sshd_config` | 私有配置（见下文） |
| `sshd.log` | sshd 日志（`-E`），包含 `Server listening on 127.0.0.1 port <port>.` |
| `sshd.pid` | `PidFile` |

sshd **以当前用户身份**（`id -un`）在前台运行（`sshd -D -f <config> -E <log>`），
监听绑定到 `127.0.0.1` 的临时高位端口。该配置关闭 PAM、密码认证、root 登录与
严格模式检查，并启用 `Subsystem sftp internal-sftp`，以便 `scp`（在 OpenSSH ≥ 9 上
默认使用 SFTP 协议）可以工作。空闲端口通过把临时 TCP 服务器绑定到端口 0 再关闭来
获取；若地址已被占用，启动时会换一个新端口重试。

## 在 shell 中启动 / 停止

```sh
node tests/rig/start.mjs --json-file /tmp/rig.json
# stdout: one JSON line, e.g.
# {"port":34907,"host":"127.0.0.1","user":"you","keyPath":"/tmp/dsh-ssh-rig-XXXX/clientkey",
#  "dir":"/tmp/dsh-ssh-rig-XXXX","sshCommand":"...","scpCommand":"...", ...}
# stays in the foreground until SIGTERM/SIGINT, then kills sshd and rm -rf's the dir

node tests/rig/stop.mjs --json-file /tmp/rig.json
# {"stopped":true,...,"portStillListening":false,"dirStillExists":false}
```

`start.mjs` 还接受 `--port <n>`（固定非特权端口，不重试）、`--dir <path>` 与
`--quiet`。`stop.mjs` 还接受 `--pid <sshd-pid> [--dir <dir>] [--port <n>]`，或直接给出
JSON 文件路径。

## 在 `node:test` / 其他 Node 代码中使用

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

`rig` 暴露 `{ host, port, user, target, keyPath, dir, sshCommand, scpCommand,
sshBaseArgs, scpBaseArgs, bins, sshdPid, logPath, configPath, pidFile, stop(), cleanup() }`。

## 装置接受的准确命令行

`rig.sshCommand` 是可直接使用的 ssh 前缀（即远程命令之前的全部内容）：

```
/usr/bin/ssh -i <rig>/clientkey -p <port> \
  -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -- <user>@127.0.0.1
```

因此一次完整调用是：

```sh
/usr/bin/ssh -i /tmp/dsh-ssh-rig-XXXX/clientkey -p 34907 \
  -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -- "$(id -un)@127.0.0.1" 'echo RIG_OK'
```

与之对应的 scp 前缀（端口用 `-P`，不带 target）：

```sh
/usr/bin/scp -i /tmp/dsh-ssh-rig-XXXX/clientkey -P 34907 \
  -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  <local> "$(id -un)@127.0.0.1:<remote>"
```

`-r` 可用于目录。存在时，`/usr/bin/ssh` 等会被解析为绝对路径；可用 `sshBin` /
`scpBin` / `sshdBin` / `sshKeygenBin` 选项覆盖。

## 保证与限制

- 从不读写 `~/.ssh`；客户端始终传入 `UserKnownHostsFile=/dev/null` 与
  `StrictHostKeyChecking=no`。
- 从不需要 root，也从不绑定特权端口（`--port` 会被校验为 `[1024, 65535]`）。
- 清理阶段总会杀掉 sshd、等待端口关闭并删除装置目录；`stopRig` 是幂等的，而
  `withRig` / 自测会在 `finally` 块中清理。
- **非 root 的 sshd 会让客户端以当前用户身份登录**，因此装置的远端就是本地文件
  系统。远程路径就是普通的本地路径；这正是 `scp` 往返内容可以逐字节比较的原因。
  它并不是安全边界。
- 该装置是*传输层*的测试替身：它演练真实的 OpenSSH 握手、密钥认证、`scp`/SFTP 与
  退出码传递。它并不说明通过 `~/.ssh/config` 别名或 `ProxyJump` 抵达的主机的情况。
