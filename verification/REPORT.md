# 独立验证报告 — `@junjiangao/dsh-plugin-remote-ssh` 2.0

> 生成时间：2026-10-21
> 验证对象：工作区当前未提交的 2.0 重构
> 结论：**代码、静态结构、客户端契约、编排流程、本地完整 SSH 链路均通过；真实远端主机的 Web 工作区与文件引用已完成冒烟；桌面 Host 最新代码仍待重启确认。**

## 1. 范围

2.0 重构把插件从“向模型注册 SSH 工具”改为：

- Web 侧栏/主区的 SSH 主机管理面板；
- `~/.ssh/config` 导入 + 插件托管主机；
- 官方 `dsh-ssh` / `dsh-fs-ssh` / `dsh-subprocess-ssh` / `dsh-sandbox-ssh` 独立远端窗口；
- 远端 helper 检查、确认安装、本地 `dsh-remote` runtime profile 和每主机 overlay；
- 不再注册任何模型工具。

本报告只记录**本轮实际执行**的检查；历史工具时代的报告和产物已删除，避免与新实现混淆。

## 2. 环境

| 项 | 值 |
| --- | --- |
| 平台 | Linux |
| Node.js | v24.22.0 |
| DSH | 0.2.1-rc.2 |
| 仓库 | `/work/Repos/github/dsh-plugin-remote-ssh` |
| 测试 sshd | `tests/rig` 临时非特权 sshd（当前用户身份，`127.0.0.1` 临时端口） |
| 真实 `~/.ssh` | 验证脚本不修改；仅手工完整 E2E 时临时加入受控 Include，结束后逐字节还原 |

## 3. 验证矩阵

| 检查 | 命令 | 结果 | 证据 |
| --- | --- | --- | --- |
| 单元 + 集成测试 | `npm test` | **44/44 通过** | `verification/out`（Node test 输出） |
| Bundle/清单/语法 | `node verification/static-check.mjs` | **11/11 通过** | `verification/out/static-check.{json,txt}` |
| Client 契约 | `node verification/client-audit.mjs` | **9/9 通过** | `verification/out/client-audit.{json,txt}` |
| 文档一致性 | `node verification/docs-audit.mjs` | **11/11 通过** | `verification/out/docs-audit.{json,txt}` |
| 编排 E2E | `node verification/e2e.mjs` | **9/9 通过** | `verification/out/e2e.{json,txt}` |

### 3.1 单元/集成覆盖

- `validate`：别名、主机草稿、端口/数值范围、`extraOptions` 保留指令、远端路径展开。
- `helper`：远端 Node 版本范围、绝对 npm/PATH 安装命令、`remoteNode` 覆盖。
- `paths`：桌面 Host argv 的 runtime/bin 目录语义、bundled CLI 定位、pnpm node 路径。
- `store`：原子保存、更新、删除、别名冲突、损坏文件备份。
- `ssh-config`：托管片段渲染（含 `ProxyCommand` 等命令型选项原样输出）、Include 标记、用户 config 解析、`ssh -G` 解析、主机块校验。
- `overlay`：官方 SSH 四行、禁用的本地 provider、远端文件引用行、路径/digest 校验、0600 写入。
- `remote-home`：隔离 DSH home、profile/凭据符号链接、远端 workspace 登记、重复准备与额外工作区保留。
- `remote-reference`：远端目录即时列举、前缀过滤、显式目录下降、绝对路径、隐藏目录/排除目录行为。
- `instance`：URL 提取、ANSI 清理、token 脱敏、启动/超时/退出/停止、pid 清理。
- `controller`（真实临时 sshd）：导入、`testConnection`、保存/更新/删除、Include 幂等、重复别名回滚；不读写真实 `~/.ssh`。

### 3.2 编排 E2E 覆盖

`verification/e2e.mjs` 使用真实 `tests/rig` sshd 和 fake DSH CLI：

1. 直连 rig 成功；
2. 9 条 RPC 路由全部挂载；
3. `snapshot` 返回导入主机；
4. 导入主机 `testConnection` 返回 `DSH_TEST_OK`；
5. 托管主机 save → update → test → delete；
6. `Include` + 托管片段幂等；
7. overlay 含 4 个官方 SSH 行并禁用本地执行 provider；
8. fake CLI 实例启动、日志 token 脱敏、停止；
9. 错误 content-type / 不存在主机返回安全错误。

## 4. 本地完整官方 SSH 链路（手工）

2026-10-20 在测试 sshd rig 上执行了完整的 `RemoteSshController.openHost`：

1. 临时把受管理 Include 加入真实 `~/.ssh/config`，记录原文件并在结束后还原；
2. 保存一台指向 rig 的托管主机；
3. `openHost({allowInstall:true})` 安装远端 helper `@deepseek-ai/dsh-ssh@0.2.1-rc.2`；
4. 本地 `dsh-remote` profile 安装 4 个官方 SSH 包；
5. 生成 overlay 并启动独立 Web 实例；
6. 快照进入 `running`，`openUrl` 返回的 URL `fetch(...,{redirect:'manual'})` 得到 **303**；
7. 再次验证 `inheritDesktopSettings: true` 时同样进入 `running`；
8. 停止实例并还原 `~/.ssh/config`，确认无插件 Include 残留。

该链路证明了 helper 安装、profile、overlay、官方 provider 激活、窗口启动和 URL 鉴权都可工作。它是**本机 rig 充当远端**，不等同于真实第三方主机网络/权限/发行版差异。

## 5. 真实远端工作区与文件引用（2026-10-21 23:35）

在 `MyOracleCloud-dsh`（Oracle ARM64，远端 Node v24.15.0）上启动隔离 DSH home 的实际远端窗口，并用 Playwright 检查：

- 侧栏工作区显示 `xyzhuanjian`，不再是桌面本机项目列表；
- `fileReferences/list` 返回远端 home 的目录项（`Work`、`monitor_report.md` 等），不再报 `working-directory: directory does not exist`；
- 输入 `@Work/` 返回远端 `Work/axonhub`（该目录只存在于远端）；
- 远端 helper 已安装并完成哈希校验，文件/进程 provider 激活。

随后用 `verification/live-e2e.mjs --alias MyOracleCloud-dsh --version 0.2.1-rc.2` 走**插件控制器的真实打开流程**：`checking → preparing-runtime → starting → running`，`openUrl` 返回权威 URL，`fetch(...,{redirect:'manual'})` 得到 **303**，随后脚本停止实例并删除临时 home。证明控制器已经正确接入隔离 home、远端 profile 和 overlay。最终桌面入口仍需重启后确认。

## 6. GUI 冒烟（临时 profile）

在 `/tmp/rssh-ui-w5UooH` 独立 DSH home + `ui-test` profile 启动 Web，用 Playwright 验证：

- 侧栏出现 `aria-label="远程 SSH"`；
- 主面板显示设置、托管/导入分组；
- 添加主机、编辑显示名、删除成功，无 page error；
- 高级字段保存后 `hosts.json`/`ssh_config` 正确，再次编辑保持原值；
- helper 未安装时打开主机先显示安装确认（真实路径/命令），取消不发 RPC；
- 测试连接失败时错误信息可见。

随后在**包含桌面 profile 全部 bundle 的临时组合**（`desktop-verify`，独立 DSH home）中重复了同一轮冒烟：侧栏入口、空主机列表、添加/编辑/删除、`remoteHelperRoot` 与 `strictHostKeyChecking` 回填、`hosts.json`/`ssh_config` 写入均通过，无 page error。该组合使用临时 `dataDir`/`sshConfigPath`，不触碰真实 `~/.ssh`。

打开流程还做了两项定向验证：

- 用一个已安装 helper 的 imported 主机点击「打开」，客户端先执行 `doctor`（不安装；会确保远端工作目录存在），确认 helper 已安装后启动远端窗口；
- 用一个自定义 `helperRoot`（远端不存在）的主机点击「打开」，客户端先执行 `doctor`，识别到 `missing` 后显示安装确认；对话框中的真实路径为 `/tmp/.../0.2.1-rc.2/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js`，取消后没有发送安装 RPC。

测试 Web 已停止；临时 profile 不参与生产。

## 7. 已知限制与未验证项

1. **helper 安装与桌面入口未在最终桌面进程里复测**：真实远端 helper 已安装并被 `live-e2e` 使用，但“插件对话框安装 helper”与重启后的桌面入口仍需用户确认；`verification/live-e2e.mjs` 提供只读检查与 `--yes` 安装两条路径。
2. **桌面 profile 已写入但尚未重启**：`~/.dsh/profiles/desktop/package.json` 已加入 `link:` 依赖和 bundle，`pnpm install` 成功；需要重启桌面 Host 才会加载侧栏入口和本轮隔离/文件引用修复。
3. **远端 GUI 功能不完整**：`@` 引用与目录选择器已改为远端文件系统（第三轮）；workspace changes、open-in-app、spill、skill filesystem、文件 watch、PTC 等仍受官方 provider/本地工作区语义限制，详见 README 和 `docs/architecture.md`。
4. **本地镜像副作用**：默认 `mirrorWorkspace: true` 会在本机创建与远端同路径目录，用于绕过 realpath 校验；不可创建时仅标记可选失败。
5. **单实例约束**：官方 `dsh-ssh` 在一个 composition 中是单例，一台远端窗口只能服务一台主机。
6. **平台**：当前只验证 Linux 本机；macOS 未实测，Windows 客户端不支持。
7. **真实主机 helper 安装有远端副作用**：会在远端写 helper 目录并执行 npm；默认流程必须显式确认。

## 8. 复现

```bash
cd /work/Repos/github/dsh-plugin-remote-ssh
npm test
node verification/static-check.mjs
node verification/client-audit.mjs
node verification/docs-audit.mjs
node verification/e2e.mjs
```

可选真实主机检查（默认只读；`--yes` 才会安装 helper）：

```bash
node verification/live-e2e.mjs --alias <ssh-alias> --version 0.2.1-rc.2
node verification/live-e2e.mjs --alias <ssh-alias> --yes --version 0.2.1-rc.2
```

所有静态/编排检查只使用临时目录和 rig，不修改用户 `~/.ssh` 或 `~/.dsh` 数据。
## 9. 第三轮增量验证（2026-10-22）

验证对象：远程窗口远端目录选择器、主界面「远程工作区」面板、会话深链（含复用窗口）。

| 检查 | 命令 | 结果 | 证据 |
| --- | --- | --- | --- |
| 单元 + 集成测试 | `npm test` | **84/84 通过** | 本轮 `node --test` 输出 |
| Bundle/清单/语法 | `node verification/static-check.mjs` | **11/11 通过** | `verification/out/static-check.{json,txt}` |
| Client 契约 | `node verification/client-audit.mjs` | **10/10 通过**（10 endpoints、213 locale keys、双面板/双前缀） | `verification/out/client-audit.{json,txt}` |
| 文档一致性 | `node verification/docs-audit.mjs` | **11/11 通过**（23 modules、10 endpoints） | `verification/out/docs-audit.{json,txt}` |
| 编排 E2E | `node verification/e2e.mjs` | **10/10 通过** | `verification/out/e2e.{json,txt}` |
| 真实远端窗口 UI | `node verification/live-remote-window.mjs --alias MyOracleCloud-dsh --version 0.2.1-rc.2` | **通过** | `verification/out/live-remote-window.png` |

### 9.1 真实远端窗口联调覆盖

脚本通过控制器打开用户真实的 `MyOracleCloud-dsh` 远端窗口，再用本机 headless Chromium 的 DevTools 协议断言：

1. 窗口 `checking → starting → running`，带 token 的 URL 可正常进入 SPA；
2. 首次打开即定位到请求的会话（`localStorage['dsh.sessions.current'].sessionId` 匹配 `session-c853a673-...`）；
3. 在实例已运行、`openHost` 返回 `reused:true` 时再次点击另一个会话，窗口通过 follow-up claim 完成切换；
4. 远程窗口「添加工作区」对话框列出远端 home 中只存在于 SSH 主机的临时目录 `rssh-live-*`（本机不存在），证明浏览的是远端文件系统。

脚本结束会停止实例并删除远端临时目录；截图保留在 `verification/out/live-remote-window.png`。

另外用一个隔离 `DSH_HOME` + 临时 profile 启动第二个 Web GUI（加载本轮插件代码，数据目录仍指向真实的 `~/.dsh/remote-ssh`，只读），用同一套 DevTools 协议点开侧栏「远程工作区」：面板正确渲染 1 台主机、1 个工作区、2 个会话（含空白会话弱化），截图 `verification/out/live-workspace-panel.png`。这验证了第二侧栏入口与 RPC 在真实 GUI 中可用。

### 9.2 环境适配

本机 `/etc/ssh/ssh_config.d` 文件属主不是 root，OpenSSH 客户端在不带 `-F` 时会直接报 `Bad owner or permissions`。`tests/rig/lib.mjs` 的 ssh 客户端参数加入 `-F /dev/null`（rig 本来就应忽略用户/系统配置），其余产品代码未因此修改。

## 10. 混合模式（同一窗口）补充验证（2026-10-23）

本轮把远端工作区接入**当前桌面窗口**：bundle patch 禁用基础 `subprocess` / `sandbox` / `fs-sandbox`，由插件新增的 `lib/execution-router.js` 重新提供这三个服务；本地世界仍挂官方本地 provider，远端世界按主机挂载官方 SSH provider。新增 `lib/mixed-registry.js`（镜像登记）和 `lib/mixed-runtime.js`（私有模块树），RPC 增至 13 个。

### 10.1 自动化检查

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 单元 + 集成 | `npm test` | **98/98 通过**（新增 14 个混合登记表/路由器用例） |
| 静态检查 | `npm run verify:static` | **11/11 通过** |
| 客户端审计 | `npm run verify:client` | **10/10 通过** |
| 文档审计 | `npm run verify:docs` | **11/11 通过** |
| 编排 E2E | `npm run verify:e2e` | **10/10 通过** |

### 10.2 完整组合 + 真实主机联调

用临时 `DSH_HOME`（profile 符号链接到已安装的 `desktop-audit`，数据目录临时复制 `hosts.json`/`ssh_config`，不触碰用户数据）在进程内调用官方 `runProfile` 启动**真实 Host 组合**，然后：

1. 确认 router 接管后 `fs`、`subprocess`、`sandbox` 都存在；本地文件读写、`bwrap` confine、本地 Bash spawn 正常。
2. 通过真实 Connection Fetch 路由调用 `registerMixedWorkspace`，对 `MyOracleCloud-dsh` 的 `/home/xyzhuanjian` 登记成功，返回镜像路径。
3. 经路由器读取镜像路径下的 `.bashrc`（3839 字节）、列举 38 个目录项；`processPath` 显示 `/home/xyzhuanjian/.bashrc`。
4. 同一进程内本地文件仍读到原内容，证明远端世界没有污染本地路由。
5. 在远端会话 cwd 下 spawn `uname -n`：得到 `instance-20260420-2200`，本机为 `ArchLinux`，证明确实执行在 SSH 主机；远端 sandbox confine 的 workspaceRoot 也被映射为远端路径。
6. `mixedWorkspaces` 返回该主机 `connected:true`；`removeMixedWorkspace` 正常移除登记。

### 10.3 真实 GUI 点击链路

同一 Host 启动 Web 服务后，用 headless Chromium 的 DevTools 协议进入真实 SPA：

1. 点击侧栏「远程工作区」，面板渲染主机行与「在此窗口打开」按钮，无错误横幅。
2. 点击按钮后，Host 登记镜像工作区；浏览器端 `workspaces.create` + `rename` + `uiWorkspace.openWorkspace` 成功导航，面板被会话视图替换。
3. 临时 home 的 `storages/workspace.json` 中出现两条工作区：默认工作区，以及 `path=<mixed/mounts/...>`、`title=MyOracleCloud-dsh` 的镜像工作区；当前会话记录在该镜像工作区的 `sessionIds` 中。
4. 导航前会话与导航后会话 id 不同，说明不是复用默认工作区会话。

该脚本只写临时 `DSH_HOME` 与临时数据目录，退出时停止 Host 并清理；没有修改真实 `~/.dsh` 或远端文件。

### 10.4 本轮结论

混合模式的主链路（RPC 登记 → SSH 世界 → 路由 → 普通 Workspace → 当前窗口导航 → 远端读写/执行）已在真实组合、真实 SSH 主机和真实 GUI 中跑通。已知限制见 `docs/architecture.md` 7.2 与 README：内容搜索仍用本地 ripgrep，`@` 候选按本地镜像扫描，LSP/open-in-app/spill 仍按本机实现；需要完整远端语义时继续使用独立远端窗口。
