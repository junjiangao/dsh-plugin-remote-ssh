# @junjiangao/dsh-plugin-remote-ssh

> English version: [README.en.md](./README.en.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

在 DeepSeek Harness Web UI 左侧栏管理 SSH 主机，并把远端工作区以两种方式接入：

- **独立远端窗口**：每台主机可打开一个基于官方 `dsh-ssh` 的远端工作窗口，文件、命令和终端都跑在远端；
- **同一窗口混合模式**：不新开窗口，直接把远端目录登记为当前桌面窗口的一个 Workspace，本地会话与远端会话同时存在（由插件内置的执行路由器按路径分派 `fs`/`subprocess`/`sandbox`）。

这个插件不再注册任何模型工具。它只负责“主机管理 + 远端窗口编排”，真正的 SSH 能力由官方 provider 家族提供：

- `@deepseek-ai/dsh-ssh`：每台主机一个 helper 连接
- `@deepseek-ai/dsh-fs-ssh`：把远端文件系统接成 `fs`
- `@deepseek-ai/dsh-subprocess-ssh`：把远端进程/终端接成 `subprocess`
- `@deepseek-ai/dsh-sandbox-ssh`：远端沙箱

## 功能

- **侧栏入口**：Web/桌面端左侧栏出现「远程 SSH」，主区展示主机列表。
- **主机来源**：默认读取 `~/.ssh/config`，导入的条目只读；插件自己托管的主机可添加、编辑、删除。
- **添加/编辑共用一个表单**：别名、显示名、HostName、User、Port、IdentityFile、ProxyJump、ProxyCommand、IdentitiesOnly、ForwardAgent、KeepAlive、StrictHostKeyChecking、UserKnownHostsFile、ConnectionAttempts、ConnectTimeout、任意额外指令、远端工作目录、远端 helper 目录。
- **先检查再安装**：打开主机前检查 SSH、远端平台、Node/npm、helper、工作目录和本地 runtime；helper 缺失或版本不匹配时先弹出确认对话框，确认后才在远端执行 npm 安装。
- **独立远端窗口**：每次打开使用官方 SSH provider 启动一个独立的 DSH Web 实例（独立 profile、独立端口、隔离的 DSH home），在浏览器新标签页打开带鉴权的 URL。
- **远端工作区与 `@` 文件**：远端窗口不再显示本机项目列表，默认工作区直接指向远端路径；`@` 文件候选由插件通过官方 `fs-ssh` 读取远端目录，而不是扫描本机。
- **远端目录选择器**：远程窗口里点「添加工作区」浏览的是 SSH 主机上的目录，而不是本机文件夹；新建目录也在远端执行。
- **「远程工作区」侧栏**：主界面侧栏新增一个只读聚合面板，按「远程机 + 工作区」列出各主机隔离 home 中的远端工作区与会话，可直接打开/停止窗口。
- **会话深链**：在「远程工作区」面板点某个会话，会打开对应远端窗口并直接定位到该会话（基于隔离 home 中的短期标记，不依赖 URL 参数）。
- **同窗口混合模式**：「远程工作区」面板的「在此窗口打开」把远端目录登记为普通 Workspace；新会话的 Bash、读写文件、列目录走 SSH 世界，本地 Workspace 不受影响。
- **不使用模型工具**：不向 `ctx.tools` 注册 `ssh_exec` / `ssh_upload` 等工具，避免和官方 agent 能力重复。

## 系统要求

- DeepSeek Harness `>= 0.2.1-rc.2 < 0.3.0`，Node.js `^22.19.0 || >=24.0.0`。
- **本机**：Linux 或 macOS；OpenSSH 客户端（`ssh`），且 `~/.ssh/config` 支持 `Include`（OpenSSH 7.3+）。
- **远端**：Linux 或 macOS；`/bin/sh`；Node.js `^22.19.0 || >=24.0.0`；npm；可写的远端工作目录。
- 远端 helper 安装需要访问 npm registry（或配置镜像）；本机 runtime profile 安装需要访问 npm registry。

Windows 客户端暂不支持（官方 `dsh-ssh` provider 只面向 POSIX 客户端）。

## 安装

### 通过插件管理器（推荐）

插件清单声明了 `dsh.bundle.patch`。为了接管本地/远端执行，补丁先禁用基础 provider 行，再插入一个 Host 行：

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

被禁用的三行由插件的执行路由器重新提供：本地世界仍挂载官方 `dsh-fs-sandbox` / `dsh-subprocess-local` / `dsh-sandbox-local`，因此本地行为不变；远端世界按需挂载 SSH provider。

该行以空配置激活，全部默认值见[配置项](#配置项)。安装/启用后需要重启 Harness Host 或重新加载 profile 才能加载新的 Host 模块。

### 本地开发

在 profile 的 `package.json` 中把包指向本地目录，并加入 bundle 列表：

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

然后在该 profile 中安装依赖并重启 Host。插件自身只有 `@deepseek-ai/schemastery` 一个 peer 依赖，其余 Node 内置模块和 Harness 提供的能力不需要额外安装。

## 快速使用

1. 重启后打开 Harness Web UI，点击左侧栏「远程 SSH」。
2. 列表分为两组：
   - **托管主机**：插件写入 `~/.dsh/remote-ssh/ssh_config` 的主机，可编辑/删除。
   - **来自 ~/.ssh/config**：只读导入条目，可「复制为托管」后再改。
3. 点击「添加主机」，填写别名和主机名即可保存；`~/.ssh/config` 顶部会自动出现一个受管理的 `Include` 块。
4. 点击某台主机的「测试」验证 SSH 连通性；点击「打开」进入准备流程。
5. 首次打开时如果远端没有匹配版本的 helper，会先显示安装确认和将要执行的 npm 命令；确认后等待安装、runtime 准备和窗口启动。
6. 窗口启动后点击「打开窗口」在浏览器新标签页打开远程工作区；「停止」结束该主机的实例。
7. 侧栏「远程工作区」按「远程机 + 工作区」汇总已打开的远端工作区与会话；点击会话会自动打开对应窗口并定位到该会话。
8. 想在当前窗口同时使用本地和远端时，在「远程工作区」点「在此窗口打开」，详见[混合模式](#混合模式同一窗口)。

同一台主机同时只保留一个远端窗口实例。重复点击「打开」会复用已运行的实例。在远程窗口内点「添加工作区」时，目录浏览器读取的是远端文件系统；首次选择新目录后，插件会按 `mirrorWorkspace` 在本机创建同路径空目录以通过工作区 realpath 校验。

## 存储与 ssh_config

| 路径 | 内容 |
| --- | --- |
| `~/.dsh/remote-ssh/hosts.json` | 插件托管的 host 记录（0600） |
| `~/.dsh/remote-ssh/ssh_config` | 由 host 记录生成的 OpenSSH 片段；不要手改 |
| `~/.dsh/remote-ssh/instances/<id>.yml` | 每次打开时生成的该主机 Loader overlay |
| `~/.dsh/remote-ssh/instances/<id>.pid` | 正在运行的远端窗口进程记录，用于崩溃恢复 |
| `~/.dsh/remote-ssh/homes/<host-id>/` | 每台主机的隔离 DSH home；只继承凭据/设置文件，工作区登记指向远端路径 |
| `~/.dsh/remote-ssh/homes/<host-id>/storages/pending-session.json` | 主界面点会话时写入的待定位会话标记（0600，TTL 5 分钟，远端窗口读取后删除） |
| `~/.dsh/remote-ssh/mixed/workspaces.json` | 混合模式登记表：主机、远端路径与本地镜像路径（0600） |
| `~/.dsh/remote-ssh/mixed/mounts/<host-id>/` | 混合模式的本地镜像目录，只用于 Workspace realpath，不复制远端文件 |
| `~/.dsh/remote-ssh/mixed/runtime/<version>/tree/` | 混合模式的私有模块树（官方本地 provider + SSH 包），保证模块身份一致 |
| `~/.ssh/config` | 顶部插入受管理的 `Include` 块；首次修改前备份为 `config.dsh-remote-ssh.bak` |
| `~/.dsh/profiles/dsh-remote` | 插件准备的本地远端运行时 profile |

生成的 `~/.ssh/config` 片段大致如下（`Include` 指向托管文件）：

```sshconfig
# BEGIN dsh-plugin-remote-ssh (managed; do not edit)
Include /home/me/.dsh/remote-ssh/ssh_config
# END dsh-plugin-remote-ssh
```

被托管的每个 Host 默认写入 `StrictHostKeyChecking yes`。首次连接由插件用 `accept-new` 完成引导并把主机密钥写入 `known_hosts`，之后官方 provider 使用严格校验。可以按主机把该值改为 `accept-new` 或 `no`。

删除全部托管主机后，`Include` 块会保留但指向空片段，这是有意为之，避免频繁改写用户配置。

## 配置项

在 profile 的 `cordis.patch.yml` 中按行 id 覆盖。**行覆盖会替换整个 `config`**，因此只写需要的键也可以，其余键会取 `Config` 默认值；如果你依赖旧值，请显式写全。

```yaml
- id: remote-ssh
  config:
    profileName: dsh-remote
    inheritDesktopSettings: true
    sshPackageVersion: 0.2.1-rc.2
    remoteNode: /usr/bin/node
```

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `sshExecutable` | `ssh` | 引导和诊断使用的 OpenSSH 客户端 |
| `sshConfigPath` | `~/.ssh/config` | 读取主机并维护受管理 `Include` 的用户配置 |
| `dataDir` | `~/.dsh/remote-ssh` | 插件数据目录 |
| `profileName` | `dsh-remote` | 准备并启动的本地 runtime profile 名 |
| `sshPackageVersion` | 当前 DSH 版本 | 官方 SSH 包版本；为空时使用运行中的 Harness 版本 |
| `helperPackage` | `@deepseek-ai/dsh-ssh` | 远端安装的 helper npm 包 |
| `helperRoot` | `~/.dsh-remote-ssh/helper` | 远端 helper 父目录，按版本分子目录 |
| `npmRegistry` | 未设置 | 远端 helper 安装使用的 npm registry |
| `remoteNode` | 自动发现 | 远端 Node 绝对路径；默认先查 SSH PATH，再探测 fnm/nvm/volta 等常见安装目录 |
| `connectTimeoutMs` | `15000` | 单次 SSH 连接超时 |
| `commandTimeoutMs` | `30000` | 单条远端诊断命令超时 |
| `installTimeoutMs` | `600000` | 远端 helper 或本地 runtime 安装超时 |
| `openTimeoutMs` | `90000` | 等待远端窗口打印 URL 的截止时间 |
| `inheritDesktopSettings` | `true` | 把桌面 profile 的用户补丁应用到远端窗口（沿用模型/UI 设置） |
| `mirrorWorkspace` | `true` | 在本机创建与远端同路径的空目录，绕过工作区 realpath 校验 |
| `permissionMode` | `workspace-write` | 远端窗口的沙箱模式：`workspace-write` / `read-only` / `danger-full-access` |

主机表单还支持以下按主机字段（保存到 `hosts.json` 并写入 `ssh_config`）：

`alias`、`displayName`、`description`、`hostname`、`user`、`port`、`identityFile`、`proxyJump`、`proxyCommand`、`identitiesOnly`、`forwardAgent`、`serverAliveInterval`、`serverAliveCountMax`、`strictHostKeyChecking`、`userKnownHostsFile`、`connectionAttempts`、`connectTimeout`、`extraOptions`、`remoteWorkspace`、`remoteHelperRoot`。

`extraOptions` 不接受 `Host`、`Match`、`Include`，并且拒绝重复指令。

## 打开流程

`openHost` 在 Host 侧按以下阶段执行，并把阶段写回快照供面板轮询：

1. `checking`：`doctor` 检查 SSH、远端平台、Node/npm、helper 版本、工作目录、主机密钥和本地 profile。
2. `installing-helper`：如果 helper 缺失或版本不匹配，且调用方传了 `allowInstall: true`，在远端执行 npm 安装并计算入口文件 sha256；会优先使用 doctor 探测到的绝对 npm，并把 Node 目录加入安装命令的 PATH（兼容 fnm/nvm 不在非交互 SSH PATH 的情况）。
3. `preparing-runtime`：在本地准备 `dsh-remote` profile（首次安装 4 个官方 SSH 包）。
4. `starting`：准备隔离的 DSH home，并用该主机的 overlay 启动独立 Web 实例，等待它打印 `dsh web: http://127.0.0.1:<port>/?<token>`。overlay 同时挂载远端目录选择器与会话深链插件。
5. `running`：URL 可用；`openUrl` 把 URL 返回给浏览器，由面板 `window.open` 打开。
6. `failed` / `stopping` / `idle`：失败、停止和空闲状态。

启动前插件会准备独立的 DSH home：把 `profiles/dsh-remote` 链接进去，继承 `.credentials.yaml`、`.env`、`settings.yaml` 和 `AGENTS.md`，并写入一条指向远端 workspace 的工作区记录。这样远端窗口不会复用桌面的本机项目/会话列表，默认工作区就是远端目录。

overlay 会关闭本地的 `subprocess`、`sandbox`、`fs-sandbox`，插入官方 SSH 的四行，并把 `sandbox-policy.workspaceRoot` 改成远端工作目录；同时关闭本机的 `file-reference-local`，插入跟随 `fs-ssh` 的远端文件引用提供者。默认的 `directory-picker`（桌面端会弹本机原生文件夹对话框）也会被替换为插件的远端浏览后端；另挂一个小的会话深链插件，用来领取主界面投递的待定位会话。官方 provider 是单例：**一个远端窗口只服务一台主机**，因此每台主机使用独立实例和独立 overlay。

## 混合模式（同一窗口）

除了独立远端窗口，插件还支持把远端目录直接放进**当前**桌面窗口：

1. 打开侧栏「远程工作区」，在某台主机的远端工作区或主机标题旁点「在此窗口打开」。
2. 插件会检查该主机、展开 `~`、确认远端目录可写、确认 helper 已安装并准备好 `dsh-remote` profile；首次会创建本地镜像目录 `~/.dsh/remote-ssh/mixed/mounts/<host-id>/<name>-<hash>`。
3. 面板用普通 Workspace API 登记镜像目录并跳转到它；新建会话的 cwd 就是这个镜像路径。
4. 在该会话里执行 Bash、读写文件、列目录时，路由器按路径把调用分派到该主机的 SSH 世界；其他本地 Workspace 的会话仍走本机执行。

路由优先级：镜像挂载前缀 → 当前工具会话的远端环境（`tools/execute` 的 session cwd）→ cwd 所在镜像 → 本地。远端会话里的绝对路径（如 `/etc/hostname`）按远端解释，不会误读本机文件。

**注意**：混合模式只接管 `fs`、`subprocess`、`sandbox` 三个服务。内容搜索仍使用打包的本地 ripgrep（镜像目录没有远端文件），`@` 文件候选、LSP、open-in-app、spill 等仍按本机实现；需要完整远端语义时请使用独立远端窗口。

登记信息存放在 `~/.dsh/remote-ssh/mixed/workspaces.json`；RPC `removeMixedWorkspace` 可移除登记并断开该主机世界，但不会删除普通 Workspace 记录。

## 安全

- 不在 `hosts.json`、`ssh_config`、overlay 或日志中保存 SSH 密码、token；认证完全交给 OpenSSH（密钥、agent、ProxyCommand）。
- `ssh`/`scp` 不经过本地 shell 拼接；参数以 argv 传递。远端命令通过明确的 `/bin/sh -c` 执行。
- 浏览器和 Host 之间使用 Harness Connection 自带的鉴权 Fetch 通道，每个端点一条精确路由。
- 远端窗口 URL 中的 token 只在 `openUrl` 返回值中使用；实例日志和错误详情会脱敏后再返回浏览器。
- `hosts.json`、生成的 `ssh_config`、overlay 和 pid 记录都以 0600 写入；`~/.ssh/config` 首次修改前会备份。
- 官方 provider 启动 helper 时使用 `BatchMode=yes`、`StrictHostKeyChecking=yes`、`ForwardAgent=no`、`ClearAllForwardings=yes`；插件不会绕过这些限制。

## 已知限制

- **一台主机一个远端窗口**：官方 `dsh-ssh` 在单个 composition 中是单例，不能在同一窗口切换多台主机。
- **不是完整 VS Code Remote**：`@` 文件引用和目录选择器已经改为读取远端文件系统，但 workspace changes、open-in-app、spill、skill filesystem 等仍按本机工作区实现，可能不可用或行为不一致；目前通过同路径本地镜像缓解工作区 realpath 校验。
- **PTC 不可用**：node-script helper 没有可执行 bootstrap，overlay 会关闭 `ptc-runtime` 和 `workflow-ptc`。
- **globs/grep**：远端 `glob`/`grep` 可能依赖远端 ripgrep；没有安装时相关工具会失败或回退。
- **没有文件 watch**：远端文件变化不会通过本机 fs watch 推送。
- **端口转发/agent 转发**：官方 provider 固定 `ClearAllForwardings=yes`、`ForwardAgent=no`；需要转发请在 `~/.ssh/config` 的 `ProxyCommand` / `ProxyJump` 层解决。
- **helper 安装依赖 npm 和网络**：npm 12 会提示 `install-scripts` 被阻断，但 `node-pty` 自带 prebuilds，通常不影响 helper 运行。Node/npm 由 fnm、nvm、volta 等管理时，插件会探测其常见目录；也可用 `remoteNode` 指定绝对路径。
- **本地镜像副作用**：`mirrorWorkspace: true` 会在本机创建与远端同路径的目录（只建目录，不建文件）；如果远端路径在本机不可创建（如 `/root`），添加工作区会失败而不是登记一个不存在的路径。
- **会话深链是尽力而为**：标记 5 分钟过期、读取即删；远端会话已删除或客户端过慢时只打开远端窗口，不会定位到会话；在面板点击会话时若 helper 尚未安装，会先显示失败与安装提示。
- **混合模式不覆盖所有子系统**：只有 `fs`/`subprocess`/`sandbox` 被路由；搜索用本地 ripgrep、`@` 候选按本地镜像扫描、LSP/open-in-app/spill 仍按本机实现。需要完整远端语义请用独立远端窗口。
- **混合模式的 cwd 是镜像路径**：模型看到的工作目录是本地镜像路径，绝对远端路径在同一会话内仍可用；排查时注意区分两个命名空间。

## 故障排查

| 现象 | 排查 |
| --- | --- |
| 侧栏没有「远程 SSH」 | 确认 bundle 已加入 profile、Host 已重启；浏览器强刷一次客户端资源 |
| 导入列表为空 | 检查 `~/.ssh/config` 的 `Host` 是否含通配符（通配符不会导入）、`ssh -G <alias>` 是否成功 |
| 保存主机失败 | 检查别名是否重复、端口/路径是否合法；服务端会回滚并保留原文件 |
| 测试连接失败 | 先用终端执行 `ssh -v <alias>`；注意 `ProxyCommand` 中的代理是否可用 |
| 提示 helper 未安装 | 确认远端 Node/npm 可用、npm registry 可达；fnm/nvm/volta 安装会自动探测，仍失败时设置 `remoteNode` 或按对话框命令手动执行 |
| 窗口启动超时 | 查看「详情」中的日志尾部；常见原因是远端 helper 崩溃、官方 SSH 行未激活或 Host 密钥校验失败 |
| 远端窗口能打开但文件/终端不可用 | 检查远端 workspace 是否可写；查看日志中 `ssh`、`fs-ssh`、`subprocess-ssh` 是否 pending/报错 |
| 主机密钥严格校验失败 | 先让插件用 `accept-new` 完成首次连接，或手动 `ssh <alias>` 写入 known_hosts |

## 开发与验证

```bash
npm test                 # 单元测试 + sshd 夹具集成测试
npm run verify:static    # 静态结构/清单/语法检查
npm run verify:client    # 客户端契约与 locale 一致性
npm run verify:docs      # README/架构文档一致性
npm run verify:e2e       # 使用测试夹具的端到端编排检查
node verification/live-e2e.mjs --alias <alias> --version 0.2.1-rc.2  # 可选：真实 SSH 主机的完整打开流程
node verification/live-remote-window.mjs --alias <alias> --version 0.2.1-rc.2  # 可选：真实远端窗口 UI（目录选择器 + 会话深链 + 复用窗口）
```

实现细节见 [docs/architecture.md](./docs/architecture.md)。测试夹具见 [tests/rig/README.md](./tests/rig/README.md)。

## 许可

本项目使用 [MIT](./LICENSE) 许可证，版权归 junjiangao 所有。