# 架构与实现

本文说明 `@junjiangao/dsh-plugin-remote-ssh` 的装配方式、模块分层、一次打开流程的数据流、关键设计取舍、安全边界和已知限制。文中的标识符、路径和 OpenSSH 指令保持原样。

## 1. 定位

这是一个 **Host + Client 的 DeepSeek Harness bundle**：

- Host 半（`index.js` + `lib/`）管理主机、生成 OpenSSH 配置、准备远端 helper 和本地 runtime、启动独立远端窗口，并挂载**混合执行路由器**：在同一窗口内按路径/会话把 `fs`、`subprocess`、`sandbox` 调用分派到本地世界或隔离的 SSH 世界；**不注册模型工具**。
- Client 半（`client.js`）在侧栏注册入口，在主区渲染主机管理面板，通过 Harness Connection 的鉴权 Fetch 通道调用 Host；「远程工作区」面板的「在此窗口打开」会把远端目录登记为主窗口的普通 Workspace。
- 真正的远端执行能力来自官方 `@deepseek-ai/dsh-ssh`、`dsh-fs-ssh`、`dsh-subprocess-ssh`、`dsh-sandbox-ssh`。插件不实现 SSH 协议，也不包装 `ctx.tools`。

```
package.json  dsh.bundle.patch / dsh.client
      ↓
cordis.patch.yml   disable subprocess / sandbox / fs-sandbox
                   insert { id: remote-ssh, name: '@junjiangao/dsh-plugin-remote-ssh', config: {} }
      ↓
index.js           name / inject=['connection'] / Config / apply
      ├─ mountExecutionRouter(ctx)         // 路由 fs / subprocess / sandbox
      ├─ RemoteSshController.start()
      └─ registerRpc(ctx, controller)      // /api/remote-ssh/<endpoint> × 13
      ↓
client.js        window.__ModuleLoader__.load(...)
      ├─ slots.register('sidebar.panellist', { id: 'remote-ssh' })        // 主机管理
      ├─ slots.register('main', { key: 'remote-ssh' })
      ├─ slots.register('sidebar.panellist', { id: 'remote-workspace' })  // 远程工作区
      └─ slots.register('main', { key: 'remote-workspace' })
```

`inject=['connection']` 是 Host 侧唯一的插件级强依赖：没有 Connection 服务时插件保持 inactive，不抛错。Client 侧 `inject=['connection','slots','locale','workspaces','uiWorkspace']`；后两个用于把远端镜像目录登记为普通 Workspace 并在当前窗口打开。

## 2. 模块分层

| 模块 | 职责 |
| --- | --- |
| `index.js` | 导出 Loader 身份、Config，创建 controller，注册 RPC，绑定 dispose |
| `lib/config.js` | schemastery Config 与 `resolveConfig`，补齐默认值 |
| `lib/paths.js` | `~` 展开、DSH home、profile/dataDir 路径、CLI/runtime 发现、POSIX 断言 |
| `lib/store.js` | `hosts.json` 的原子读写、序列化、损坏备份、别名唯一性、增删改 |
| `lib/ssh-config.js` | 生成托管片段、维护 `~/.ssh/config` 的 Include、解析用户 config、`ssh -G` 解析与校验 |
| `lib/ssh.js` | OpenSSH argv 构造、有界子进程、超时/取消、错误归类、本地命令 |
| `lib/validate.js` | 浏览器输入的主机草稿校验与规范化 |
| `lib/errors.js` | 稳定的错误码、RPC 错误投影 |
| `lib/helper.js` | 远端事实发现、helper 路径/安装/哈希、远端工作目录 |
| `lib/doctor.js` | 只读就绪检查，不安装任何东西 |
| `lib/runtime-profile.js` | 插件私有的 `dsh-remote` profile，安装官方 SSH 包 |
| `lib/overlay.js` | 每台主机的 Loader overlay |
| `lib/remote-home.js` | 每台主机的隔离 DSH home、继承文件、远端 workspace 登记 |
| `lib/remote-reference.js` | 复制进远端 profile 的 `@file` 提供者，按官方 `fs-ssh` 列目录 |
| `lib/remote-directory-picker.js` | 复制进远端 profile 的 `directoryPicker` 后端，用 `fs`/`subprocess` 浏览远端目录，并按配置创建本机镜像目录 |
| `lib/pending-session.js` | 主窗口写到隔离 home 的待定位会话标记（校验、TTL、原子写、读取即删） |
| `lib/remote-workspaces.js` | 只读扫描各隔离 home 的 `workspace.json` 与 session 投影缓存，供主界面面板使用 |
| `lib/execution-router.js` | 混合执行路由器：本地/SSH 两个隔离世界、路径到世界的映射、`tools/execute` 环境、离线重连与派发 |
| `lib/mixed-registry.js` | 主窗口混合工作区登记表：镜像路径、远端路径、主机、原子写与按前缀匹配 |
| `lib/mixed-runtime.js` | 私有模块树：把官方本地 provider 与 profile 中的 SSH 包放进同一个可解析目录，保证模块身份一致 |
| `runtime/remote-session-deeplink/index.js` | 复制进远端 profile 的 Host 半：注册 `/api/remote-session-deeplink/claim`，领取并消费标记 |
| `runtime/remote-session-deeplink/client.js` | 复制进远端 profile 的 Client 半：领取 sessionId 后调用 `uiWorkspace.openSession` |
| `lib/instance.js` | 远端 Web 子进程的启动、URL 提取、日志脱敏、pid 记录、停止 |
| `lib/controller.js` | 编排：snapshot、CRUD、测试、doctor、helper 安装、打开/停止、远程工作区清单 |
| `lib/rpc.js` | Connection Fetch 路由、请求封包校验、错误映射 |
| `client.js` | 两个侧栏入口与面板：主机管理、远程工作区与会话；表单、轮询、安装确认、打开/停止 |

## 3. 主机存储与 ssh_config

### 3.1 两层数据

1. **`hosts.json`**：插件托管主机，字段见 README。写入通过临时文件 + `rename` 原子完成；文件损坏时改名为 `.corrupt-<timestamp>` 并重置，同时保留警告。
2. **`ssh_config`**：由 `hosts.json` 渲染出来的 OpenSSH 片段，文件头带 “Do not edit” 提示。

`~/.ssh/config` 顶部维护一个带标记的 Include 块：

```sshconfig
# BEGIN dsh-plugin-remote-ssh (managed; do not edit)
Include <dataDir>/ssh_config
# END dsh-plugin-remote-ssh
```

- 首次写入前把用户 config 备份为 `config.dsh-remote-ssh.bak`。
- 重复写入是幂等的：标记块存在且内容一致时不改文件。
- `~` 不展开、用户 config 是符号链接、config 不存在等情况都在 `ensureManagedInclude` 内分别处理。
- 删除全部托管主机后保留 Include 块，避免反复改动用户文件。

### 3.2 导入主机

`parseUserConfig` 递归读取 Include、跳过通配符 Host、展开 `~`，得到字面量别名列表。`snapshot` 对每个别名执行：

```text
ssh -F <sshConfigPath> -G <alias>
```

解析出 hostname/user/port/identityFile/proxyJump/proxyCommand/strictHostKeyChecking 等字段。导入条目最多 64 个、并发 4 个；解析失败会带 `resolutionError` 但仍展示。导入条目的 `editable` 为 `false`，只能“复制为托管”。

与托管别名同名的导入条目会被隐藏（托管优先）。

### 3.3 保存校验

`saveHost` 的顺序是：

1. `validateHostDraft` 校验浏览器输入。
2. `HostStore.save` 检查别名唯一，写入 `hosts.json`。
3. `writeManagedConfig` 重写片段。
4. `ensureManagedInclude` 确保用户 config 引用片段。
5. `verifyManagedHosts` 对每个托管别名执行 `ssh -G`，确认生成的配置能按预期解析。
6. 任一步失败则 `#rollback` 恢复前一份主机列表和生成文件，避免“hosts.json 已变但 ssh_config 没变”。

## 4. 远端 helper

官方 `dsh-ssh` 需要一个与 provider 版本匹配的远端 helper。插件的步骤如下：

1. `discoverRemoteFacts`：通过 `/bin/sh -c` 获取远端平台、home、`node`/`npm` 路径和版本。
2. `prepareRemoteWorkspace`：展开 `remoteWorkspace`（`~` 用远端 home），必要时 `mkdir -p`，检查可写。
3. `inspectHelper`：检查 `<helperRoot>/<version>/node_modules/<helperPackage>/lib/helper.js` 是否存在、版本是否匹配。
4. `installHelper`：在远端执行
   `npm install --prefix <root>/<version> --no-audit --no-fund --omit=dev <helperPackage>@<version>`；
   可选 `--registry`。安装后重新检查并计算入口文件的 sha256。
5. 把绝对路径、sha256、远端 node 路径、workspace 写入该主机的 overlay。

引导阶段（发现事实、安装、工作目录检查）默认使用 `-o StrictHostKeyChecking=accept-new`，把主机密钥写入 `known_hosts`；随后 `doctor` 再显式用 `StrictHostKeyChecking=yes` 检查一次，官方 provider 启动时也使用严格校验。

helper 安装需要 `allowInstall: true` / 安装确认。`doctor` 和 `snapshot` 永远不安装。

## 5. 本地 runtime profile

官方 SSH provider 不能和本地执行 provider 同时存在，也不能复用桌面 profile，因此插件准备了独立的 `dsh-remote` profile：

- 目录：`~/.dsh/profiles/dsh-remote`；被占用时依次尝试 `-plugin`、`-plugin-2`…，并写入 marker `.dsh-remote-ssh-profile.json` 证明所有权。
- `package.json` 的 bundles 是 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`，依赖固定为当前版本的四件套。
- `pnpm-workspace.yaml` 使用 `nodeLinker: hoisted`、`autoInstallPeers: false`，并把四个包加入 `minimumReleaseAgeExclude`。
- 安装优先 `--prefer-offline`，失败再在线；所有安装都有超时和取消。
- 每次启动远端窗口前调用 `profile.ensure()`，已就绪则跳过安装；同时把三份插件私有的运行时脚本复制进 profile，供 overlay 以绝对路径加载：
  - `lib/remote-reference.js` → `remote-file-reference.mjs`（远端 `@` 文件候选）；
  - `lib/remote-directory-picker.js` → `remote-directory-picker.mjs`（远端目录选择器后端）；
  - `runtime/remote-session-deeplink/` → `plugins/remote-session-deeplink/`（会话深链的 Host 与 Client 两半）。
  复制使用临时文件 + `rename`，避免半写文件被 Loader 读到。

`inheritDesktopSettings` 为 true 时，桌面 profile 的 `cordis.patch.yml` 会作为第一个 `--patch` 应用于远端窗口；随后是每台主机的 overlay。

## 6. 每主机 overlay

`renderOverlay` 生成纯文本 YAML，写入 `instances/<safe-id>.yml`（0600）。远端窗口自己仍然禁用本地执行行（与 bundle patch 对主窗口的禁用相互独立、可重复）。内容分五类：

1. **禁用本地执行世界**：`subprocess`、`sandbox`、`fs-sandbox`、`ptc-runtime`、`workflow-ptc`、`open-in-app`、`ui-open-in-app`。
2. **修正基础行**：`sandbox-policy.workspaceRoot` 指向远端 workspace，`web.searchProvider: !!js undefined` 让 web 服务自动选择可用 provider。
3. **替换文件引用**：关闭本机 `file-reference-local`，插入 `remote-file-reference`（profile 内脚本的绝对路径）。该提供者只做一次远端目录列举，不做全盘递归索引。
4. **插入官方 SSH 四行**（新的 id）：`ssh`、`fs-ssh`、`subprocess-ssh`、`sandbox-ssh`；`ssh.config` 带 host、launch、helper、helperHash、workspace。
5. **替换目录选择器与会话深链**：禁用官方 `directory-picker`（否则 Linux/macOS 桌面会弹本机原生文件夹对话框），插入 `remote-directory-picker`（profile 内脚本的绝对路径）与官方客户端 UI `@deepseek-ai/dsh-client-ui-directory-picker-browse`；同时插入 `remote-session-deeplink`（profile 内插件包的绝对入口），让远端窗口能领取主窗口投递的待定位会话。

overlay 是 **每台主机一份** 的，因为官方 provider 在单个 composition 中是单例。远端窗口启动时通过：

```text
dsh --profile <profileName> [--patch <desktopPatch>] --patch <overlay> --no-open --host 127.0.0.1 --port 0
```

`InstanceManager` 捕获 stdout/stderr，从输出中提取 `dsh web: <url>`；URL 里的 token 会从日志视图中脱敏。子进程以独立进程组启动，停止时先 SIGTERM 再 SIGKILL。pid 记录用于 Host 崩溃后清理遗留实例。

### 6.1 隔离 DSH home

远端窗口不能复用桌面的 `DSH_HOME`：其中的 workspace/session 记录都是本机路径，而子进程的 `fs` 是远端文件系统，选中本机项目后 `working-directory` 在远端不存在。`prepareRemoteHome` 因此为每台主机准备 `homes/<host-id>/`：

- `profiles/<profileName>` 符号链接到正常位置的 `dsh-remote` profile，官方 SSH 包不重复安装；
- 从真实 DSH home 符号链接 `.credentials.yaml`、`.env`、`settings.yaml`、`AGENTS.md`；
- 写入 `storages/workspace.json`，至少包含一条 `path` 为远端 workspace 的记录；已有远端会话/额外工作区会保留；
- 子进程以该 home 作为 `DSH_HOME`，cwd 优先使用远端 workspace 的本地镜像路径。

这样新会话的 cwd 就是远端工作区，`workingDirectory.ensure`、workspace files API 和远端文件引用都以远端路径运行，而不会出现 `<Documents>/deepseek-harness/default-workspace` 这种本机默认路径。

### 6.2 远端目录选择器

Web 组合默认挂 `@deepseek-ai/dsh-host-directory-picker-auto`：在 Linux/macOS 桌面上它会选择**原生**文件对话框，用户看到的是运行远端窗口的那台本机文件夹，而不是 SSH 主机。官方 browse 后端同样使用本机 `node:fs`。

overlay 因此禁用 auto 行，改挂两份插件私有实现：

- `remote-directory-picker`：以 `ctx.provide('directoryPicker', { capability: () => ({ kind: 'browse', list, createDirectory }) })` 注册后端。`list` 先用 `ctx.fs.resolve` 规范化远端路径，再 `ctx.fs.listDir` 列目录、`ctx.fs.processPath` 生成绝对路径；`home` 来自远端 `printf %s "$HOME"`（一次查询并缓存），不使用本机 `homedir()`。
- `@deepseek-ai/dsh-client-ui-directory-picker-browse`：官方浏览对话框 UI；它只依赖 `ctx.uiWorkspace.listDirectory/createDirectory`，由 Host 侧 `workspace-controller` 转发到上面的后端。

`createDirectory` 通过 `ctx.subprocess` 在远端执行 `mkdir -p -- <path>`（argv 固定、路径单引号转义），已存在的目录返回 `directory-exists`。

选择远端目录后还需要工作区登记：`@deepseek-ai/dsh-workspace` 的 `create()` 在远端窗口进程里仍用**本机** `node:fs` 的 `realpath`/`stat` 校验路径。`mirrorWorkspace` 打开时，后端在列出的当前目录和新建目录上 best-effort 创建本机同绝对路径的空目录（只建目录、不建文件、失败忽略），让登记通过；本机无权限创建的路径（如远端 `/root/project`）会在对话框里报错而不是登记一个不存在的路径。

### 6.3 会话深链

主界面「远程工作区」面板点击某个远端会话时，希望远端窗口启动后直接定位到它。DSH 没有 URL 级会话路由，带 token 的根 URL 又会 303 到 `./` 并丢掉 query，因此不使用 `?session=`。

流程是：

1. 主窗口调用 `openHost(id, { sessionId })`；`lib/pending-session.js` 把 `{ version: 1, sessionId, createdAt }` 原子写入该主机隔离 home 的 `storages/pending-session.json`（0600）。普通打开会先删除陈旧标记，避免误定位。
2. 远端窗口的 `remote-session-deeplink` Host 半注册 `POST /api/remote-session-deeplink/claim`，读取后立即删除标记；无文件返回空对象，超过 5 分钟的标记视为过期。
3. 同插件的 Client 半在 Connection 就绪后领取 `sessionId`，等待 workspace/session 基线加载完成（避让启动恢复），再调用 `uiWorkspace.openSession(sessionId)`。会话已删除、服务未就绪等情况静默忽略。
4. 窗口启动后 Client 半继续在**可见时**每 3 秒领取一次标记（并在 `focus`/`visibilitychange` 时立即领取）。因此对已运行的远端窗口再次点会话时，即使 `openHost` 复用实例、不重启窗口，仍能定位到新会话。

标记不含凭据，读取即删且有 TTL；即使打开流程失败，残留标记最多影响 5 分钟内的下一次打开，而普通打开会主动清理。

## 7. 打开流程与状态机

```text
idle
  └─ openHost → checking
        ├─ ssh 失败 / 必需检查失败 → failed
        ├─ helper 缺失或版本不匹配
        │     ├─ allowInstall=false → 抛 helper-missing（带 installCommand / requiredVersion）
        │     └─ allowInstall=true  → installing-helper → preparing-runtime
        └─ helper 已就绪 → preparing-runtime
              └─ starting → running
                    └─ stopHost → stopping → idle
```

阶段通过 `InstanceManager.setPhase` 写回内存，`snapshot` 每轮返回 `instance.phase/message/error/logTail/hasUrl`。面板轮询 `snapshot`，在 `running` 后调用 `openUrl`。

`openHost` 本身立即返回 `{ jobId, snapshot }`，实际流水线在后台 job 中执行；同一主机不会并发打开两个 job，重复点击复用。

### 7.1 主界面「远程工作区」面板

主界面侧栏的第二个入口只做**只读聚合**，不需要先打开远端窗口：

1. `lib/remote-workspaces.js` 读取每台托管主机隔离 home 下的 `storages/workspace.json` 与 `storages/session_projcache/sessions/*.json`。
2. 会话归属优先级：`workspace.sessionIds` → 会话记录 `cwd` 与工作区 `path` 的最长前缀匹配 → 以 `cwd` 生成的派生工作区（无 `cwd` 时 `path` 为空），保证未登记会话仍可见、可点。
3. 返回 `{ generatedAt, warnings, hosts }`，每台主机带 `phase/running`（来自 `InstanceManager.view`）与按 `workspaceIds` 顺序排列的工作区；会话按 `lastActiveAt` 降序，`blank`、`pinned`、`archived` 原样透出。
4. 扫描严格只读且不抛错：单个文件损坏只进 `warnings`，其他主机/工作区/会话照常返回；不需要 SSH 连接。

面板按「远程机名称 + 工作区」分组展示，可直接「打开窗口/停止」；点击会话时调用 `openHost(id, { sessionId })`，轮询 `snapshot` 到该实例 `running`，再 `openUrl` 并 `window.open`，远端窗口通过 6.3 的标记定位会话。

### 7.2 混合模式：在当前窗口打开远端工作区（选项 C）

远端窗口（6.x）适合“整窗看远端”，但本地项目与远端项目会被拆到两个窗口。混合模式让**同一个桌面窗口**同时持有本地与远端工作区：

- 本地会话完全走原来的本地执行世界；远端工作区登记为普通 Workspace，其 `cwd` 是本地镜像路径。
- 远端会话的 `fs` / `subprocess` / `sandbox` 调用由路由器分派到该主机的 SSH 世界；本地会话不受影响。
- 会话、侧栏、会话日志、`@` 引用入口等仍由桌面自带的 Workspace/Session 控制器管理，插件只负责“远端目录 ↔ 本地镜像路径”和“路径 → 世界”的映射。

#### 装配

1. bundle patch 先禁用基础 provider 行：`subprocess`、`sandbox`、`fs-sandbox`；随后插入 `remote-ssh` 行。
2. `index.js` 在 `controller.start()` 之前调用 `mountExecutionRouter`：
   - 从 DSH 安装目录加载官方本地 provider（`dsh-fs-sandbox`、`dsh-subprocess-local`、`dsh-sandbox-local`），挂到 `ctx.isolate('fs').isolate('subprocess').isolate('sandbox')` 的**本地世界**；
   - 在根上下文注册三个路由服务（`fs`、`subprocess`、`sandbox`），对上层完全等价于原 provider。
3. 每个已登记的远端主机按需创建**远端世界**：
   - 独立 `ctx.isolate(...)` 子上下文，挂官方 `SshConnection` + `dsh-fs-ssh` / `dsh-subprocess-ssh` / `dsh-sandbox-ssh`；
   - SSH 包从 `dsh-remote` profile 复制，DSH 其余包以符号链接并入私有模块树，保证 `@deepseek-ai/cordis` 等模块身份与主进程一致；
   - provider 仍以 `connection.workspace` 为远端根，绝对路径和 cwd 每个调用都会显式传入。

#### 路径映射

登记时 Host 计算镜像目录：

```text
<dataDir>/mixed/mounts/<hostId>/<可读尾部>-<sha8>
```

例如远端 `/home/me/project` → `~/.dsh/remote-ssh/mixed/mounts/host_x/home-me-project-1a2b3c4d`。镜像目录只用于工作区 realpath 校验与本地路径命名；其中不复制远端文件。`lib/mixed-registry.js` 持久化 `{ hostId, remotePath, mountPath }`。

路由优先级：

1. **镜像挂载前缀**：本地路径落在某个 `mountPath` 下 → 远端世界，路径换成 `remotePath + 相对部分`；
2. **会话环境**：`tools/execute` 用 `exec.agent.session.header.cwd` 建立 AsyncLocalStorage。若该 cwd 属于远端镜像，则这次工具调用里的**所有绝对路径都属于远端**（例如模型读 `/etc/hostname` 不会读到本机文件），相对路径以远端根解析；
3. **cwd 挂载**；4. 否则本地世界。

沙箱策略的 `workspaceRoot` 会按同一挂载映射回远端路径；`spawn` 的 cwd、可执行文件解析同样按世界映射。纯本地的 Node 进程（`process.execPath`、DSH runtime 内的脚本）在远端 cwd 下被强制走本地世界，避免把主进程的 PTC 子进程送到远端。

#### 登记流程

主界面「远程工作区」面板对每个远端工作区/主机提供「在此窗口打开」：

1. Client 调用 `registerMixedWorkspace({ id, remotePath })`；Host 依次检查主机存在、展开远端 `~`、`mkdir -p` 并确认可写、helper 已安装且版本/哈希匹配、准备 `dsh-remote` profile，然后创建镜像目录、连接远端世界、写登记表。
2. Client 用返回的 `mountPath` 调 `workspaces.create({ path })`，把它变成普通 Workspace；随后 `workspaces.rename` 设置可读标题，`uiWorkspace.openWorkspace(workspaceId)` 导航过去。
3. 在新会话里执行 Bash、读写文件、列目录都会经过路由器；本地 Workspace 的会话保持本地执行。

`removeMixedWorkspace({ id })` 只删除登记与远端世界（最后一台主机时断开），不删除普通 Workspace 记录；镜像目录保留，便于重新登记。目前 UI 只使用「在此窗口打开」，未暴露移除按钮。

#### 已知限制（混合模式）

| 限制 | 说明 |
| --- | --- |
| 搜索工具仍用本地 ripgrep | `tool-fs-search` 通过打包的本地 `rg` 扫本地镜像目录；镜像目录没有远端文件，所以远端会话的内容搜索不可用 |
| `@` 文件候选按本地镜像扫描 | 远端文件不在镜像中；远端窗口的 `@` 由 5.x 的 remote-file-reference 处理，主窗口混合模式暂不支持远端全量候选 |
| LSP / open-in-app / spill 等按本机实现 | 它们使用 `node:fs` 或本机进程，不会自动跟随远端世界 |
| 会话 cwd 是镜像路径 | 模型看到的工作目录是镜像路径；绝对远端路径在远端会话内仍可用，但两个命名空间同时存在，排查时需区分 |
| 远端世界需要 helper 与 profile | 与远端窗口相同的前置条件；未安装 helper 时登记会给出明确错误 |
| 每台主机一个远端世界 | 与官方 SSH provider 单例约束一致；同一主机的多个远端工作区共享连接 |

## 8. RPC 契约

每个端点注册一条精确的 Fetch 路由：

```text
POST /api/remote-ssh/<endpoint>
content-type: application/json
body: { type: 'client-request', rpcId, payload }
resp: { type: 'server-response', rpcId, result }
result: { ok: true, value } | { ok: false, error: { code, message, details } }
```

端点：`snapshot`、`saveHost`、`deleteHost`、`testConnection`、`doctor`、`installHelper`、`openHost`、`openUrl`、`stopHost`、`remoteWorkspaces`、`mixedWorkspaces`、`registerMixedWorkspace`、`removeMixedWorkspace`。

- `remoteWorkspaces`：无参数，返回 `{ generatedAt, warnings, hosts }`。
- `mixedWorkspaces`：无参数，返回混合登记与各主机世界连接状态。
- `registerMixedWorkspace`：`{ id, remotePath }`；返回 `{ workspace, created, mountPath }`。
- `removeMixedWorkspace`：`{ id }`（登记 id）；返回 `{ removed, hostId }`。
- `openHost`：`{ id, allowInstall?, sessionId? }`；带合法 `sessionId` 时写入深链标记，不带时清理旧标记。

- 请求体上限 2 MiB；非 JSON 返回 415，非法封包返回 400。
- `installHelper` 必须显式 `confirm: true`。
- 错误码见 `lib/errors.js`；内部异常统一变成 `internal`，不把 stack 或凭据带过边界。
- 路由挂在 Harness Connection 自己的 `/api` 通道上，复用其 Host/Origin 围栏和浏览器鉴权，插件不自行实现鉴权。

## 9. 安全边界与不变量

- **输入是敌意的**：所有来自浏览器的值都先经过 `validateHostDraft`；别名限制为 `[A-Za-z0-9][A-Za-z0-9_.-]{0,63}`，拒绝控制字符、换行和保留指令。
- **argv 而非 shell**：`ssh`/`scp` 参数直接传给子进程；远端命令是明确的 `/bin/sh -c '...'`，脚本内容由固定模板拼接，变量用单引号转义。
- **文件权限**：`hosts.json`、`ssh_config`、overlay、pid、隔离 home 中的 `workspace.json`、临时 ssh config 全部 0600；数据目录和 home 目录 0700。
- **凭据继承**：隔离 home 只把 `.credentials.yaml`、`.env`、`settings.yaml`、`AGENTS.md` 做成指向真实 DSH home 的符号链接，不复制内容。
- **URL token**：只在 `openUrl` 返回；`instance.view()` 对 `logTail` 和 `error` 调用 `redactSecrets`。
- **不写凭据**：认证完全由 OpenSSH 完成；插件不读取私钥内容，不保存密码。
- **官方 provider 约束**：`BatchMode=yes`、`StrictHostKeyChecking=yes`、`ForwardAgent=no`、`ClearAllForwardings=yes`；overlay 不覆盖这些选项。
- **危险操作确认**：helper 安装必须确认；删除主机有确认；停止实例可取消。

## 10. 已知限制与取舍

| 限制 | 原因 / 取舍 |
| --- | --- |
| 一台主机一个远端窗口 | 官方 `dsh-ssh` 是 composition 单例；多主机需要多实例 |
| 不使用模型工具 | 需求明确使用官方 SSH 能力，避免与官方 agent 重复 |
| 远端工作区功能不完整 | `@` 引用、目录选择器已改走 `fs-ssh`/`subprocess`；workspace changes、open-in-app、spill、skill filesystem 仍按本机实现；PTC 被禁用 |
| 需要本地镜像目录 | 工作区附加会校验本机 realpath；`mirrorWorkspace` 创建同路径空目录绕过（仅目录，远端无权限路径会登记失败） |
| 会话深链是尽力而为 | 标记 TTL 5 分钟、读取即删；远端会话已删除或客户端过慢时只打开远端窗口，不定位会话 |
| 无端口/agent 转发 | 官方 provider 固定关闭；在 ssh_config 层用 ProxyCommand/ProxyJump 解决 |
| 不支持 Windows 客户端 | 官方 provider 的 POSIX 约束 |
| 远端依赖 Node/npm | helper 是 Node 脚本，通过 npm 安装 |
| 首次打开较慢 | 需要安装远端 helper 和本地 runtime profile；之后复用 |
| 混合模式的搜索/@/LSP 不完整 | 只有 `fs`/`subprocess`/`sandbox` 被路由；搜索用的打包 ripgrep、`@` 本地扫描、LSP、open-in-app 等仍按本机实现，详见 7.2 |
| 镜像目录不复制文件 | 镜像只满足 Workspace realpath；远端内容通过路由器按需读取，不做同步缓存 |

## 11. 测试与验证

- `tests/unit`：纯函数与模块级测试（校验、存储、ssh_config 解析/渲染、overlay、实例管理、RPC 错误、远端目录选择器、深链标记、远程工作区扫描、混合登记表、执行路由器路径映射等）。
- `tests/integration`：用 `tests/rig` 的临时 sshd 验证导入、测试连接、保存/更新/删除、回滚和配置验证，不触碰真实 `~/.ssh`。
- `verification/static-check.mjs`：bundle 结构、清单、语法、旧符号清理。
- `verification/client-audit.mjs`：客户端模块格式、槽位、RPC 端点、locale 键一致性。
- `verification/docs-audit.mjs`：中英文 README 与架构文档的一致性、配置键覆盖。
- `verification/e2e.mjs`：控制器 + 夹具的编排检查。
- `verification/live-e2e.mjs`：可选的真实主机完整流程；会备份并还原 `~/.ssh/config`，默认不在 CI 运行。
- `verification/live-remote-window.mjs`：可选的真实远端窗口 UI 联调。通过控制器打开真实窗口，再用本机 headless Chromium 的 DevTools 协议验证：会话深链生效、复用窗口也能切换会话、`添加工作区` 列出只存在于远端的目录；截图写入 `verification/out/live-remote-window.png`。需要用户自己的 `~/.dsh` 数据目录，默认不在 CI 运行。