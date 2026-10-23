# 测试 sshd 装置

`tests/rig` 提供一个**用完即弃的非特权 OpenSSH 服务器**，用于本插件的集成测试和
可选 E2E：验证 `ssh` 参数构造、主机密钥、已知主机、远端命令、helper 安装脚本和
OpenSSH 配置解析。它不读写用户 `~/.ssh`，不需要 root，也不占用固定端口。

它以当前用户身份运行，因此“远端”实际上就是本机文件系统；它验证的是 SSH 传输层
和远端命令语义，不代表另一台机器的发行版、权限或网络差异。

## 组成

| 文件 | 用途 |
| --- | --- |
| `lib.mjs` | `startRig()` / `stopRig()` / `withRig()` / `runSsh()` / `runScp()` |
| `start.mjs` | CLI：启动装置，打印一行 JSON，前台运行直到停止 |
| `stop.mjs` | CLI：根据 JSON 文件或 pid/端口停止装置 |
| `selftest.mjs` | 装置自证：`node --test tests/rig/selftest.mjs` |

每套装置在 `mkdtemp($TMPDIR/dsh-ssh-rig-XXXXXX)` 下生成：

- `hostkey` / `hostkey.pub`：sshd 主机密钥；
- `clientkey` / `clientkey.pub`：客户端密钥（公钥即 `authorized_keys`）；
- `authorized_keys`：权限 600；
- `sshd_config`：关闭 PAM、密码认证、root 登录，启用 `Subsystem sftp internal-sftp`；
- `sshd.log`、`sshd.pid`。

sshd 绑定 `127.0.0.1` 的临时高位端口，通过 `sshd -D -f <config> -E <log>` 前台运行。

## 在 node:test 中使用

```js
import { startRig, stopRig, runSsh } from './tests/rig/lib.mjs';

const rig = await startRig();
try {
  const result = runSsh(rig, 'printf RIG_OK');
  // result: { status, stdout, stderr, signal, timedOut }
} finally {
  await stopRig(rig); // 幂等：杀 sshd、等待端口关闭、删除临时目录
}
```

控制器集成测试的典型用法：

```js
const rig = await startRig();
const sshConfig = `Host rig-test\n  HostName 127.0.0.1\n  User ${rig.user}\n  Port ${rig.port}\n  IdentityFile ${rig.keyPath}\n`;
// 写入自己的临时 ssh_config，传给 RemoteSshController；
// 测试结束后 stopRig(rig) 并删除临时目录。
```

`rig` 暴露 `{ host, port, user, target, keyPath, dir, sshCommand, scpCommand,
sshBaseArgs, scpBaseArgs, bins, sshdPid, logPath, configPath, pidFile }`。

## 命令行

```sh
node tests/rig/start.mjs --json-file /tmp/rig.json
node tests/rig/stop.mjs --json-file /tmp/rig.json
node --test tests/rig/selftest.mjs
```

`start.mjs` 支持 `--port <n>`（固定非特权端口，不重试）、`--dir <path>`、`--quiet`。
`stop.mjs` 支持 `--pid <sshd-pid>`、`--dir <dir>`、`--port <n>` 或 JSON 文件。

## 保证与限制

- 从不读写 `~/.ssh`；客户端始终使用 `UserKnownHostsFile=/dev/null` 和
  `StrictHostKeyChecking=no`。
- 不需要 root，不绑定特权端口；`--port` 校验为 `[1024, 65535]`。
- 清理阶段总会杀 sshd、等待端口关闭并删除装置目录；`stopRig` 幂等。
- **非 root sshd 以当前用户登录**，远端路径就是本地路径；不要把它当作安全边界。
- 它覆盖真实 OpenSSH 握手、密钥认证、退出码、cwd/env 和 `scp`/SFTP；不覆盖
  `~/.ssh/config` 别名、ProxyJump 的真实网络路径或第三方主机差异。
- 当前集成测试：`tests/integration/controller.test.mjs`。
