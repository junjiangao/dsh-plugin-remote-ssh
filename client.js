/**
 * Browser half of `@junjiangao/dsh-plugin-remote-ssh`: the **Remote SSH** entry
 * in the sidebar and the host-management panel it opens in the main column.
 *
 * The panel lists managed hosts and the hosts imported from `~/.ssh/config`,
 * creates/edits/deletes managed hosts, probes connectivity, installs the remote
 * helper, and starts/stops the official `dsh-ssh` remote-execution Web instance
 * before opening its authenticated URL in a new tab.
 *
 * Only `require('react')` is used: no Harness Client package is loaded as a
 * module and every control is written here against `--dsw-*` theme tokens.
 * @module @junjiangao/dsh-plugin-remote-ssh/client
 */
window.__ModuleLoader__.load({
	id: '@junjiangao/dsh-plugin-remote-ssh',
	factory(require) {
		const React = require('react');
		const h = React.createElement;

		/** Locale namespace owned by this panel. */
		const NS = 'remoteSsh';
		/** Id shared by the remote-SSH sidebar entry and the main panel it opens. */
		const PANEL_ID = 'remote-ssh';
		/** Id of the second sidebar entry: the remote-workspace overview panel. */
		const WORKSPACE_PANEL_ID = 'remote-workspace';
		/** Prefix for every class name the remote-SSH panel injects. */
		const PREFIX = 'rssh';
		/** Prefix for every class name the remote-workspace panel injects. */
		const WORKSPACE_PREFIX = 'rsw';
		/** Stylesheet element id, so a second mount cannot duplicate the sheet. */
		const STYLE_ID = 'remote-ssh-client-style';
		/** Stylesheet element id of the remote-workspace panel. */
		const WORKSPACE_STYLE_ID = 'remote-workspace-client-style';
		/** Host Connection RPC channel and endpoint prefix. */
		const API_CHANNEL = '/api';
		const API_PREFIX = 'remote-ssh';
		/** Snapshot poll interval while the remote-SSH panel is visible. */
		const POLL_MS = 2000;
		/** Remote-workspace poll interval while that panel is visible (one disk scan). */
		const WORKSPACE_POLL_MS = 5000;
		/** How often an opened remote window is polled before its URL is fetched. */
		const OPEN_POLL_MS = 1000;
		/** Deadline for one open action to reach the running phase. */
		const OPEN_TIMEOUT_MS = 180_000;
		/** Managed alias format enforced by the Host and mirrored here. */
		const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
		/** Accepted `StrictHostKeyChecking` values, in OpenSSH spelling. */
		const STRICT_MODES = ['accept-new', 'yes', 'no'];
		/** Numeric text fields validated as non-negative integers. */
		const NUMBER_KEYS = ['serverAliveInterval', 'serverAliveCountMax', 'connectionAttempts', 'connectTimeout'];
		/** Advanced fields that make the advanced section start expanded. */
		const ADVANCED_KEYS = ['proxyCommand', 'remoteHelperRoot', 'serverAliveInterval', 'serverAliveCountMax', 'userKnownHostsFile', 'connectionAttempts', 'connectTimeout'];
		/** Instance phase → locale key. */
		const PHASE_KEYS = {
			idle: 'phaseIdle',
			checking: 'phaseChecking',
			'installing-helper': 'phaseInstallingHelper',
			'preparing-runtime': 'phasePreparingRuntime',
			starting: 'phaseStarting',
			running: 'phaseRunning',
			stopping: 'phaseStopping',
			failed: 'phaseFailed',
		};
		/** Helper status → locale key. */
		const HELPER_KEYS = {
			unknown: 'helperUnknown',
			installed: 'helperInstalled',
			missing: 'helperMissing',
			installing: 'helperInstalling',
			mismatch: 'helperMismatch',
		};

		/** Bilingual copy. Every visible string in the panel comes from here. */
		const zh = {
			panel: '远程 SSH',
			pageTitle: '远程 SSH',
			pageSubtitle: '管理 SSH 主机，并在浏览器中打开官方 dsh-ssh 的远端工作窗口。',
			searchLabel: '搜索主机',
			searchPlaceholder: '按别名、显示名或主机名筛选',
			refresh: '刷新',
			refreshing: '刷新中…',
			addHost: '添加主机',
			loading: '正在读取主机…',
			loadFailed: '无法读取主机列表：{message}',
			staleData: '当前显示的是上一次成功读取的数据。',
			settingsConfig: 'ssh 配置：{path}',
			settingsProfile: 'Profile：{profile}',
			settingsData: '数据目录：{path}',
			lastUpdated: '最后更新：{time}',
			platformUnsupported: '当前平台（{platform}）不支持远端工作窗口；主机管理仍然可用。',
			unknownPlatform: '未知平台',
			profileNotReady: '远端 Profile「{profile}」尚未准备完成；打开远程窗口前请先完成准备。',
			warningsTitle: '宿主提示',
			groupManaged: '托管主机（{count}）',
			groupManagedHint: '由本插件写入托管的 ssh_config，可编辑和删除。',
			groupSshConfig: '来自 ~/.ssh/config（{count}）',
			groupSshConfigHint: '只读条目；可复制为托管主机后再修改。',
			emptyManaged: '还没有托管主机。',
			emptySshConfig: '~/.ssh/config 中没有可导入的主机。',
			emptyTitle: '还没有任何主机',
			emptyBody: '添加一台主机，或从 ~/.ssh/config 复制已有的 SSH 别名。',
			emptyNoMatch: '没有匹配的主机。',
			emptyNoMatchHint: '清空搜索框以显示全部主机。',
			sourceManaged: '托管',
			sourceSshConfig: 'ssh_config',
			helperUnknown: 'helper 未知',
			helperInstalled: 'helper 已安装',
			helperInstalledVersion: 'helper 已安装 {version}',
			helperMismatch: 'helper 版本不匹配',
			helperMismatchVersion: 'helper 版本不匹配（{version}）',
			helperMissing: 'helper 未安装',
			helperInstalling: 'helper 安装中',
			phaseIdle: '未运行',
			phaseChecking: '检查中',
			phaseInstallingHelper: '安装服务',
			phasePreparingRuntime: '准备运行时',
			phaseStarting: '启动中',
			phaseRunning: '运行中',
			phaseStopping: '停止中',
			phaseFailed: '失败',
			shadowed: '已被托管条目覆盖',
			shadowedCopyDisabled: '该条目已被托管条目覆盖，无法复制。',
			instanceError: '实例错误：{message}',
			open: '打开',
			openAgain: '再次打开',
			openWindow: '打开远程窗口',
			stop: '停止',
			test: '测试',
			testing: '测试中…',
			edit: '编辑',
			remove: '删除',
			copyManaged: '复制为托管',
			details: '查看详情',
			hideDetails: '收起详情',
			redactedHint: '日志已脱敏显示。',
			testTitle: '连接测试',
			testOk: '连接成功，耗时 {ms} ms',
			testFailed: '连接失败，耗时 {ms} ms',
			testStderr: 'stderr 摘要',
			testOutputEmpty: '（无输出）',
			logTitle: '运行日志（尾部）',
			doctorTitle: '主机诊断',
			doctorPending: '正在诊断…',
			doctorReady: '诊断通过',
			doctorNotReady: '诊断未通过',
			doctorOptional: '可选',
			runningPanelTitle: '远端实例运行中',
			runningPanelBody: '远程窗口地址只保存在当前页面内存中，不会写入磁盘。',
			openResultTitle: '远程窗口已就绪（{alias}）',
			openResultBody: '若浏览器没有自动打开新标签页，请使用下面的链接。',
			openResultCopy: '复制链接',
			openResultCopied: '已复制',
			openResultClose: '关闭',
			noticeOpenStarted: '已开始启动远端实例，请稍候。',
			noticeHelperInstalled: '远端 helper 安装完成（版本 {version}）。',
			noticeStopped: '已停止远端实例。',
			noticeSaved: '主机已保存。',
			noticeDeleted: '主机已删除。',
			dialogClose: '关闭对话框',
			cancel: '取消',
			save: '保存',
			saving: '正在保存…',
			createTitle: '添加主机',
			editTitle: '编辑主机',
			copyTitle: '复制为托管主机',
			copyHint: '已从 ~/.ssh/config 预填；保存后会成为托管主机。',
			advancedExpand: '展开高级选项',
			advancedCollapse: '收起高级选项',
			aliasLabel: '别名',
			aliasHint: '必填；1–64 位字母、数字、点、下划线或连字符，例如 prod-web',
			displayNameLabel: '显示名',
			displayNameHint: '可选；仅用于界面显示',
			hostnameLabel: '主机名',
			hostnameHint: '必填；主机名或 IP',
			userLabel: '用户',
			userHint: '可选；默认使用 ssh 配置或当前用户名',
			portLabel: '端口',
			portHint: '可选；1–65535，留空使用 OpenSSH 默认值',
			identityFileLabel: '私钥文件',
			identityFileHint: '可选；写入 ssh_config 的 IdentityFile 私钥路径',
			proxyJumpLabel: '跳板机',
			proxyJumpHint: '可选；写入 ssh_config 的 ProxyJump，格式 [user@]host[:port]',
			remoteWorkspaceLabel: '远端工作目录',
			remoteWorkspaceHint: '默认 ~；远端工作窗口打开的工作目录',
			descriptionLabel: '备注',
			descriptionHint: '可选；显示在主机列表中',
			proxyCommandLabel: 'ProxyCommand',
			proxyCommandHint: '可选；自定义 ProxyCommand',
			remoteHelperRootLabel: '远端 helper 目录',
			remoteHelperRootHint: '可选；远端 helper 的安装根目录，留空使用默认 ~/.dsh-remote-ssh/helper。',
			identitiesOnlyLabel: '仅使用指定密钥（IdentitiesOnly）',
			identitiesOnlyHint: '只尝试 IdentityFile 指定的密钥',
			forwardAgentLabel: '转发 ssh-agent（ForwardAgent）',
			forwardAgentHint: '允许远端使用本机 ssh-agent',
			serverAliveIntervalLabel: 'ServerAliveInterval',
			serverAliveIntervalHint: '心跳间隔（秒），留空则不设置',
			serverAliveCountMaxLabel: 'ServerAliveCountMax',
			serverAliveCountMaxHint: '心跳失败次数上限，留空则不设置',
			strictHostKeyCheckingLabel: 'StrictHostKeyChecking',
			strictHostKeyCheckingHint: '主机密钥校验策略',
			strictAcceptNew: 'accept-new（首次自动接受）',
			strictYes: 'yes（严格校验）',
			strictNo: 'no（不校验）',
			userKnownHostsFileLabel: 'UserKnownHostsFile',
			userKnownHostsFileHint: '可选；known_hosts 路径',
			connectionAttemptsLabel: 'ConnectionAttempts',
			connectionAttemptsHint: '连接尝试次数，留空则不设置',
			connectTimeoutLabel: 'ConnectTimeout',
			connectTimeoutHint: '连接超时（秒），留空则不设置',
			extraOptionsLabel: '额外 SSH 选项',
			extraOptionsHint: '逐项传入；选项名为空的行会被忽略。',
			extraOptionKey: '选项名',
			extraOptionValue: '值',
			extraOptionAdd: '添加选项',
			extraOptionRemove: '删除该选项',
			'errors.aliasRequired': '别名不能为空。',
			'errors.aliasFormat': '别名需以字母或数字开头，只能包含字母、数字、点、下划线、连字符，最长 64 位。',
			'errors.aliasDuplicate': '该别名已被其他托管主机使用。',
			'errors.hostnameRequired': '主机名不能为空。',
			'errors.portInteger': '端口必须是整数。',
			'errors.portRange': '端口必须在 1 到 65535 之间。',
			'errors.numberInvalid': '该字段必须是非负整数。',
			'errors.remoteHelperRootPath': '远端 helper 目录必须是绝对路径或以 ~ 开头。',
			'errors.optionKeyRequired': '填写了值的额外选项必须填写选项名。',
			'errors.saveFailed': '保存失败：{message}',
			'errors.unknown': '操作失败：{message}',
			'errors.rpcFailed': 'RPC 调用失败。',
			'errors.openUrlEmpty': '宿主没有返回可打开的远程窗口地址。',
			'errors.copyFailed': '复制失败，请手动选择链接复制。',
			dismiss: '关闭提示',
			deleteTitle: '删除托管主机',
			deleteBody: '确定要删除主机「{alias}」吗？',
			deleteDetail: '该主机会从托管的 ssh_config 中移除，正在运行的实例也会停止。此操作不可撤销。',
			deleteConfirm: '删除',
			deletePending: '正在删除…',
			installTitle: '安装远端服务',
			installBody: '为了在该主机上打开远程工作窗口，需要先在远端安装官方 dsh-ssh helper。',
			installMismatch: '远端 helper 版本不匹配：已安装 {version}，需要 {expected}。继续将重新安装。',
			installPathLabel: '远端 helper 路径',
			installCommandLabel: '将执行的 npm 命令',
			installVersionValue: '版本：{version}',
			installConfirm: '安装并继续',
			installPending: '正在安装…',
			installDetail: '安装过程可能需要数分钟，期间请保持页面打开。',
			crash: '此面板遇到错误，主机配置未受影响。',
			workspacePanel: '远程工作区',
			workspacePageTitle: '远程工作区',
			workspacePageSubtitle: '按远程机和工作区查看远端会话；点击会话即可打开远程窗口并定位到该会话。',
			workspaceRefresh: '刷新',
			workspaceRefreshing: '刷新中…',
			workspaceLoading: '正在读取远程工作区…',
			workspaceLoadFailed: '无法读取远程工作区：{message}',
			workspaceStaleData: '当前显示的是上一次成功读取的数据。',
			workspaceLastUpdated: '最后更新：{time}',
			workspaceHostCount: '托管主机：{count} 台',
			workspaceEmptyTitle: '还没有远程工作区',
			workspaceEmptyBody: '先在「远程 SSH」面板添加并打开一台主机；远端窗口产生的会话会显示在这里。',
			workspaceEmptyHost: '这台主机还没有远端会话；打开远程窗口并创建会话后会显示在这里。',
			workspaceEmptyWorkspace: '该工作区还没有会话。',
			workspaceOpenHost: '打开窗口',
			workspaceOpenHere: '在此窗口打开',
			workspaceOpenHerePending: '正在打开…',
			workspaceOpenHereHint: '把远端目录映射到当前窗口；本地与远端会话可同时使用。',
			workspaceOpenHereDone: '已在当前窗口打开 {path}；本地与远端会话现在可以同时使用。',
			workspaceStopHost: '停止',
			workspaceRunning: '运行中',
			workspaceOpening: '启动中…',
			workspaceStopping: '停止中…',
			workspaceSessionOpen: '打开会话',
			workspaceSessionBlank: '空白会话',
			workspaceSessionUntitled: '未命名会话',
			workspaceSessionPinned: '已置顶',
			workspaceSessionArchived: '已归档',
			workspaceSessionsCount: '共 {count} 个会话',
			workspaceSessionCount: '{count} 个会话',
			workspaceRemoteDir: '远端工作目录：{path}',
			workspaceOpenStarted: '正在启动 {host} 的远程窗口，请稍候…',
			workspaceOpened: '远程窗口已就绪（{host}）。',
			workspaceStopped: '已停止 {host} 的远程窗口。',
			workspaceWarnings: '宿主提示',
			workspaceOpenResultTitle: '远程窗口已就绪（{host}）',
			workspaceOpenResultBody: '若浏览器没有自动打开新标签页，请使用下面的链接。',
			workspaceOpenResultClose: '关闭',
			workspaceHelperHint: '远端 helper 未安装或不可用；请到「远程 SSH」面板打开该主机并确认安装。',
			workspaceOpenTimeout: '等待远程窗口启动超时，请稍后重试。',
			workspaceHostMissing: '主机已不存在或已被删除。',
			workspaceInstanceError: '实例错误：{message}',
			workspaceTimeJustNow: '刚刚',
			workspaceTimeMinutes: '{count} 分钟前',
			workspaceTimeHours: '{count} 小时前',
			workspaceTimeDays: '{count} 天前',
		};
		const en = {
			panel: 'Remote SSH',
			pageTitle: 'Remote SSH',
			pageSubtitle: 'Manage SSH hosts and open an official dsh-ssh remote work window in this browser.',
			searchLabel: 'Search hosts',
			searchPlaceholder: 'Filter by alias, display name, or hostname',
			refresh: 'Refresh',
			refreshing: 'Refreshing…',
			addHost: 'Add host',
			loading: 'Loading hosts…',
			loadFailed: 'Could not load hosts: {message}',
			staleData: 'Showing the last successful snapshot.',
			settingsConfig: 'ssh config: {path}',
			settingsProfile: 'Profile: {profile}',
			settingsData: 'Data directory: {path}',
			lastUpdated: 'Last updated: {time}',
			platformUnsupported: 'This platform ({platform}) does not support remote work windows; host management still works.',
			unknownPlatform: 'unknown platform',
			profileNotReady: 'The remote profile "{profile}" is not ready yet; finish preparing it before opening a remote window.',
			warningsTitle: 'Host notices',
			groupManaged: 'Managed hosts ({count})',
			groupManagedHint: 'Written into the managed ssh_config by this plugin; editable and removable.',
			groupSshConfig: 'From ~/.ssh/config ({count})',
			groupSshConfigHint: 'Read-only entries; copy one to a managed host before editing.',
			emptyManaged: 'No managed hosts yet.',
			emptySshConfig: 'No importable hosts in ~/.ssh/config.',
			emptyTitle: 'No hosts yet',
			emptyBody: 'Add a host, or copy an existing SSH alias from ~/.ssh/config.',
			emptyNoMatch: 'No matching hosts.',
			emptyNoMatchHint: 'Clear the search box to show every host.',
			sourceManaged: 'managed',
			sourceSshConfig: 'ssh_config',
			helperUnknown: 'helper unknown',
			helperInstalled: 'helper installed',
			helperInstalledVersion: 'helper {version}',
			helperMismatch: 'helper version mismatch',
			helperMismatchVersion: 'helper version mismatch ({version})',
			helperMissing: 'helper missing',
			helperInstalling: 'helper installing',
			phaseIdle: 'idle',
			phaseChecking: 'checking',
			phaseInstallingHelper: 'installing helper',
			phasePreparingRuntime: 'preparing runtime',
			phaseStarting: 'starting',
			phaseRunning: 'running',
			phaseStopping: 'stopping',
			phaseFailed: 'failed',
			shadowed: 'overridden by managed entry',
			shadowedCopyDisabled: 'This entry is overridden by a managed entry and cannot be copied.',
			instanceError: 'Instance error: {message}',
			open: 'Open',
			openAgain: 'Open again',
			openWindow: 'Open remote window',
			stop: 'Stop',
			test: 'Test',
			testing: 'Testing…',
			edit: 'Edit',
			remove: 'Delete',
			copyManaged: 'Copy as managed',
			details: 'Show details',
			hideDetails: 'Hide details',
			redactedHint: 'Logs are shown with secrets redacted.',
			testTitle: 'Connection test',
			testOk: 'Connected in {ms} ms',
			testFailed: 'Connection failed after {ms} ms',
			testStderr: 'stderr tail',
			testOutputEmpty: '(no output)',
			logTitle: 'Runtime log (tail)',
			doctorTitle: 'Host diagnostics',
			doctorPending: 'Running diagnostics…',
			doctorReady: 'Diagnostics passed',
			doctorNotReady: 'Diagnostics failed',
			doctorOptional: 'optional',
			runningPanelTitle: 'Remote instance is running',
			runningPanelBody: 'The remote window URL stays in this page memory only and is never written to disk.',
			openResultTitle: 'Remote window ready ({alias})',
			openResultBody: 'If the browser did not open a new tab automatically, use the link below.',
			openResultCopy: 'Copy link',
			openResultCopied: 'Copied',
			openResultClose: 'Close',
			noticeOpenStarted: 'Starting the remote instance; this may take a moment.',
			noticeHelperInstalled: 'The remote helper is installed (version {version}).',
			noticeStopped: 'The remote instance has stopped.',
			noticeSaved: 'Host saved.',
			noticeDeleted: 'Host deleted.',
			dialogClose: 'Close dialog',
			cancel: 'Cancel',
			save: 'Save',
			saving: 'Saving…',
			createTitle: 'Add host',
			editTitle: 'Edit host',
			copyTitle: 'Copy as managed host',
			copyHint: 'Prefilled from ~/.ssh/config; saving creates a managed host.',
			advancedExpand: 'Expand advanced options',
			advancedCollapse: 'Collapse advanced options',
			aliasLabel: 'Alias',
			aliasHint: 'Required; 1–64 letters, digits, dots, underscores, or hyphens, for example prod-web',
			displayNameLabel: 'Display name',
			displayNameHint: 'Optional; shown only in this panel',
			hostnameLabel: 'Hostname',
			hostnameHint: 'Required; hostname or IP address',
			userLabel: 'User',
			userHint: 'Optional; defaults to the ssh config or current user',
			portLabel: 'Port',
			portHint: 'Optional; 1–65535, empty uses the OpenSSH default',
			identityFileLabel: 'Identity file',
			identityFileHint: 'Optional; IdentityFile key path written to ssh_config',
			proxyJumpLabel: 'Proxy jump',
			proxyJumpHint: 'Optional; ProxyJump written to ssh_config, [user@]host[:port]',
			remoteWorkspaceLabel: 'Remote workspace',
			remoteWorkspaceHint: 'Defaults to ~; the directory the remote window opens',
			descriptionLabel: 'Description',
			descriptionHint: 'Optional; shown in the host list',
			proxyCommandLabel: 'ProxyCommand',
			proxyCommandHint: 'Optional; custom ProxyCommand',
			remoteHelperRootLabel: 'Remote helper directory',
			remoteHelperRootHint: 'Optional; installation root of the remote helper. Leave empty to use ~/.dsh-remote-ssh/helper.',
			identitiesOnlyLabel: 'IdentitiesOnly',
			identitiesOnlyHint: 'Only try keys named by IdentityFile',
			forwardAgentLabel: 'ForwardAgent',
			forwardAgentHint: 'Let the remote side use the local ssh-agent',
			serverAliveIntervalLabel: 'ServerAliveInterval',
			serverAliveIntervalHint: 'Keepalive interval in seconds; empty leaves it unset',
			serverAliveCountMaxLabel: 'ServerAliveCountMax',
			serverAliveCountMaxHint: 'Keepalive failure limit; empty leaves it unset',
			strictHostKeyCheckingLabel: 'StrictHostKeyChecking',
			strictHostKeyCheckingHint: 'Host-key verification policy',
			strictAcceptNew: 'accept-new (accept first, reject changes)',
			strictYes: 'yes (strict)',
			strictNo: 'no (skip verification)',
			userKnownHostsFileLabel: 'UserKnownHostsFile',
			userKnownHostsFileHint: 'Optional; known_hosts path',
			connectionAttemptsLabel: 'ConnectionAttempts',
			connectionAttemptsHint: 'Number of connection attempts; empty leaves it unset',
			connectTimeoutLabel: 'ConnectTimeout',
			connectTimeoutHint: 'Connection timeout in seconds; empty leaves it unset',
			extraOptionsLabel: 'Extra SSH options',
			extraOptionsHint: 'Passed through one by one; rows without an option name are ignored.',
			extraOptionKey: 'Option',
			extraOptionValue: 'Value',
			extraOptionAdd: 'Add option',
			extraOptionRemove: 'Remove this option',
			'errors.aliasRequired': 'Alias must not be empty.',
			'errors.aliasFormat': 'Alias must start with a letter or digit and use only letters, digits, dots, underscores, or hyphens (max 64).',
			'errors.aliasDuplicate': 'Another managed host already uses that alias.',
			'errors.hostnameRequired': 'Hostname must not be empty.',
			'errors.portInteger': 'Port must be an integer.',
			'errors.portRange': 'Port must be between 1 and 65535.',
			'errors.numberInvalid': 'This field must be a non-negative integer.',
			'errors.remoteHelperRootPath': 'The remote helper directory must be absolute or start with ~.',
			'errors.optionKeyRequired': 'An extra option with a value needs an option name.',
			'errors.saveFailed': 'Save failed: {message}',
			'errors.unknown': 'Operation failed: {message}',
			'errors.rpcFailed': 'RPC call failed.',
			'errors.openUrlEmpty': 'The Host did not return an openable remote window URL.',
			'errors.copyFailed': 'Copy failed; select the link manually.',
			dismiss: 'Dismiss',
			deleteTitle: 'Delete managed host',
			deleteBody: 'Delete host "{alias}"?',
			deleteDetail: 'This removes the host from the managed ssh_config and stops its running instance. It cannot be undone.',
			deleteConfirm: 'Delete',
			deletePending: 'Deleting…',
			installTitle: 'Install remote service',
			installBody: 'Opening a remote work window on this host requires installing the official dsh-ssh helper on the remote side.',
			installMismatch: 'The remote helper version does not match: installed {version}, expected {expected}. Continuing reinstalls it.',
			installPathLabel: 'Remote helper path',
			installCommandLabel: 'npm command to run',
			installVersionValue: 'Version: {version}',
			installConfirm: 'Install and continue',
			installPending: 'Installing…',
			installDetail: 'Installation may take several minutes; keep this page open.',
			crash: 'This panel hit an error; your host configuration is unchanged.',
			workspacePanel: 'Remote workspaces',
			workspacePageTitle: 'Remote workspaces',
			workspacePageSubtitle: 'Browse remote sessions by machine and workspace; click a session to open its remote window at that session.',
			workspaceRefresh: 'Refresh',
			workspaceRefreshing: 'Refreshing…',
			workspaceLoading: 'Loading remote workspaces…',
			workspaceLoadFailed: 'Could not load remote workspaces: {message}',
			workspaceStaleData: 'Showing the last successful scan.',
			workspaceLastUpdated: 'Last scanned: {time}',
			workspaceHostCount: 'Managed hosts: {count}',
			workspaceEmptyTitle: 'No remote workspaces yet',
			workspaceEmptyBody: 'Add and open a host in the Remote SSH panel; sessions created there appear here.',
			workspaceEmptyHost: 'No remote sessions yet; open a remote window and start a session to see it here.',
			workspaceEmptyWorkspace: 'This workspace has no sessions yet.',
			workspaceOpenHost: 'Open window',
			workspaceOpenHere: 'Open in this window',
			workspaceOpenHerePending: 'Opening…',
			workspaceOpenHereHint: 'Mount the remote directory into this window so local and remote sessions coexist.',
			workspaceOpenHereDone: 'Opened {path} in this window; local and remote sessions now coexist.',
			workspaceStopHost: 'Stop',
			workspaceRunning: 'running',
			workspaceOpening: 'Starting…',
			workspaceStopping: 'Stopping…',
			workspaceSessionOpen: 'Open session',
			workspaceSessionBlank: 'Blank session',
			workspaceSessionUntitled: 'Untitled session',
			workspaceSessionPinned: 'Pinned',
			workspaceSessionArchived: 'Archived',
			workspaceSessionsCount: '{count} sessions',
			workspaceSessionCount: '{count}',
			workspaceRemoteDir: 'Remote workspace: {path}',
			workspaceOpenStarted: 'Starting the remote window for {host}; this may take a moment…',
			workspaceOpened: 'Remote window ready ({host}).',
			workspaceStopped: 'Stopped the remote window for {host}.',
			workspaceWarnings: 'Host notices',
			workspaceOpenResultTitle: 'Remote window ready ({host})',
			workspaceOpenResultBody: 'If the browser did not open a new tab automatically, use the link below.',
			workspaceOpenResultClose: 'Close',
			workspaceHelperHint: 'The remote helper is missing or unavailable; open this host in the Remote SSH panel and install it.',
			workspaceOpenTimeout: 'Timed out waiting for the remote window to start; try again later.',
			workspaceHostMissing: 'The host no longer exists or was deleted.',
			workspaceInstanceError: 'Instance error: {message}',
			workspaceTimeJustNow: 'just now',
			workspaceTimeMinutes: '{count} min ago',
			workspaceTimeHours: '{count} h ago',
			workspaceTimeDays: '{count} d ago',
		};

		/**
		 * Panel stylesheet. Colours, radii, type, and states come from the host's
		 * `--dsw-*` tokens only, so the panel follows light and dark themes.
		 */
		const CSS = `
.${PREFIX}_page{display:flex;flex-direction:column;gap:20px;box-sizing:border-box;height:100%;overflow:auto;padding:0 clamp(20px,4vw,40px) 40px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.${PREFIX}_header{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:16px;padding-top:28px}
.${PREFIX}_heading{display:flex;flex-direction:column;gap:4px;min-width:0}
.${PREFIX}_title{margin:0;font-size:20px;font-weight:500;line-height:28px}
.${PREFIX}_subtitle{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;overflow-wrap:anywhere}
.${PREFIX}_meta{display:flex;flex-wrap:wrap;gap:2px 14px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.${PREFIX}_metaCode{font-family:var(--ds-font-family-code);color:var(--dsw-alias-label-secondary)}
.${PREFIX}_toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.${PREFIX}_searchWrap{width:min(260px,60vw)}
.${PREFIX}_banners{display:flex;flex-direction:column;gap:8px}
.${PREFIX}_banner{display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.${PREFIX}_bannerInfo{color:var(--dsw-alias-label-secondary)}
.${PREFIX}_bannerWarn{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 35%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-tertiary) 55%,transparent);color:var(--dsw-alias-state-warn-label)}
.${PREFIX}_bannerError{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);color:var(--dsw-alias-state-error-primary)}
.${PREFIX}_bannerSuccess{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 30%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 8%,transparent);color:var(--dsw-alias-label-primary)}
.${PREFIX}_bannerText{flex:1;min-width:0}
.${PREFIX}_bannerList{margin:4px 0 0;padding-left:18px}
.${PREFIX}_bannerDismiss{align-self:flex-start;flex:none;border:none;background:0 0;color:inherit;font:inherit;font-size:16px;line-height:18px;padding:0 2px;cursor:pointer;opacity:.7}
.${PREFIX}_bannerDismiss:hover{opacity:1}
.${PREFIX}_openResult{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border:.5px solid color-mix(in srgb,var(--dsw-alias-state-success-primary) 30%,transparent);border-radius:var(--dsw-radius-md);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 7%,transparent)}
.${PREFIX}_openResultMain{display:flex;flex-direction:column;gap:2px;min-width:0}
.${PREFIX}_openResultTitle{font-size:13px;font-weight:500;line-height:20px}
.${PREFIX}_openResultBody{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.${PREFIX}_openResultActions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.${PREFIX}_link{color:var(--dsw-alias-state-business-primary);font-size:13px;line-height:20px;text-decoration:underline;overflow-wrap:anywhere}
.${PREFIX}_link:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:1px}
.${PREFIX}_group{display:flex;flex-direction:column;gap:8px}
.${PREFIX}_groupHeader{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 12px}
.${PREFIX}_groupTitle{margin:0;font-size:14px;font-weight:500;line-height:20px}
.${PREFIX}_groupHint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.${PREFIX}_hostList{display:flex;flex-direction:column;gap:8px}
.${PREFIX}_hostRow{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:12px;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1)}
.${PREFIX}_hostMain{display:flex;flex-direction:column;gap:4px;flex:1;min-width:min(100%,280px)}
.${PREFIX}_hostTitle{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-width:0}
.${PREFIX}_hostName{font-size:14px;font-weight:500;line-height:20px;overflow-wrap:anywhere}
.${PREFIX}_hostAlias{color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code);font-size:12px;line-height:18px}
.${PREFIX}_hostTarget{color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.${PREFIX}_hostDescription,.${PREFIX}_hostMessage{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.${PREFIX}_hostError{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.${PREFIX}_hostActions{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:6px;flex:none}
.${PREFIX}_badge{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 6px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;white-space:nowrap}
.${PREFIX}_badgeBusiness{color:var(--dsw-alias-state-business-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 25%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 8%,transparent)}
.${PREFIX}_badgeSuccess{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 25%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 8%,transparent)}
.${PREFIX}_badgeWarn{color:var(--dsw-alias-state-warn-label);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 30%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 8%,transparent)}
.${PREFIX}_badgeError{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 30%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}
.${PREFIX}_rowPanel{display:flex;flex-direction:column;gap:8px;margin-top:4px;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2)}
.${PREFIX}_rowPanelTitle{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:12px;font-weight:500;line-height:18px}
.${PREFIX}_rowPanelBody{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.${PREFIX}_log{margin:0;max-height:220px;overflow:auto;padding:8px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code);font-size:12px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere}
.${PREFIX}_checks{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none}
.${PREFIX}_check{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px;font-size:12px;line-height:18px}
.${PREFIX}_checkOk{color:var(--dsw-alias-state-success-primary)}
.${PREFIX}_checkFail{color:var(--dsw-alias-state-error-primary)}
.${PREFIX}_checkDetail{color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.${PREFIX}_empty{display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding:24px;border:.5px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-2)}
.${PREFIX}_emptyTitle{margin:0;font-size:14px;font-weight:500;line-height:20px}
.${PREFIX}_emptyBody{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.${PREFIX}_emptyRow{padding:10px 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.${PREFIX}_btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 12px;border:none;border-radius:var(--dsw-radius-md);background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;white-space:nowrap;cursor:pointer}
.${PREFIX}_btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.${PREFIX}_btn:disabled{opacity:.5;cursor:not-allowed}
.${PREFIX}_btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:1px}
.${PREFIX}_btnPrimary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.${PREFIX}_btnPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.${PREFIX}_btnSecondary{border:.5px solid var(--dsw-alias-border-l3)}
.${PREFIX}_btnDanger{color:var(--dsw-alias-state-error-primary);border:.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 30%,transparent)}
.${PREFIX}_btnDanger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}
.${PREFIX}_btnSmall{height:26px;padding:0 8px;font-size:12px}
.${PREFIX}_spinner{display:inline-block;width:12px;height:12px;border:2px solid var(--dsw-alias-border-l3);border-top-color:var(--dsw-alias-state-business-primary);border-radius:50%;animation:${PREFIX}_spin .8s linear infinite}
.${PREFIX}_loadingRow{display:inline-flex;align-items:center;gap:8px}
@keyframes ${PREFIX}_spin{to{transform:rotate(360deg)}}
.${PREFIX}_glyph{display:block;color:var(--dsw-alias-label-secondary)}
.${PREFIX}_glyphActive{color:var(--dsw-alias-label-primary)}
.${PREFIX}_overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:flex-start;justify-content:center;padding:24px;overflow:auto;background:color-mix(in srgb,var(--dsw-alias-bg-overlay) 72%,transparent)}
.${PREFIX}_dialog{display:flex;flex-direction:column;width:min(720px,100%);max-height:calc(100vh - 48px);margin:auto 0;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);box-shadow:0 12px 32px color-mix(in srgb,var(--dsw-alias-bg-overlay) 55%,transparent)}
.${PREFIX}_dialogSmall{width:min(520px,100%)}
.${PREFIX}_dialogHeader{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:16px 18px 8px}
.${PREFIX}_dialogTitle{margin:0;font-size:16px;font-weight:500;line-height:24px}
.${PREFIX}_dialogClose{flex:none;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:none;border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:18px;line-height:20px;cursor:pointer}
.${PREFIX}_dialogClose:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.${PREFIX}_dialogClose:disabled{opacity:.5;cursor:not-allowed}
.${PREFIX}_dialogClose:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:1px}
.${PREFIX}_dialogBody{display:flex;flex-direction:column;gap:14px;padding:0 18px 16px;overflow:auto}
.${PREFIX}_dialogFooter{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px;padding:12px 18px 16px;border-top:.5px solid var(--dsw-alias-border-l2)}
.${PREFIX}_dialogFooterSpacer{flex:1}
.${PREFIX}_grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.${PREFIX}_field{display:flex;flex-direction:column;gap:4px;min-width:0}
.${PREFIX}_fieldWide{grid-column:1/-1}
.${PREFIX}_label{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.${PREFIX}_input{box-sizing:border-box;width:100%;height:32px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px}
.${PREFIX}_input:focus{border-color:var(--dsw-alias-state-business-primary);outline:none}
.${PREFIX}_input::placeholder{color:var(--dsw-alias-label-dimmed)}
.${PREFIX}_input:disabled{opacity:.6;cursor:not-allowed}
.${PREFIX}_inputInvalid{border-color:var(--dsw-alias-state-error-primary)}
.${PREFIX}_hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.${PREFIX}_fieldError{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.${PREFIX}_selectWrap{position:relative;display:flex;align-items:center}
.${PREFIX}_select{box-sizing:border-box;appearance:none;width:100%;height:32px;padding:0 30px 0 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer}
.${PREFIX}_select:focus{border-color:var(--dsw-alias-state-business-primary);outline:none}
.${PREFIX}_select:disabled{opacity:.6;cursor:not-allowed}
.${PREFIX}_selectIcon{position:absolute;right:10px;color:var(--dsw-alias-label-tertiary);pointer-events:none}
.${PREFIX}_checkRow{display:flex;align-items:flex-start;gap:8px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;cursor:pointer}
.${PREFIX}_checkbox{width:14px;height:14px;margin:2px 0 0;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer}
.${PREFIX}_checkText{display:flex;flex-direction:column;gap:2px;min-width:0}
.${PREFIX}_advancedToggle{align-self:flex-start;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 8px;border:none;border-radius:var(--dsw-radius-md);background:0 0;color:var(--dsw-alias-state-business-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer}
.${PREFIX}_advancedToggle:hover{background:var(--dsw-alias-interactive-bg-hover)}
.${PREFIX}_advancedToggle:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:1px}
.${PREFIX}_advanced{display:flex;flex-direction:column;gap:12px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2)}
.${PREFIX}_extraList{display:flex;flex-direction:column;gap:8px}
.${PREFIX}_extraRow{display:flex;align-items:flex-start;gap:8px}
.${PREFIX}_extraKey{flex:1;min-width:0}
.${PREFIX}_extraValue{flex:2;min-width:0}
.${PREFIX}_testBox{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2)}
.${PREFIX}_testStatusOk{color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:18px}
.${PREFIX}_testStatusFail{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.${PREFIX}_code{font-family:var(--ds-font-family-code);font-size:12px;line-height:18px;overflow-wrap:anywhere;padding:6px 8px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.${PREFIX}_helperInfo{display:flex;flex-direction:column;gap:6px}
.${PREFIX}_helperLabel{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.${PREFIX}_confirmText{font-size:13px;line-height:20px;overflow-wrap:anywhere}
.${PREFIX}_confirmDetail{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.${PREFIX}_formError{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.${PREFIX}_srOnly{position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (max-width:640px){.${PREFIX}_page{padding:0 16px 32px}.${PREFIX}_header{padding-top:20px}.${PREFIX}_hostActions{justify-content:flex-start}}
@media (prefers-reduced-motion:reduce){.${PREFIX}_spinner{animation:none}}
`;

		/**
		 * Remote-workspace panel stylesheet. Layout classes use the panel's own
		 * prefix; shared primitives (badges, buttons, banners) keep the `rssh`
		 * classes they are rendered with. Colours still come from `--dsw-*` only.
		 */
		const WORKSPACE_CSS = `
.${WORKSPACE_PREFIX}_page{display:flex;flex-direction:column;gap:18px;box-sizing:border-box;height:100%;overflow:auto;padding:0 clamp(20px,4vw,40px) 40px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.${WORKSPACE_PREFIX}_header{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:16px;padding-top:28px}
.${WORKSPACE_PREFIX}_heading{display:flex;flex-direction:column;gap:4px;min-width:0}
.${WORKSPACE_PREFIX}_title{margin:0;font-size:20px;font-weight:500;line-height:28px}
.${WORKSPACE_PREFIX}_subtitle{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;overflow-wrap:anywhere}
.${WORKSPACE_PREFIX}_meta{display:flex;flex-wrap:wrap;gap:2px 14px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.${WORKSPACE_PREFIX}_toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.${WORKSPACE_PREFIX}_banners{display:flex;flex-direction:column;gap:8px}
.${WORKSPACE_PREFIX}_bannerList{margin:4px 0 0;padding-left:18px}
.${WORKSPACE_PREFIX}_loadingRow{display:inline-flex;align-items:center;gap:8px}
.${WORKSPACE_PREFIX}_empty{display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding:24px;border:.5px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-2)}
.${WORKSPACE_PREFIX}_emptyTitle{margin:0;font-size:14px;font-weight:500;line-height:20px}
.${WORKSPACE_PREFIX}_emptyBody{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.${WORKSPACE_PREFIX}_emptyRow{padding:10px 2px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.${WORKSPACE_PREFIX}_hosts{display:flex;flex-direction:column;gap:12px}
.${WORKSPACE_PREFIX}_host{display:flex;flex-direction:column;gap:10px;padding:14px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1)}
.${WORKSPACE_PREFIX}_hostHeader{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:10px}
.${WORKSPACE_PREFIX}_hostHeading{display:flex;flex-direction:column;gap:4px;flex:1;min-width:min(100%,260px)}
.${WORKSPACE_PREFIX}_hostTitle{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-width:0}
.${WORKSPACE_PREFIX}_hostName{font-size:15px;font-weight:500;line-height:22px;overflow-wrap:anywhere}
.${WORKSPACE_PREFIX}_hostAlias{color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code);font-size:12px;line-height:18px}
.${WORKSPACE_PREFIX}_hostCount{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.${WORKSPACE_PREFIX}_hostMeta{color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.${WORKSPACE_PREFIX}_hostActions{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:6px;flex:none}
.${WORKSPACE_PREFIX}_hostMessage{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.${WORKSPACE_PREFIX}_hostError{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.${WORKSPACE_PREFIX}_workspaces{display:flex;flex-direction:column;gap:8px}
.${WORKSPACE_PREFIX}_workspace{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2)}
.${WORKSPACE_PREFIX}_workspaceHeader{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 10px;min-width:0}
.${WORKSPACE_PREFIX}_workspaceTitle{font-size:13px;font-weight:500;line-height:20px;overflow-wrap:anywhere}
.${WORKSPACE_PREFIX}_workspacePath{color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.${WORKSPACE_PREFIX}_workspaceCount{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.${WORKSPACE_PREFIX}_workspaceAction{margin-left:auto;display:inline-flex;align-items:center}
.${WORKSPACE_PREFIX}_sessionList{display:flex;flex-direction:column;gap:2px}
.${WORKSPACE_PREFIX}_session{box-sizing:border-box;display:flex;flex-wrap:wrap;align-items:center;gap:8px;width:100%;padding:7px 8px;border:none;border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer}
.${WORKSPACE_PREFIX}_session:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.${WORKSPACE_PREFIX}_session:disabled{opacity:.5;cursor:not-allowed}
.${WORKSPACE_PREFIX}_session:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:1px}
.${WORKSPACE_PREFIX}_sessionBlank{color:var(--dsw-alias-label-tertiary)}
.${WORKSPACE_PREFIX}_sessionDot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-business-primary)}
.${WORKSPACE_PREFIX}_sessionBlank .${WORKSPACE_PREFIX}_sessionDot{background:var(--dsw-alias-label-dimmed)}
.${WORKSPACE_PREFIX}_sessionTitle{flex:1;min-width:min(100%,160px);overflow-wrap:anywhere}
.${WORKSPACE_PREFIX}_sessionTime{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.${WORKSPACE_PREFIX}_sessionOpen{flex:none;color:var(--dsw-alias-state-business-primary);font-size:12px;line-height:18px;opacity:0;transition:opacity .15s var(--ds-ease-in-out)}
.${WORKSPACE_PREFIX}_session:is(:hover,:focus-visible) .${WORKSPACE_PREFIX}_sessionOpen{opacity:1}
@media (max-width:640px){.${WORKSPACE_PREFIX}_page{padding:0 16px 32px}.${WORKSPACE_PREFIX}_header{padding-top:20px}.${WORKSPACE_PREFIX}_hostActions{justify-content:flex-start}}
@media (prefers-reduced-motion:reduce){.${WORKSPACE_PREFIX}_sessionOpen{transition:none}}
`;

		/** Join class names under this panel's prefix. */
		function cx(...names) {
			const kept = [];
			for (const name of names) {
				if (typeof name === 'string' && name.length > 0) kept.push(`${PREFIX}_${name}`);
			}
			return kept.join(' ');
		}

		/** Join class names under the remote-workspace panel's prefix. */
		function cxw(...names) {
			const kept = [];
			for (const name of names) {
				if (typeof name === 'string' && name.length > 0) kept.push(`${WORKSPACE_PREFIX}_${name}`);
			}
			return kept.join(' ');
		}

		/** Read one value as a string, never throwing. */
		function str(value) {
			return typeof value === 'string' ? value : '';
		}

		/** Read a finite number or `undefined`. */
		function num(value) {
			return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
		}

		/** Read a plain object, or `undefined`. */
		function asObject(value) {
			return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
		}

		/** Human-readable message from an arbitrary thrown value. */
		function messageOf(error) {
			if (error instanceof Error && typeof error.message === 'string') return error.message;
			const record = asObject(error);
			if (record !== undefined && typeof record.message === 'string') return record.message;
			return typeof error === 'string' ? error : '';
		}

		/** Replace `{name}` placeholders in a localized string. */
		function fill(template, values) {
			return String(template).replace(/\{(\w+)\}/g, (match, key) => {
				const value = values[key];
				return value === undefined || value === null ? match : String(value);
			});
		}

		/** Localize one key; a broken or missing locale service degrades to the key. */
		function text(t, key, values) {
			let resolved;
			try {
				resolved = typeof t === 'function' ? t(key) : undefined;
			} catch (_localeFailure) {
				resolved = undefined;
			}
			const value = typeof resolved === 'string' && resolved.length > 0 ? resolved : key;
			return values === undefined ? value : fill(value, values);
		}

		/**
		 * Redact secrets that may appear in Host error text and logs. The Host is
		 * expected to redact already; this is a second, local safety net so a token
		 * can never render in the browser panel.
		 */
		function redact(value) {
			let output = String(value === undefined || value === null ? '' : value);
			if (output.length === 0) return output;
			output = output.replace(/(Bearer\s+)[A-Za-z0-9._~+\/=-]+/gi, '$1***');
			output = output.replace(/([?&](?:token|access_token|auth|key)=)[^&\s]+/gi, '$1***');
			output = output.replace(/((?:token|access[_-]?token|password|passwd|secret|api[_-]?key|authorization)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi, '$1***');
			output = output.replace(/((?:--?token|--password|--secret)\s+)[^\s]+/gi, '$1***');
			return output;
		}

		/** Keep the last `limit` characters of a string. */
		function tail(value, limit) {
			const input = str(value);
			return input.length <= limit ? input : `…${input.slice(input.length - limit)}`;
		}

		/** Stable DOM id fragment for a host id. */
		function domId(value) {
			return String(value === undefined || value === null ? '' : value).replace(/[^A-Za-z0-9_-]/g, '_');
		}

		/** The `user@hostname:port` target shown for one host. */
		function targetOf(host) {
			const record = asObject(host);
			if (record === undefined) return '';
			const hostname = str(record.hostname);
			const user = str(record.user);
			const base = user.length > 0 && hostname.length > 0 ? `${user}@${hostname}` : hostname;
			const port = num(record.port);
			return port === undefined ? base : `${base}:${port}`;
		}

		/** The alias or display name used as a row title. */
		function aliasOf(host) {
			const record = asObject(host);
			if (record === undefined) return '';
			return str(record.alias) || str(record.id);
		}

		/** The stable in-panel key of one host: its id, falling back to the alias. */
		function keyOf(host) {
			const record = asObject(host);
			if (record === undefined) return '';
			return str(record.id) || str(record.alias);
		}

		/** Normalize the helper block of one HostView. */
		function helperOf(host) {
			const record = asObject(host);
			const helper = record === undefined ? undefined : asObject(record.helper);
			const status = helper !== undefined && typeof helper.status === 'string' ? helper.status : 'unknown';
			return {
				status,
				version: helper === undefined ? '' : str(helper.version),
				path: helper === undefined ? '' : str(helper.path),
				expectedVersion: helper === undefined ? '' : str(helper.expectedVersion),
				installCommand: helper === undefined ? '' : str(helper.installCommand),
			};
		}

		/** Normalize the instance block of one HostView. */
		function instanceOf(host) {
			const record = asObject(host);
			const instance = record === undefined ? undefined : asObject(record.instance);
			const phase = instance !== undefined && typeof instance.phase === 'string' ? instance.phase : 'idle';
			return {
				phase,
				running: instance !== undefined && (instance.running === true || phase === 'running'),
				message: instance === undefined ? '' : str(instance.message),
				error: instance === undefined ? '' : str(instance.error),
				logTail: instance === undefined ? '' : str(instance.logTail),
			};
		}

		/** Locale label for an instance phase, falling back to the raw phase. */
		function phaseLabel(t, phase) {
			const key = PHASE_KEYS[phase];
			return key === undefined ? phase : text(t, key);
		}

		/** Locale label for a helper status, falling back to the raw status. */
		function helperLabel(t, helper) {
			if (helper.status === 'installed' && helper.version.length > 0) {
				return text(t, 'helperInstalledVersion', { version: helper.version });
			}
			if (helper.status === 'mismatch') {
				return helper.version.length > 0
					? text(t, 'helperMismatchVersion', { version: helper.version })
					: text(t, 'helperMismatch');
			}
			const key = HELPER_KEYS[helper.status];
			return key === undefined ? helper.status : text(t, key);
		}

		/** Tone class for a helper badge. */
		function helperTone(status) {
			if (status === 'installed') return 'badgeSuccess';
			if (status === 'missing') return 'badgeWarn';
			if (status === 'mismatch') return 'badgeWarn';
			if (status === 'installing') return 'badgeBusiness';
			return 'badge';
		}

		/** Tone class for a phase badge. */
		function phaseTone(phase) {
			if (phase === 'running') return 'badgeSuccess';
			if (phase === 'failed') return 'badgeError';
			if (phase === 'idle') return 'badge';
			return 'badgeBusiness';
		}

		/**
		 * Derive the helper path, version, and npm command shown in the install
		 * confirmation. Prefer values the Host already computed for this host, and
		 * fall back to the snapshot settings only when an optional field is absent.
		 */
		function helperInfo(host, settings, details) {
			const helper = helperOf(host);
			const record = asObject(settings) === undefined ? {} : settings;
			const recordHost = asObject(host) === undefined ? {} : host;
			const extra = asObject(details) === undefined ? {} : details;
			const root = str(recordHost.remoteHelperRoot) || '~/.dsh-remote-ssh/helper';
			const version = helper.expectedVersion || str(extra.requiredVersion) || str(record.runtimeVersion);
			const packageName = str(record.helperPackage) || '@deepseek-ai/dsh-ssh';
			const installRoot = version.length > 0 ? `${root.replace(/\/+$/, '')}/${version}` : root.replace(/\/+$/, '');
			let command = str(extra.installCommand) || helper.installCommand;
			if (command.length === 0 && version.length > 0) {
				command = `npm install --prefix ${installRoot} --no-audit --no-fund --omit=dev ${packageName}@${version}`;
			}
			return {
				path: str(extra.path) || (helper.path.length > 0 ? helper.path : installRoot),
				command,
				version,
			};
		}

		/** Format a Host timestamp for the header. */
		function formatTime(value) {
			if (typeof value !== 'string' || value.length === 0) return '';
			const date = new Date(value);
			if (Number.isNaN(date.getTime())) return '';
			return date.toLocaleTimeString();
		}

		/** Name shown for one remote-workspace host entry. */
		function hostLabel(host) {
			const record = asObject(host);
			if (record === undefined) return '';
			return str(record.displayName) || str(record.alias) || str(record.id);
		}

		/** Normalize the phase/running pair of one remote-workspace host entry. */
		function hostRuntime(host) {
			const record = asObject(host);
			const phase = record !== undefined && typeof record.phase === 'string' && record.phase.length > 0 ? record.phase : 'idle';
			return { phase, running: record !== undefined && (record.running === true || phase === 'running') };
		}

		/** Short relative time for a session timestamp, localized from this module's copy. */
		function relativeTime(t, value) {
			if (typeof value !== 'string' || value.length === 0) return '';
			const time = Date.parse(value);
			if (Number.isNaN(time)) return '';
			const delta = Date.now() - time;
			if (delta < 60_000) return text(t, 'workspaceTimeJustNow');
			if (delta < 3_600_000) return text(t, 'workspaceTimeMinutes', { count: Math.floor(delta / 60_000) });
			if (delta < 86_400_000) return text(t, 'workspaceTimeHours', { count: Math.floor(delta / 3_600_000) });
			if (delta < 30 * 86_400_000) return text(t, 'workspaceTimeDays', { count: Math.floor(delta / 86_400_000) });
			const date = new Date(time);
			return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString();
		}

		/** Resolve after \`ms\`; used by the open-window poll loop. */
		function sleep(ms) {
			return new Promise((resolve) => window.setTimeout(resolve, ms));
		}

		/** Whether one HostView is managed (editable) rather than imported from ssh_config. */
		function isManagedHost(host) {
			return asObject(host) !== undefined && host.source === 'managed';
		}

		/** Find one host inside a snapshot by id. */
		function pickHost(snapshot, id) {
			const record = asObject(snapshot);
			if (record === undefined || !Array.isArray(record.hosts)) return undefined;
			for (const host of record.hosts) {
				if (asObject(host) !== undefined && host.id === id) return host;
			}
			return undefined;
		}

		/** Copy text through the async clipboard API only (never touches the DOM). */
		async function copyText(value) {
			if (typeof navigator === 'undefined' || navigator.clipboard === undefined || typeof navigator.clipboard.writeText !== 'function') {
				throw new Error('clipboard unavailable');
			}
			await navigator.clipboard.writeText(value);
		}

		/**
		 * Build the browser API wrapper over the authenticated Host Connection RPC.
		 * @param ctx - client plugin context.
		*/
		function createApi(ctx) {
			const call = async (endpoint, payload, signal) => {
				const connection = ctx.get('connection');
				const rpc = connection === undefined || connection === null ? undefined : connection.rpc;
				if (rpc === undefined || rpc === null || typeof rpc.call !== 'function') throw new Error('RPC failed');
				const result = await rpc.call(API_CHANNEL, `${API_PREFIX}/${endpoint}`, payload, signal);
				if (!result || result.ok !== true) {
					const error = asObject(result) === undefined ? undefined : asObject(result.error);
					const failure = new Error(error !== undefined && str(error.message).length > 0 ? str(error.message) : 'RPC failed');
					if (error !== undefined && typeof error.code === 'string') failure.code = error.code;
					if (error !== undefined && error.details !== undefined) failure.details = error.details;
					throw failure;
				}
				return result.value;
			};
			return {
				snapshot: (payload, signal) => call('snapshot', payload || {}, signal),
				remoteWorkspaces: (payload, signal) => call('remoteWorkspaces', payload || {}, signal),
				saveHost: (payload, signal) => call('saveHost', payload, signal),
				deleteHost: (payload, signal) => call('deleteHost', payload, signal),
				testConnection: (payload, signal) => call('testConnection', payload, signal),
				doctor: (payload, signal) => call('doctor', payload, signal),
				installHelper: (payload, signal) => call('installHelper', payload, signal),
				openHost: (payload, signal) => call('openHost', payload, signal),
				openUrl: (payload, signal) => call('openUrl', payload, signal),
				stopHost: (payload, signal) => call('stopHost', payload, signal),
				mixedWorkspaces: (payload, signal) => call('mixedWorkspaces', payload || {}, signal),
				registerMixedWorkspace: (payload, signal) => call('registerMixedWorkspace', payload, signal),
				removeMixedWorkspace: (payload, signal) => call('removeMixedWorkspace', payload, signal),
			};
		}

		/** Inline sidebar glyph: a local terminal linked to a remote host stack. */
		function RemoteSshIcon(props) {
			const size = typeof props.size === 'number' && Number.isFinite(props.size) ? props.size : 16;
			const active = props.active === true;
			return h(
				'svg',
				{
					className: cx('glyph', active ? 'glyphActive' : undefined),
					width: size,
					height: size,
					viewBox: '0 0 24 24',
					fill: 'none',
					'aria-hidden': 'true',
					focusable: 'false',
				},
				h('rect', { x: 2.75, y: 4.75, width: 9.5, height: 8.5, rx: 1.75, stroke: 'currentColor', strokeWidth: 1.5 }),
				h('path', { d: 'M5.5 8l1.75 1.75L5.5 11.5', stroke: 'var(--dsw-alias-state-business-primary)', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }),
				h('path', { d: 'M8.5 11.5h2', stroke: 'var(--dsw-alias-state-business-primary)', strokeWidth: 1.5, strokeLinecap: 'round' }),
				h('path', { d: 'M12.4 9h2.2', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeDasharray: '1.2 1.8' }),
				h('path', { d: 'M14.6 6.9l2.1 2.1-2.1 2.1', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }),
				h('rect', { x: 17, y: 4.9, width: 4.4, height: 3.4, rx: 1.1, stroke: 'currentColor', strokeWidth: 1.4 }),
				h('rect', { x: 17, y: 10.1, width: 4.4, height: 3.4, rx: 1.1, stroke: 'currentColor', strokeWidth: 1.4 }),
				h('circle', { cx: 19.2, cy: 6.6, r: 0.8, fill: 'var(--dsw-alias-state-success-primary)' }),
				h('circle', { cx: 19.2, cy: 11.8, r: 0.8, fill: 'var(--dsw-alias-state-success-primary)' }),
			);
		}

		/** Inline sidebar glyph: stacked remote workspaces with a session list. */
		function RemoteWorkspaceIcon(props) {
			const size = typeof props.size === 'number' && Number.isFinite(props.size) ? props.size : 16;
			const active = props.active === true;
			return h(
				'svg',
				{
					className: cx('glyph', active ? 'glyphActive' : undefined),
					width: size,
					height: size,
					viewBox: '0 0 24 24',
					fill: 'none',
					'aria-hidden': 'true',
					focusable: 'false',
				},
				h('rect', { x: 2.75, y: 3.75, width: 12.5, height: 9.5, rx: 1.75, stroke: 'currentColor', strokeWidth: 1.5 }),
				h('path', { d: 'M6 7.5h5.5', stroke: 'var(--dsw-alias-state-business-primary)', strokeWidth: 1.5, strokeLinecap: 'round' }),
				h('path', { d: 'M6 10.5h3.5', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
				h('circle', { cx: 19, cy: 6.5, r: 0.9, fill: 'var(--dsw-alias-state-success-primary)' }),
				h('path', { d: 'M19 8.2v2.1a1.7 1.7 0 0 1-1.7 1.7H14', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }),
				h('rect', { x: 9.25, y: 16.25, width: 12, height: 4, rx: 1.4, stroke: 'currentColor', strokeWidth: 1.5 }),
				h('path', { d: 'M11.75 18.25h3', stroke: 'var(--dsw-alias-state-business-primary)', strokeWidth: 1.5, strokeLinecap: 'round' }),
				h('circle', { cx: 18.5, cy: 18.25, r: 0.9, fill: 'var(--dsw-alias-state-success-primary)' }),
			);
		}

		/** A busy indicator shown while a request is in flight. */
		function Spinner() {
			return h('span', { className: cx('spinner'), 'aria-hidden': 'true' });
		}

		/** Short status badge. */
		function Badge(props) {
			return h('span', { className: cx('badge', props.tone === undefined ? undefined : props.tone), title: props.title }, props.children);
		}

		/** One status banner with an optional dismiss action. */
		function Banner(props) {
			const tone = props.tone === 'warn' ? 'bannerWarn' : props.tone === 'error' ? 'bannerError' : props.tone === 'success' ? 'bannerSuccess' : 'bannerInfo';
			return h(
				'div',
				{ className: cx('banner', tone), role: props.tone === 'error' ? 'alert' : 'status' },
				h('div', { className: cx('bannerText') }, props.children),
				props.onDismiss === undefined
					? null
					: h(
							'button',
							{ type: 'button', className: cx('bannerDismiss'), onClick: props.onDismiss, 'aria-label': props.dismissLabel || undefined },
							'×',
						),
			);
		}

		/** A button with a pending state that also blocks duplicate clicks. */
		function ActionButton(props) {
			const tone = props.tone === 'primary' ? 'btnPrimary' : props.tone === 'secondary' ? 'btnSecondary' : props.tone === 'danger' ? 'btnDanger' : undefined;
			return h(
				'button',
				{
					type: 'button',
					className: cx('btn', tone, props.small === true ? 'btnSmall' : undefined),
					disabled: props.disabled === true || props.pending === true,
					'aria-busy': props.pending === true ? 'true' : undefined,
					'aria-expanded': props.expanded === undefined ? undefined : props.expanded === true ? 'true' : 'false',
					'aria-controls': props.controls,
					'aria-label': props.ariaLabel,
					title: props.title,
					onClick: props.onClick,
				},
				props.pending === true ? h(Spinner, null) : null,
				h('span', null, props.children),
			);
		}

		/** A labelled form field with hint and error wiring. */
		function FormField(props) {
			return h(
				'div',
				{ className: cx('field', props.wide === true ? 'fieldWide' : undefined) },
				h('label', { className: cx('label'), htmlFor: props.id }, props.label),
				props.children,
				props.error === undefined ? null : h('div', { className: cx('fieldError'), id: `${props.id}-error`, role: 'alert' }, props.error),
				props.hint === undefined ? null : h('div', { className: cx('hint'), id: `${props.id}-hint` }, props.hint),
			);
		}

		/** Compute `aria-describedby` for one field. */
		function describedBy(id, error, hint) {
			const ids = [];
			if (error !== undefined && error.length > 0) ids.push(`${id}-error`);
			if (hint !== undefined && hint.length > 0) ids.push(`${id}-hint`);
			return ids.length === 0 ? undefined : ids.join(' ');
		}

		/** A text input owned by this panel. */
		function TextInput(props) {
			return h('input', {
				id: props.id,
				className: cx('input', props.invalid === true ? 'inputInvalid' : undefined),
				type: typeof props.type === 'string' ? props.type : 'text',
				value: typeof props.value === 'string' ? props.value : '',
				placeholder: typeof props.placeholder === 'string' ? props.placeholder : undefined,
				disabled: props.disabled === true,
				spellCheck: false,
				autoComplete: 'off',
				'aria-invalid': props.invalid === true ? 'true' : undefined,
				'aria-describedby': describedBy(props.id, props.error, props.hint),
				'aria-label': props.ariaLabel,
				ref: props.inputRef,
				onChange: (event) => {
					if (typeof props.onChange === 'function') props.onChange(str(event && event.target ? event.target.value : ''));
				},
			});
		}

		/** The select caret, painted with `currentColor` so it follows the theme. */
		function Chevron() {
			return h(
				'svg',
				{ className: cx('selectIcon'), width: 12, height: 12, viewBox: '0 0 12 12', fill: 'none', 'aria-hidden': 'true' },
				h('path', { d: 'M3 4.5L6 7.5L9 4.5', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }),
			);
		}

		/** One checkbox row with a label and optional hint. */
		function CheckField(props) {
			return h(
				'label',
				{ className: cx('checkRow'), htmlFor: props.id },
				h('input', {
					id: props.id,
					type: 'checkbox',
					className: cx('checkbox'),
					checked: props.checked === true,
					disabled: props.disabled === true,
					onChange: (event) => {
						if (typeof props.onChange === 'function') props.onChange(Boolean(event && event.target && event.target.checked));
					},
				}),
				h(
					'span',
					{ className: cx('checkText') },
					h('span', null, props.label),
					props.hint === undefined ? null : h('span', { className: cx('hint') }, props.hint),
				),
			);
		}

		/**
		 * Accessible modal frame: `role="dialog"`, `aria-modal`, Escape close, initial
		 * focus into the first input, focus restore on close, and a Tab trap.
		 */
		function Modal(props) {
			const boxRef = React.useRef(null);
			const latest = React.useRef(props);
			latest.current = props;
			React.useEffect(() => {
				if (typeof document === 'undefined') return undefined;
				const box = boxRef.current;
				const previous = document.activeElement;
				const firstInput = box === null ? null : box.querySelector('input:not([type="hidden"]), select, textarea');
				const fallback = box === null ? null : box.querySelector('[data-autofocus]') || box.querySelector(`.${PREFIX}_dialogFooter button`);
				const focusTarget = firstInput || fallback || box;
				if (focusTarget !== null && typeof focusTarget.focus === 'function') focusTarget.focus();
				const onKeyDown = (event) => {
					if (!event || typeof event.key !== 'string') return;
					if (event.key === 'Escape') {
						if (latest.current.busy === true) return;
						event.preventDefault();
						event.stopPropagation();
						latest.current.onClose();
						return;
					}
					if (event.key !== 'Tab' || box === null) return;
					const nodes = box.querySelectorAll('input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), a[href]');
					if (nodes.length === 0) return;
					const first = nodes[0];
					const last = nodes[nodes.length - 1];
					if (event.shiftKey && document.activeElement === first) {
						event.preventDefault();
						last.focus();
					} else if (!event.shiftKey && document.activeElement === last) {
						event.preventDefault();
						first.focus();
					}
				};
				document.addEventListener('keydown', onKeyDown, true);
				return () => {
					document.removeEventListener('keydown', onKeyDown, true);
					if (previous !== null && typeof previous.focus === 'function' && previous.isConnected) previous.focus();
				};
			}, []);
			const titleId = props.titleId;
			const small = props.small === true;
			return h(
				'div',
				{
					className: cx('overlay'),
					onMouseDown: (event) => {
						if (event.target !== event.currentTarget || latest.current.busy === true) return;
						latest.current.onClose();
					},
				},
				h(
					'div',
					{
						className: cx('dialog', small ? 'dialogSmall' : undefined),
						role: 'dialog',
						'aria-modal': 'true',
						'aria-labelledby': titleId,
						tabIndex: -1,
						ref: boxRef,
					},
					h(
						'div',
						{ className: cx('dialogHeader') },
						h('h2', { className: cx('dialogTitle'), id: titleId }, props.title),
						h(
							'button',
							{
								type: 'button',
								className: cx('dialogClose'),
								disabled: props.busy === true,
								onClick: props.onClose,
								'aria-label': props.closeLabel,
							},
							'×',
						),
					),
					h('div', { className: cx('dialogBody') }, props.children),
					props.footer === undefined ? null : h('div', { className: cx('dialogFooter') }, props.footer),
				),
			);
		}

		/** Draft state for one host form. */
		function emptyDraft() {
			return {
				alias: '',
				displayName: '',
				hostname: '',
				user: '',
				port: '',
				identityFile: '',
				proxyJump: '',
				remoteWorkspace: '~',
				description: '',
				proxyCommand: '',
				remoteHelperRoot: '',
				identitiesOnly: false,
				forwardAgent: false,
				serverAliveInterval: '',
				serverAliveCountMax: '',
				strictHostKeyChecking: 'accept-new',
				userKnownHostsFile: '',
				connectionAttempts: '',
				connectTimeout: '',
				extraOptions: [],
				/**
				 * Advanced fields the HostView actually exposed. A HostView may omit
				 * them; keeping unknown fields out of the draft stops an edit from
				 * silently clearing a value the browser never received.
				 */
				advancedKnown: {
					proxyCommand: false,
					remoteHelperRoot: false,
					identitiesOnly: false,
					forwardAgent: false,
					serverAliveInterval: false,
					serverAliveCountMax: false,
					strictHostKeyChecking: false,
					userKnownHostsFile: false,
					connectionAttempts: false,
					connectTimeout: false,
					extraOptions: false,
				},
			};
		}

		/** Format a numeric field value as text. */
		function numberText(value) {
			return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
		}

		/** Build a form draft from an existing HostView. */
		function draftFromHost(host, mode) {
			const draft = emptyDraft();
			const source = asObject(host);
			if (source === undefined) return draft;
			const alias = str(source.alias);
			const extra = Array.isArray(source.extraOptions) ? source.extraOptions : [];
			const known = { ...draft.advancedKnown };
			known.proxyCommand = typeof source.proxyCommand === 'string';
			known.remoteHelperRoot = typeof source.remoteHelperRoot === 'string';
			known.identitiesOnly = typeof source.identitiesOnly === 'boolean';
			known.forwardAgent = typeof source.forwardAgent === 'boolean';
			known.serverAliveInterval = typeof source.serverAliveInterval === 'number';
			known.serverAliveCountMax = typeof source.serverAliveCountMax === 'number';
			known.strictHostKeyChecking = STRICT_MODES.includes(source.strictHostKeyChecking);
			known.userKnownHostsFile = typeof source.userKnownHostsFile === 'string';
			known.connectionAttempts = typeof source.connectionAttempts === 'number';
			known.connectTimeout = typeof source.connectTimeout === 'number';
			known.extraOptions = Array.isArray(source.extraOptions);
			return {
				...draft,
				alias: mode === 'copy' ? (alias.length === 0 ? '' : `${alias}-dsh`) : alias,
				displayName: str(source.displayName),
				hostname: str(source.hostname),
				user: str(source.user),
				port: numberText(source.port),
				identityFile: str(source.identityFile),
				proxyJump: str(source.proxyJump),
				remoteWorkspace: str(source.remoteWorkspace) || '~',
				description: str(source.description),
				proxyCommand: str(source.proxyCommand),
				remoteHelperRoot: str(source.remoteHelperRoot),
				identitiesOnly: source.identitiesOnly === true,
				forwardAgent: source.forwardAgent === true,
				serverAliveInterval: numberText(source.serverAliveInterval),
				serverAliveCountMax: numberText(source.serverAliveCountMax),
				strictHostKeyChecking: STRICT_MODES.includes(source.strictHostKeyChecking) ? source.strictHostKeyChecking : 'accept-new',
				userKnownHostsFile: str(source.userKnownHostsFile),
				connectionAttempts: numberText(source.connectionAttempts),
				connectTimeout: numberText(source.connectTimeout),
				extraOptions: extra
					.filter((entry) => asObject(entry) !== undefined)
					.map((entry) => ({ key: str(entry.key), value: str(entry.value) })),
				advancedKnown: known,
			};
		}

		/** Whether an edit form should start with the advanced section open. */
		function hasAdvancedValues(host) {
			const draft = draftFromHost(host, 'edit');
			for (const key of ADVANCED_KEYS) {
				if (draft[key].length > 0) return true;
			}
			return draft.identitiesOnly || draft.forwardAgent || draft.extraOptions.length > 0;
		}

		/** Validate one form draft; returns a map of field name → locale key. */
		function validateDraft(draft, existingAliases) {
			const errors = {};
			const alias = draft.alias.trim();
			if (alias.length === 0) errors.alias = 'errors.aliasRequired';
			else if (!ALIAS_RE.test(alias)) errors.alias = 'errors.aliasFormat';
			else if (existingAliases.includes(alias)) errors.alias = 'errors.aliasDuplicate';
			if (draft.hostname.trim().length === 0) errors.hostname = 'errors.hostnameRequired';
			const portText = draft.port.trim();
			if (portText.length > 0) {
				if (!/^\d+$/.test(portText)) errors.port = 'errors.portInteger';
				else {
					const port = Number(portText);
					if (!(port >= 1 && port <= 65535)) errors.port = 'errors.portRange';
				}
			}
			for (const key of NUMBER_KEYS) {
				const value = draft[key].trim();
				if (value.length > 0 && !/^\d+$/.test(value)) errors[key] = 'errors.numberInvalid';
			}
			const helperRoot = draft.remoteHelperRoot.trim();
			if (helperRoot.length > 0 && !helperRoot.startsWith('~') && !helperRoot.startsWith('/')) {
				errors.remoteHelperRoot = 'errors.remoteHelperRootPath';
			}
			for (const row of draft.extraOptions) {
				if (row.key.trim().length === 0 && row.value.trim().length > 0) {
					errors.extraOptions = 'errors.optionKeyRequired';
					break;
				}
			}
			return errors;
		}

		/** Whether a validation result contains an advanced-section problem. */
		function hasAdvancedError(errors) {
			for (const key of ADVANCED_KEYS) {
				if (errors[key] !== undefined) return true;
			}
			return errors.extraOptions !== undefined;
		}

		/** Project a form draft into the HostDraft payload accepted by saveHost/testConnection. */
		function toHostDraft(draft, id) {
			const known = asObject(draft.advancedKnown) === undefined ? {} : draft.advancedKnown;
			const host = {
				alias: draft.alias.trim(),
				hostname: draft.hostname.trim(),
				remoteWorkspace: draft.remoteWorkspace.trim() || '~',
			};
			if (typeof id === 'string' && id.length > 0) host.id = id;
			const put = (key) => {
				const value = draft[key].trim();
				if (value.length > 0) host[key] = value;
			};
			put('displayName');
			put('user');
			put('identityFile');
			put('proxyJump');
			put('description');
			put('proxyCommand');
			put('remoteHelperRoot');
			put('userKnownHostsFile');
			const putNumber = (key) => {
				const value = draft[key].trim();
				if (value.length > 0) host[key] = Number(value);
			};
			putNumber('port');
			putNumber('serverAliveInterval');
			putNumber('serverAliveCountMax');
			putNumber('connectionAttempts');
			putNumber('connectTimeout');
			const booleanKeys = ['identitiesOnly', 'forwardAgent'];
			for (const key of booleanKeys) {
				// An unknown advanced flag is only written when the user turned it on;
				// otherwise the Host keeps the value this browser never received.
				if (known[key] === true || draft[key] === true) host[key] = draft[key] === true;
			}
			if (known.strictHostKeyChecking === true || draft.strictHostKeyChecking !== 'accept-new') {
				host.strictHostKeyChecking = STRICT_MODES.includes(draft.strictHostKeyChecking) ? draft.strictHostKeyChecking : 'accept-new';
			}
			const extraOptions = draft.extraOptions
				.map((row) => ({ key: row.key.trim(), value: row.value.trim() }))
				.filter((row) => row.key.length > 0);
			if (known.extraOptions === true || extraOptions.length > 0) host.extraOptions = extraOptions;
			return host;
		}

		/** Render the stderr tail of a connection-test result. */
		function TestResultBox(props) {
			const t = props.t;
			const result = asObject(props.result) === undefined ? {} : props.result;
			const ok = result.ok === true;
			const duration = num(result.durationMs);
			const stderr = redact(tail(result.stderr, 2000));
			const error = redact(str(result.error));
			return h(
				'div',
				{ className: cx('rowPanel') },
				h('div', { className: cx('rowPanelTitle') }, text(t, 'testTitle')),
				h('div', { className: ok ? cx('testStatusOk') : cx('testStatusFail') }, text(t, ok ? 'testOk' : 'testFailed', { ms: duration === undefined ? 0 : Math.round(duration) })),
				error.length > 0 ? h('div', { className: cx('hostError') }, error) : null,
				h('div', { className: cx('rowPanelBody') }, text(t, 'testStderr')),
				h('pre', { className: cx('log') }, stderr.length > 0 ? stderr : text(t, 'testOutputEmpty')),
			);
		}

		/** Render doctor checks below the runtime log. */
		function DoctorChecks(props) {
			const t = props.t;
			const result = asObject(props.result);
			if (result === undefined) return null;
			const checks = Array.isArray(result.checks) ? result.checks.filter((entry) => asObject(entry) !== undefined) : [];
			const ready = result.ready === true;
			return h(
				'div',
				{ className: cx('rowPanel') },
				h('div', { className: cx('rowPanelTitle') }, text(t, 'doctorTitle')),
				h('div', { className: ready ? cx('testStatusOk') : cx('testStatusFail') }, text(t, ready ? 'doctorReady' : 'doctorNotReady')),
				checks.length === 0
					? null
					: h(
							'ul',
							{ className: cx('checks') },
							checks.map((check, index) => {
								const ok = check.ok === true;
								return h(
									'li',
									{ className: cx('check'), key: `${domId(check.id) || 'check'}-${index}` },
									h('span', { className: ok ? cx('checkOk') : cx('checkFail'), 'aria-hidden': 'true' }, ok ? '✓' : '✗'),
									h('span', null, str(check.title) || str(check.id)),
									check.optional === true ? h(Badge, null, text(t, 'doctorOptional')) : null,
									check.detail === undefined ? null : h('span', { className: cx('checkDetail') }, redact(str(check.detail))),
									check.hint === undefined ? null : h('span', { className: cx('checkDetail') }, redact(str(check.hint))),
								);
							}),
						),
			);
		}

		/** Add/edit/copy dialog: one form, validated locally before any RPC write. */
		function HostDialog(props) {
			const t = props.t;
			const msg = (key, values) => text(t, key, values);
			const mode = props.mode;
			const host = asObject(props.host);
			const [draft, setDraft] = React.useState(() => draftFromHost(host, mode));
			const [errors, setErrors] = React.useState({});
			const [formError, setFormError] = React.useState('');
			const [saving, setSaving] = React.useState(false);
			const [testing, setTesting] = React.useState(false);
			const [testResult, setTestResult] = React.useState(undefined);
			const [advanced, setAdvanced] = React.useState(hasAdvancedValues(host));
			const aliasRef = React.useRef(null);
			const busy = saving || testing;
			const editingId = mode === 'edit' && host !== undefined ? str(host.id) : undefined;
			const setField = (key) => (value) => setDraft((current) => ({ ...current, [key]: value }));
			const setExtra = (index, key, value) =>
				setDraft((current) => ({
					...current,
					extraOptions: current.extraOptions.map((row, at) => (at === index ? { ...row, [key]: value } : row)),
				}));
			const addExtra = () => setDraft((current) => ({ ...current, extraOptions: [...current.extraOptions, { key: '', value: '' }] }));
			const removeExtra = (index) => setDraft((current) => ({ ...current, extraOptions: current.extraOptions.filter((_row, at) => at !== index) }));

			const validate = () => {
				const nextErrors = validateDraft(draft, props.existingAliases || []);
				setErrors(nextErrors);
				setFormError('');
				if (hasAdvancedError(nextErrors)) setAdvanced(true);
				return Object.keys(nextErrors).length === 0;
			};

			const submit = async () => {
				if (busy) return;
				if (!validate()) return;
				setSaving(true);
				try {
					await props.onSave(toHostDraft(draft, editingId));
				} catch (error) {
					setFormError(msg('errors.saveFailed', { message: redact(messageOf(error)) || msg('errors.rpcFailed') }));
				} finally {
					setSaving(false);
				}
			};

			const runTest = async () => {
				if (busy) return;
				if (!validate()) return;
				setTesting(true);
				setTestResult(undefined);
				try {
					const result = await props.onTest(toHostDraft(draft, editingId));
					setTestResult(asObject(result) || { ok: false, durationMs: 0, stdout: '', stderr: '', error: msg('errors.rpcFailed') });
				} catch (error) {
					setTestResult({ ok: false, durationMs: 0, stdout: '', stderr: '', error: messageOf(error) || msg('errors.rpcFailed') });
				} finally {
					setTesting(false);
				}
			};

			const fieldError = (key) => (errors[key] === undefined ? undefined : msg(errors[key]));
			const fieldId = (key) => `remote-ssh-host-${key}`;

			const basicFields = [
				h(
					FormField,
					{ key: 'alias', id: fieldId('alias'), label: msg('aliasLabel'), hint: msg('aliasHint'), error: fieldError('alias') },
					h(TextInput, {
						id: fieldId('alias'),
						value: draft.alias,
						onChange: setField('alias'),
						disabled: busy,
						invalid: errors.alias !== undefined,
						error: fieldError('alias'),
						hint: msg('aliasHint'),
						inputRef: aliasRef,
					}),
				),
				h(
					FormField,
					{ key: 'displayName', id: fieldId('displayName'), label: msg('displayNameLabel'), hint: msg('displayNameHint') },
					h(TextInput, {
						id: fieldId('displayName'),
						value: draft.displayName,
						onChange: setField('displayName'),
						disabled: busy,
						hint: msg('displayNameHint'),
					}),
				),
				h(
					FormField,
					{ key: 'hostname', id: fieldId('hostname'), label: msg('hostnameLabel'), hint: msg('hostnameHint'), error: fieldError('hostname') },
					h(TextInput, {
						id: fieldId('hostname'),
						value: draft.hostname,
						onChange: setField('hostname'),
						disabled: busy,
						invalid: errors.hostname !== undefined,
						error: fieldError('hostname'),
						hint: msg('hostnameHint'),
					}),
				),
				h(
					FormField,
					{ key: 'user', id: fieldId('user'), label: msg('userLabel'), hint: msg('userHint') },
					h(TextInput, {
						id: fieldId('user'),
						value: draft.user,
						onChange: setField('user'),
						disabled: busy,
						hint: msg('userHint'),
					}),
				),
				h(
					FormField,
					{ key: 'port', id: fieldId('port'), label: msg('portLabel'), hint: msg('portHint'), error: fieldError('port') },
					h(TextInput, {
						id: fieldId('port'),
						value: draft.port,
						onChange: setField('port'),
						disabled: busy,
						type: 'number',
						invalid: errors.port !== undefined,
						error: fieldError('port'),
						hint: msg('portHint'),
					}),
				),
				h(
					FormField,
					{ key: 'identityFile', id: fieldId('identityFile'), label: msg('identityFileLabel'), hint: msg('identityFileHint') },
					h(TextInput, {
						id: fieldId('identityFile'),
						value: draft.identityFile,
						onChange: setField('identityFile'),
						disabled: busy,
						hint: msg('identityFileHint'),
					}),
				),
				h(
					FormField,
					{ key: 'proxyJump', id: fieldId('proxyJump'), label: msg('proxyJumpLabel'), hint: msg('proxyJumpHint') },
					h(TextInput, {
						id: fieldId('proxyJump'),
						value: draft.proxyJump,
						onChange: setField('proxyJump'),
						disabled: busy,
						hint: msg('proxyJumpHint'),
					}),
				),
				h(
					FormField,
					{ key: 'remoteWorkspace', id: fieldId('remoteWorkspace'), label: msg('remoteWorkspaceLabel'), hint: msg('remoteWorkspaceHint') },
					h(TextInput, {
						id: fieldId('remoteWorkspace'),
						value: draft.remoteWorkspace,
						onChange: setField('remoteWorkspace'),
						disabled: busy,
						hint: msg('remoteWorkspaceHint'),
					}),
				),
				h(
					FormField,
					{ key: 'description', id: fieldId('description'), label: msg('descriptionLabel'), hint: msg('descriptionHint'), wide: true },
					h(TextInput, {
						id: fieldId('description'),
						value: draft.description,
						onChange: setField('description'),
						disabled: busy,
						hint: msg('descriptionHint'),
					}),
				),
			];

			const advancedFields = [
				h(
					FormField,
					{ key: 'proxyCommand', id: fieldId('proxyCommand'), label: msg('proxyCommandLabel'), hint: msg('proxyCommandHint'), wide: true },
					h(TextInput, {
						id: fieldId('proxyCommand'),
						value: draft.proxyCommand,
						onChange: setField('proxyCommand'),
						disabled: busy,
						hint: msg('proxyCommandHint'),
					}),
				),
				h(
					FormField,
					{ key: 'remoteHelperRoot', id: fieldId('remoteHelperRoot'), label: msg('remoteHelperRootLabel'), hint: msg('remoteHelperRootHint'), error: fieldError('remoteHelperRoot'), wide: true },
					h(TextInput, {
						id: fieldId('remoteHelperRoot'),
						value: draft.remoteHelperRoot,
						onChange: setField('remoteHelperRoot'),
						disabled: busy,
						invalid: errors.remoteHelperRoot !== undefined,
						error: fieldError('remoteHelperRoot'),
						hint: msg('remoteHelperRootHint'),
					}),
				),
				h(
					FormField,
					{ key: 'serverAliveInterval', id: fieldId('serverAliveInterval'), label: msg('serverAliveIntervalLabel'), hint: msg('serverAliveIntervalHint'), error: fieldError('serverAliveInterval') },
					h(TextInput, {
						id: fieldId('serverAliveInterval'),
						value: draft.serverAliveInterval,
						onChange: setField('serverAliveInterval'),
						disabled: busy,
						type: 'number',
						invalid: errors.serverAliveInterval !== undefined,
						error: fieldError('serverAliveInterval'),
						hint: msg('serverAliveIntervalHint'),
					}),
				),
				h(
					FormField,
					{ key: 'serverAliveCountMax', id: fieldId('serverAliveCountMax'), label: msg('serverAliveCountMaxLabel'), hint: msg('serverAliveCountMaxHint'), error: fieldError('serverAliveCountMax') },
					h(TextInput, {
						id: fieldId('serverAliveCountMax'),
						value: draft.serverAliveCountMax,
						onChange: setField('serverAliveCountMax'),
						disabled: busy,
						type: 'number',
						invalid: errors.serverAliveCountMax !== undefined,
						error: fieldError('serverAliveCountMax'),
						hint: msg('serverAliveCountMaxHint'),
					}),
				),
				h(
					FormField,
					{ key: 'connectionAttempts', id: fieldId('connectionAttempts'), label: msg('connectionAttemptsLabel'), hint: msg('connectionAttemptsHint'), error: fieldError('connectionAttempts') },
					h(TextInput, {
						id: fieldId('connectionAttempts'),
						value: draft.connectionAttempts,
						onChange: setField('connectionAttempts'),
						disabled: busy,
						type: 'number',
						invalid: errors.connectionAttempts !== undefined,
						error: fieldError('connectionAttempts'),
						hint: msg('connectionAttemptsHint'),
					}),
				),
				h(
					FormField,
					{ key: 'connectTimeout', id: fieldId('connectTimeout'), label: msg('connectTimeoutLabel'), hint: msg('connectTimeoutHint'), error: fieldError('connectTimeout') },
					h(TextInput, {
						id: fieldId('connectTimeout'),
						value: draft.connectTimeout,
						onChange: setField('connectTimeout'),
						disabled: busy,
						type: 'number',
						invalid: errors.connectTimeout !== undefined,
						error: fieldError('connectTimeout'),
						hint: msg('connectTimeoutHint'),
					}),
				),
				h(
					FormField,
					{ key: 'userKnownHostsFile', id: fieldId('userKnownHostsFile'), label: msg('userKnownHostsFileLabel'), hint: msg('userKnownHostsFileHint'), wide: true },
					h(TextInput, {
						id: fieldId('userKnownHostsFile'),
						value: draft.userKnownHostsFile,
						onChange: setField('userKnownHostsFile'),
						disabled: busy,
						hint: msg('userKnownHostsFileHint'),
					}),
				),
				h(
					FormField,
					{ key: 'strictHostKeyChecking', id: fieldId('strictHostKeyChecking'), label: msg('strictHostKeyCheckingLabel'), hint: msg('strictHostKeyCheckingHint') },
					h(
						'div',
						{ className: cx('selectWrap') },
						h(
							'select',
							{
								id: fieldId('strictHostKeyChecking'),
								className: cx('select'),
								value: draft.strictHostKeyChecking,
								disabled: busy,
								'aria-describedby': describedBy(fieldId('strictHostKeyChecking'), undefined, msg('strictHostKeyCheckingHint')),
								onChange: (event) => setField('strictHostKeyChecking')(str(event && event.target ? event.target.value : '')),
							},
							h('option', { value: 'accept-new' }, msg('strictAcceptNew')),
							h('option', { value: 'yes' }, msg('strictYes')),
							h('option', { value: 'no' }, msg('strictNo')),
						),
						h(Chevron, null),
					),
				),
				h(
					'div',
					{ className: cx('field'), key: 'toggles' },
					h(CheckField, {
						id: fieldId('identitiesOnly'),
						label: msg('identitiesOnlyLabel'),
						hint: msg('identitiesOnlyHint'),
						checked: draft.identitiesOnly,
						disabled: busy,
						onChange: setField('identitiesOnly'),
					}),
					h(CheckField, {
						id: fieldId('forwardAgent'),
						label: msg('forwardAgentLabel'),
						hint: msg('forwardAgentHint'),
						checked: draft.forwardAgent,
						disabled: busy,
						onChange: setField('forwardAgent'),
					}),
				),
			];

			const extraRows = draft.extraOptions.map((row, index) =>
				h(
					'div',
					{ className: cx('extraRow'), key: `extra-${index}` },
					h(
						'div',
						{ className: cx('extraKey') },
						h('label', { className: cx('srOnly'), htmlFor: `${fieldId('extraKey')}-${index}` }, msg('extraOptionKey')),
						h(TextInput, {
							id: `${fieldId('extraKey')}-${index}`,
							value: row.key,
							onChange: (value) => setExtra(index, 'key', value),
							disabled: busy,
							placeholder: msg('extraOptionKey'),
						}),
					),
					h(
						'div',
						{ className: cx('extraValue') },
						h('label', { className: cx('srOnly'), htmlFor: `${fieldId('extraValue')}-${index}` }, msg('extraOptionValue')),
						h(TextInput, {
							id: `${fieldId('extraValue')}-${index}`,
							value: row.value,
							onChange: (value) => setExtra(index, 'value', value),
							disabled: busy,
							placeholder: msg('extraOptionValue'),
						}),
					),
					h(
						'button',
						{
							type: 'button',
							className: cx('btn', 'btnDanger', 'btnSmall'),
							disabled: busy,
							onClick: () => removeExtra(index),
							'aria-label': `${msg('extraOptionRemove')} ${index + 1}`,
						},
						'×',
					),
				),
			);

			const advancedSection = advanced
				? h(
						'div',
						{ className: cx('advanced'), id: 'remote-ssh-advanced' },
						h('div', { className: cx('grid') }, advancedFields),
						h(
							'div',
							{ className: cx('field') },
							h('div', { className: cx('label'), id: `${fieldId('extraOptions')}-label` }, msg('extraOptionsLabel')),
							h('div', { className: cx('extraList'), role: 'group', 'aria-labelledby': `${fieldId('extraOptions')}-label` }, extraRows),
							errors.extraOptions === undefined ? null : h('div', { className: cx('fieldError'), role: 'alert' }, fieldError('extraOptions')),
							h('div', { className: cx('hint') }, msg('extraOptionsHint')),
						),
						h('div', null, h(ActionButton, { tone: 'secondary', small: true, disabled: busy, onClick: addExtra }, msg('extraOptionAdd'))),
					)
				: null;

			const saveButton = h(
				ActionButton,
				{ key: 'save', tone: 'primary', pending: saving, disabled: testing, onClick: () => void submit() },
				saving ? msg('saving') : msg('save'),
			);
			const testButton = h(
				ActionButton,
				{ key: 'test', tone: 'secondary', pending: testing, disabled: saving, onClick: () => void runTest() },
				testing ? msg('testing') : msg('test'),
			);
			const cancelButton = h(ActionButton, { key: 'cancel', tone: 'ghost', disabled: busy, onClick: props.onClose }, msg('cancel'));

			return h(
				Modal,
				{
					title: msg(mode === 'create' ? 'createTitle' : mode === 'edit' ? 'editTitle' : 'copyTitle'),
					titleId: 'remote-ssh-host-dialog-title',
					closeLabel: msg('dialogClose'),
					busy,
					onClose: props.onClose,
					footer: [h('div', { className: cx('dialogFooterSpacer'), key: 'spacer' }), cancelButton, testButton, saveButton],
				},
				mode === 'copy' ? h('div', { className: cx('confirmDetail') }, msg('copyHint')) : null,
				h('div', { className: cx('grid') }, basicFields),
				h(
					'button',
					{
						type: 'button',
						className: cx('advancedToggle'),
						disabled: busy,
						'aria-expanded': advanced ? 'true' : 'false',
						'aria-controls': advanced ? 'remote-ssh-advanced' : undefined,
						onClick: () => setAdvanced(!advanced),
					},
					advanced ? msg('advancedCollapse') : msg('advancedExpand'),
				),
				advancedSection,
				formError.length > 0 ? h('div', { className: cx('formError'), role: 'alert' }, formError) : null,
				testResult === undefined ? null : h(TestResultBox, { t, result: testResult }),
			);
		}

		/** Delete confirmation for one managed host. */
		function DeleteDialog(props) {
			const t = props.t;
			const msg = (key, values) => text(t, key, values);
			const host = asObject(props.host) === undefined ? {} : props.host;
			const [pending, setPending] = React.useState(false);
			const [error, setError] = React.useState('');
			const confirm = async () => {
				if (pending) return;
				setPending(true);
				setError('');
				try {
					await props.onConfirm(host);
				} catch (failure) {
					setError(msg('errors.unknown', { message: redact(messageOf(failure)) || msg('errors.rpcFailed') }));
				} finally {
					setPending(false);
				}
			};
			return h(
				Modal,
				{
					title: msg('deleteTitle'),
					titleId: 'remote-ssh-delete-dialog-title',
					closeLabel: msg('dialogClose'),
					small: true,
					busy: pending,
					onClose: props.onClose,
					footer: [
						h('div', { className: cx('dialogFooterSpacer'), key: 'spacer' }),
						h(ActionButton, { tone: 'ghost', key: 'cancel', disabled: pending, onClick: props.onClose }, msg('cancel')),
						h(
							ActionButton,
							{ tone: 'danger', key: 'delete', pending, onClick: () => void confirm() },
							pending ? msg('deletePending') : msg('deleteConfirm'),
						),
					],
				},
				h('div', { className: cx('confirmText') }, msg('deleteBody', { alias: aliasOf(host) })),
				h('div', { className: cx('confirmDetail') }, msg('deleteDetail')),
				error.length > 0 ? h('div', { className: cx('formError'), role: 'alert' }, error) : null,
			);
		}

		/** Install confirmation for the remote helper, followed by the open flow. */
		function InstallDialog(props) {
			const t = props.t;
			const msg = (key, values) => text(t, key, values);
			const host = asObject(props.host) === undefined ? {} : props.host;
			const helper = helperOf(host);
			const info = helperInfo(host, props.settings, props.details);
			const [pending, setPending] = React.useState(false);
			const [error, setError] = React.useState('');
			const confirm = async () => {
				if (pending) return;
				setPending(true);
				setError('');
				try {
					await props.onConfirm(host);
				} catch (failure) {
					setError(msg('errors.unknown', { message: redact(messageOf(failure)) || msg('errors.rpcFailed') }));
				} finally {
					setPending(false);
				}
			};
			return h(
				Modal,
				{
					title: msg('installTitle'),
					titleId: 'remote-ssh-install-dialog-title',
					closeLabel: msg('dialogClose'),
					small: true,
					busy: pending,
					onClose: props.onClose,
					footer: [
						h('div', { className: cx('dialogFooterSpacer'), key: 'spacer' }),
						h(ActionButton, { tone: 'ghost', key: 'cancel', disabled: pending, onClick: props.onClose }, msg('cancel')),
						h(
							ActionButton,
							{ tone: 'primary', key: 'install', pending, onClick: () => void confirm() },
							pending ? msg('installPending') : msg('installConfirm'),
						),
					],
				},
				h('div', { className: cx('confirmText') }, msg('installBody')),
				helper.status === 'mismatch'
					? h('div', { className: cx('confirmText') }, msg('installMismatch', { version: helper.version.length > 0 ? helper.version : '?', expected: info.version.length > 0 ? info.version : '?' }))
					: null,
				h(
					'div',
					{ className: cx('helperInfo') },
					h('div', { className: cx('helperLabel') }, msg('installPathLabel')),
					h('code', { className: cx('code') }, redact(info.path)),
					info.command.length > 0 ? h('div', { className: cx('helperLabel') }, msg('installCommandLabel')) : null,
					info.command.length > 0 ? h('code', { className: cx('code') }, redact(info.command)) : null,
					info.version.length > 0 ? h('div', { className: cx('helperLabel') }, msg('installVersionValue', { version: info.version })) : null,
				),
				h('div', { className: cx('confirmDetail') }, msg('installDetail')),
				error.length > 0 ? h('div', { className: cx('formError'), role: 'alert' }, error) : null,
			);
		}

		/** One host row: identity, badges, instance state, and its actions. */
		function HostRow(props) {
			const t = props.t;
			const msg = (key, values) => text(t, key, values);
			const host = asObject(props.host) === undefined ? {} : props.host;
			const helper = helperOf(host);
			const instance = instanceOf(host);
			const managed = isManagedHost(host);
			const shadowed = host.shadowed === true;
			const alias = aliasOf(host);
			const hostKey = str(host.id) || alias;
			const displayName = str(host.displayName);
			const name = displayName.length > 0 ? displayName : alias;
			const showAlias = displayName.length > 0 && displayName !== alias;
			const description = str(host.description);
			const resolutionError = redact(str(host.resolutionError));
			const testResult = props.testResult;
			const pending = asObject(props.pending) === undefined ? {} : props.pending;
			const openPending = pending[`open:${hostKey}`] === true;
			const urlPending = pending[`url:${hostKey}`] === true;
			const stopPending = pending[`stop:${hostKey}`] === true;
			const testPending = pending[`test:${hostKey}`] === true;
			const logId = `remote-ssh-log-${domId(hostKey)}`;
			const helperText = helperLabel(t, helper);
			const phaseText = phaseLabel(t, instance.phase);

			const actions = [];
			if (instance.running) {
				actions.push(h(ActionButton, { key: 'window', tone: 'primary', pending: urlPending, onClick: props.onOpenWindow }, msg('openWindow')));
				actions.push(h(ActionButton, { key: 'again', tone: 'secondary', pending: openPending, onClick: props.onOpen }, msg('openAgain')));
				actions.push(h(ActionButton, { key: 'stop', tone: 'danger', pending: stopPending, onClick: props.onStop }, stopPending ? msg('phaseStopping') : msg('stop')));
			} else {
				actions.push(h(ActionButton, { key: 'open', tone: 'primary', pending: openPending, onClick: props.onOpen }, msg('open')));
			}
			actions.push(h(ActionButton, { key: 'test', tone: 'secondary', pending: testPending, onClick: props.onTest }, testPending ? msg('testing') : msg('test')));
			if (instance.phase === 'failed') {
				actions.push(
					h(
						ActionButton,
						{ key: 'details', tone: 'ghost', expanded: props.expanded === true, controls: logId, onClick: props.onToggleDetails },
						props.expanded === true ? msg('hideDetails') : msg('details'),
					),
				);
			}
			if (managed) {
				actions.push(h(ActionButton, { key: 'edit', tone: 'secondary', onClick: props.onEdit }, msg('edit')));
				actions.push(h(ActionButton, { key: 'delete', tone: 'danger', onClick: props.onDelete }, msg('remove')));
			} else {
				actions.push(
					h(
						ActionButton,
						{ key: 'copy', tone: 'secondary', disabled: shadowed, title: shadowed ? msg('shadowedCopyDisabled') : undefined, onClick: props.onCopy },
						msg('copyManaged'),
					),
				);
			}

			return h(
				'article',
				{ className: cx('hostRow'), 'aria-busy': openPending || urlPending || stopPending || testPending ? 'true' : undefined },
				h(
					'div',
					{ className: cx('hostMain') },
					h(
						'div',
						{ className: cx('hostTitle') },
						h('span', { className: cx('hostName') }, name),
						showAlias ? h('span', { className: cx('hostAlias') }, alias) : null,
						h(Badge, { tone: 'badgeBusiness' }, msg(managed ? 'sourceManaged' : 'sourceSshConfig')),
						h(Badge, { tone: helperTone(helper.status) }, helperText),
						h(Badge, { tone: phaseTone(instance.phase) }, phaseText),
						shadowed ? h(Badge, { tone: 'badgeWarn' }, msg('shadowed')) : null,
					),
					h('div', { className: cx('hostTarget') }, targetOf(host)),
					description.length > 0 ? h('div', { className: cx('hostDescription') }, description) : null,
					instance.message.length > 0 ? h('div', { className: cx('hostMessage') }, redact(instance.message)) : null,
					instance.error.length > 0 ? h('div', { className: cx('hostError') }, msg('instanceError', { message: redact(instance.error) })) : null,
					resolutionError.length > 0 ? h('div', { className: cx('hostError') }, resolutionError) : null,
					instance.running
						? h(
								'div',
								{ className: cx('rowPanel') },
								h('div', { className: cx('rowPanelTitle') }, msg('runningPanelTitle')),
								h('div', { className: cx('rowPanelBody') }, msg('runningPanelBody')),
							)
						: null,
					testResult === undefined ? null : h(TestResultBox, { t, result: testResult }),
					props.expanded === true
						? h(
								'div',
								{ className: cx('rowPanel'), id: logId },
								h('div', { className: cx('rowPanelTitle') }, msg('logTitle'), h('span', { className: cx('rowPanelBody') }, msg('redactedHint'))),
								h('pre', { className: cx('log') }, redact(tail(instance.logTail, 20000)) || msg('testOutputEmpty')),
								props.doctorPending === true ? h('div', { className: cx('rowPanelBody') }, msg('doctorPending')) : null,
								props.doctorResult === undefined ? null : h(DoctorChecks, { t, result: props.doctorResult }),
							)
						: null,
				),
				h('div', { className: cx('hostActions') }, actions),
			);
		}

		/**
		 * The Remote SSH main panel: snapshot polling, host groups, dialogs, and the
		 * helper-install/open-window flow.
		 */
		function RemoteSshPage(props) {
			const t = typeof props.t === 'function' ? props.t : () => '';
			const api = props.api;
			const msg = React.useCallback((key, values) => text(t, key, values), [t]);
			const [snapshot, setSnapshot] = React.useState(undefined);
			const [loading, setLoading] = React.useState(true);
			const [refreshing, setRefreshing] = React.useState(false);
			const [pollError, setPollError] = React.useState('');
			const [actionError, setActionError] = React.useState('');
			const [notice, setNotice] = React.useState('');
			const [query, setQuery] = React.useState('');
			const [pending, setPending] = React.useState({});
			const [dialog, setDialog] = React.useState(undefined);
			const [deleteTarget, setDeleteTarget] = React.useState(undefined);
			const [installTarget, setInstallTarget] = React.useState(undefined);
			const [installDetails, setInstallDetails] = React.useState(undefined);
			const [openResult, setOpenResult] = React.useState(undefined);
			const [copied, setCopied] = React.useState(false);
			const [expanded, setExpanded] = React.useState(undefined);
			const [testResults, setTestResults] = React.useState({});
			const [doctorResults, setDoctorResults] = React.useState({});
			const [doctorPending, setDoctorPending] = React.useState({});
			const pendingRef = React.useRef({});
			const mountedRef = React.useRef(true);
			const refreshRef = React.useRef(false);
			const copyTimerRef = React.useRef(0);

			React.useEffect(() => {
				mountedRef.current = true;
				return () => {
					mountedRef.current = false;
					if (copyTimerRef.current !== 0) window.clearTimeout(copyTimerRef.current);
				};
			}, []);

			React.useEffect(() => {
				if (notice.length === 0) return undefined;
				const timer = window.setTimeout(() => {
					if (mountedRef.current) setNotice('');
				}, 4000);
				return () => window.clearTimeout(timer);
			}, [notice]);

			// ------------------------------------------------------------ polling
			React.useEffect(() => {
				const controller = new AbortController();
				let stopped = false;
				let timer = 0;
				let inflight = false;
				const schedule = () => {
					if (!stopped) timer = window.setTimeout(tick, POLL_MS);
				};
				const tick = async () => {
					if (stopped) return;
					if (inflight) {
						schedule();
						return;
					}
					if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
						schedule();
						return;
					}
					inflight = true;
					try {
						const next = await api.snapshot({}, controller.signal);
						if (stopped) return;
						setSnapshot(next);
						setPollError('');
					} catch (error) {
						if (stopped || controller.signal.aborted) return;
						setPollError(messageOf(error) || msg('errors.rpcFailed'));
					} finally {
						inflight = false;
						if (!stopped) {
							setLoading(false);
							schedule();
						}
					}
				};
				const onVisibility = () => {
					if (typeof document === 'undefined' || stopped || document.visibilityState !== 'visible') return;
					if (timer !== 0) {
						window.clearTimeout(timer);
						timer = 0;
					}
					void tick();
				};
				void tick();
				if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
				return () => {
					stopped = true;
					controller.abort();
					if (timer !== 0) window.clearTimeout(timer);
					if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
				};
			}, [api, msg]);

			const applySnapshot = (result) => {
				const record = asObject(result);
				const next = record === undefined ? undefined : record.snapshot;
				if (next !== undefined) setSnapshot(next);
				return next;
			};

			const refresh = async () => {
				if (refreshRef.current) return;
				refreshRef.current = true;
				setRefreshing(true);
				try {
					const next = await api.snapshot({});
					if (!mountedRef.current) return;
					setSnapshot(next);
					setPollError('');
				} catch (error) {
					if (mountedRef.current) setPollError(messageOf(error) || msg('errors.rpcFailed'));
				} finally {
					refreshRef.current = false;
					if (mountedRef.current) setRefreshing(false);
				}
			};

			const markPending = (key, on) => {
				if (on) pendingRef.current[key] = true;
				else delete pendingRef.current[key];
				if (mountedRef.current) setPending({ ...pendingRef.current });
			};

			const run = async (key, work) => {
				if (pendingRef.current[key] === true) return;
				markPending(key, true);
				if (mountedRef.current) setActionError('');
				try {
					await work();
				} catch (error) {
					if (mountedRef.current) {
						setActionError(msg('errors.unknown', { message: redact(messageOf(error)) || msg('errors.rpcFailed') }));
					}
				} finally {
					markPending(key, false);
				}
			};

			// ------------------------------------------------------------ actions
			const openWindowNow = async (host) => {
				const id = str(host.id);
				const result = await api.openUrl({ id });
				const url = asObject(result) === undefined ? '' : str(result.url);
				if (url.length === 0) throw new Error(msg('errors.openUrlEmpty'));
				if (mountedRef.current) {
					setOpenResult({ id, alias: aliasOf(host), url });
					setCopied(false);
				}
				try {
					if (typeof window !== 'undefined' && typeof window.open === 'function') window.open(url, '_blank', 'noopener');
				} catch (_blocked) {
					// The fallback link in the panel remains available when opening is blocked.
				}
			};

			const openHostNow = async (host, allowInstall) => {
				const result = await api.openHost({ id: str(host.id), allowInstall: allowInstall === true });
				const next = applySnapshot(result);
				if (mountedRef.current) setNotice(msg('noticeOpenStarted'));
				const latest = pickHost(next, str(host.id));
				if (latest !== undefined && instanceOf(latest).running) {
					void run(`url:${keyOf(latest)}`, () => openWindowNow(latest));
				}
			};

			const beginOpen = (host) => {
				// Check the remote helper before starting the open job. The snapshot
				// badge can be stale or unknown until the first probe; running doctor
				// first keeps "open" from installing behind the user's back and
				// shows the install prompt only when it is actually needed.
				void run(`open:${keyOf(host)}`, async () => {
					const diagnosis = await api.doctor({ id: str(host.id) });
					const diagnosisRecord = asObject(diagnosis);
					const facts = asObject(diagnosisRecord === undefined ? undefined : diagnosisRecord.facts);
					const remoteHelper = asObject(facts === undefined ? undefined : facts.helper);
					const status = remoteHelper === undefined ? 'unknown' : str(remoteHelper.status);
					if (status !== 'installed') {
						if (mountedRef.current) {
							const known = helperOf(host);
							setInstallTarget(host);
							setInstallDetails({
								installCommand: known.installCommand,
								path: remoteHelper === undefined ? '' : str(remoteHelper.path),
								requiredVersion: remoteHelper === undefined ? known.expectedVersion : str(remoteHelper.expectedVersion),
							});
						}
						return;
					}
					await openHostNow(host, false);
				});
			};

			const openWindow = (host) => {
				void run(`url:${keyOf(host)}`, () => openWindowNow(host));
			};

			const stopHost = (host) => {
				void run(`stop:${keyOf(host)}`, async () => {
					const result = await api.stopHost({ id: str(host.id) });
					applySnapshot(result);
					if (mountedRef.current) setNotice(msg('noticeStopped'));
				});
			};

			const testHost = (host) => {
				const key = keyOf(host);
				void run(`test:${key}`, async () => {
					const result = await api.testConnection({ id: str(host.id) });
					if (mountedRef.current) setTestResults((current) => ({ ...current, [key]: result }));
				});
			};

			const runDoctor = async (host) => {
				const key = keyOf(host);
				if (doctorResults[key] !== undefined || doctorPending[key] === true) return;
				setDoctorPending((current) => ({ ...current, [key]: true }));
				try {
					const result = await api.doctor({ id: str(host.id) });
					if (mountedRef.current) setDoctorResults((current) => ({ ...current, [key]: result }));
				} catch (_diagnosticFailure) {
					// Diagnostics are supplemental: a failure must not hide the runtime log.
				} finally {
					if (mountedRef.current) {
						setDoctorPending((current) => {
							const next = { ...current };
							delete next[key];
							return next;
						});
					}
				}
			};

			const toggleDetails = (host) => {
				const key = keyOf(host);
				if (expanded === key) {
					setExpanded(undefined);
					return;
				}
				setExpanded(key);
				void runDoctor(host);
			};

			// ------------------------------------------------------------ dialogs
			const saveDraft = async (draft) => {
				const result = await api.saveHost({ host: draft });
				applySnapshot(result);
				if (mountedRef.current) {
					setDialog(undefined);
					setNotice(msg('noticeSaved'));
				}
			};

			const removeHost = async (host) => {
				const result = await api.deleteHost({ id: str(host.id) });
				applySnapshot(result);
				if (mountedRef.current) {
					setDeleteTarget(undefined);
					setNotice(msg('noticeDeleted'));
				}
			};

			const installThenOpen = async (host) => {
				const result = await api.installHelper({ id: str(host.id), confirm: true });
				const version = asObject(result) === undefined ? '' : str(result.version);
				if (mountedRef.current) {
					setInstallTarget(undefined);
					setInstallDetails(undefined);
					setNotice(msg('noticeHelperInstalled', { version: version.length > 0 ? version : '?' }));
				}
				void run(`open:${keyOf(host)}`, () => openHostNow(host, true));
			};

			const testDraft = async (draft) => api.testConnection({ draft });

			const copyResultUrl = async () => {
				if (openResult === undefined) return;
				try {
					await copyText(openResult.url);
					if (!mountedRef.current) return;
					setCopied(true);
					if (copyTimerRef.current !== 0) window.clearTimeout(copyTimerRef.current);
					copyTimerRef.current = window.setTimeout(() => {
						if (mountedRef.current) setCopied(false);
					}, 2000);
				} catch {
					if (mountedRef.current) setActionError(msg('errors.copyFailed'));
				}
			};

			// ------------------------------------------------------------ derive
			const record = asObject(snapshot) === undefined ? {} : snapshot;
			const platform = asObject(record.platform) === undefined ? {} : record.platform;
			const settings = asObject(record.settings) === undefined ? {} : record.settings;
			const warnings = Array.isArray(record.warnings) ? record.warnings.filter((entry) => typeof entry === 'string' && entry.length > 0) : [];
			const hosts = Array.isArray(record.hosts) ? record.hosts.filter((host) => asObject(host) !== undefined) : [];
			const needle = query.trim().toLowerCase();
			const matches = (host) => {
				if (needle.length === 0) return true;
				const fields = [str(host.alias), str(host.displayName), str(host.hostname)];
				return fields.some((value) => value.toLowerCase().includes(needle));
			};
			const managedHosts = hosts.filter((host) => host.source === 'managed' && matches(host));
			const configHosts = hosts.filter((host) => host.source !== 'managed' && matches(host));
			const managedAliases = hosts.filter((host) => isManagedHost(host)).map((host) => str(host.alias));
			const editingAlias = dialog !== undefined && dialog.mode === 'edit' && asObject(dialog.host) !== undefined ? str(dialog.host.alias) : '';
			const existingAliases = managedAliases.filter((alias) => alias !== editingAlias);
			const supported = platform.supported !== false;
			const profileReady = settings.profileReady !== false;
			const metaParts = [];
			if (str(settings.sshConfigPath).length > 0) metaParts.push(msg('settingsConfig', { path: settings.sshConfigPath }));
			if (str(settings.profileName).length > 0) metaParts.push(msg('settingsProfile', { profile: settings.profileName }));
			if (str(settings.dataDir).length > 0) metaParts.push(msg('settingsData', { path: settings.dataDir }));
			const updatedAt = formatTime(record.generatedAt);

			// ------------------------------------------------------------- render
			const banners = [];
			if (pollError.length > 0) {
				banners.push(
					h(
						Banner,
						{ key: 'poll-error', tone: 'error', onDismiss: () => setPollError(''), dismissLabel: msg('dismiss') },
						h('div', null, msg('loadFailed', { message: redact(pollError) })),
						snapshot === undefined ? null : h('div', null, msg('staleData')),
					),
				);
			}
			if (!supported) {
				banners.push(
					h(Banner, { key: 'platform', tone: 'warn' }, h('div', null, msg('platformUnsupported', { platform: str(platform.platform) || msg('unknownPlatform') }))),
				);
			}
			if (!profileReady && str(settings.profileName).length > 0) {
				banners.push(h(Banner, { key: 'profile', tone: 'warn' }, h('div', null, msg('profileNotReady', { profile: settings.profileName }))));
			}
			if (warnings.length > 0) {
				banners.push(
					h(
						Banner,
						{ key: 'warnings', tone: 'warn' },
						h('div', null, h('div', null, msg('warningsTitle')), h('ul', { className: cx('bannerList') }, warnings.map((warning, index) => h('li', { key: `warning-${index}` }, redact(warning))))),
					),
				);
			}
			if (actionError.length > 0) {
				banners.push(
					h(
						Banner,
						{ key: 'action-error', tone: 'error', onDismiss: () => setActionError(''), dismissLabel: msg('dismiss') },
						h('div', null, actionError),
					),
				);
			}
			if (notice.length > 0) {
				banners.push(
					h(
						Banner,
						{ key: 'notice', tone: 'success', onDismiss: () => setNotice(''), dismissLabel: msg('dismiss') },
						h('div', null, notice),
					),
				);
			}

			const openResultNode =
				openResult === undefined
					? null
					: h(
							'div',
							{ className: cx('openResult') },
							h(
								'div',
								{ className: cx('openResultMain') },
								h('div', { className: cx('openResultTitle') }, msg('openResultTitle', { alias: openResult.alias })),
								h('div', { className: cx('openResultBody') }, msg('openResultBody')),
							),
							h(
								'div',
								{ className: cx('openResultActions') },
								h('a', { className: cx('link'), href: openResult.url, target: '_blank', rel: 'noopener noreferrer' }, msg('openWindow')),
								h(ActionButton, { tone: 'secondary', small: true, onClick: () => void copyResultUrl() }, copied ? msg('openResultCopied') : msg('openResultCopy')),
								h(ActionButton, { tone: 'ghost', small: true, onClick: () => setOpenResult(undefined) }, msg('openResultClose')),
							),
						);

			const hostRow = (host, index) => {
				const key = keyOf(host) || `host-${index}`;
				return h(HostRow, {
					key,
					t,
					host,
					pending,
					testResult: testResults[key],
					expanded: expanded === key,
					doctorResult: doctorResults[key],
					doctorPending: doctorPending[key] === true,
					onOpen: () => beginOpen(host),
					onOpenWindow: () => openWindow(host),
					onStop: () => stopHost(host),
					onTest: () => testHost(host),
					onEdit: () => setDialog({ mode: 'edit', host }),
					onCopy: () => setDialog({ mode: 'copy', host }),
					onDelete: () => setDeleteTarget(host),
					onToggleDetails: () => toggleDetails(host),
				});
			};

			const group = (key, title, hint, list, emptyText) =>
				h(
					'section',
					{ className: cx('group'), key },
					h('div', { className: cx('groupHeader') }, h('h2', { className: cx('groupTitle') }, title), h('p', { className: cx('groupHint') }, hint)),
					list.length === 0 ? h('div', { className: cx('emptyRow') }, emptyText) : h('div', { className: cx('hostList') }, list.map(hostRow)),
				);

			let body;
			if (snapshot === undefined) {
				body = loading ? h(Banner, { tone: 'info' }, h('div', { className: cx('loadingRow') }, h(Spinner, null), msg('loading'))) : null;
			} else if (hosts.length === 0) {
				body = h(
					'div',
					{ className: cx('empty') },
					h('h2', { className: cx('emptyTitle') }, msg('emptyTitle')),
					h('p', { className: cx('emptyBody') }, msg('emptyBody')),
					h(ActionButton, { tone: 'primary', onClick: () => setDialog({ mode: 'create' }) }, msg('addHost')),
				);
			} else if (managedHosts.length === 0 && configHosts.length === 0) {
				body = h(
					'div',
					{ className: cx('empty') },
					h('h2', { className: cx('emptyTitle') }, msg('emptyNoMatch')),
					h('p', { className: cx('emptyBody') }, msg('emptyNoMatchHint')),
				);
			} else {
				body = [
					group('managed', msg('groupManaged', { count: managedHosts.length }), msg('groupManagedHint'), managedHosts, msg('emptyManaged')),
					group('ssh-config', msg('groupSshConfig', { count: configHosts.length }), msg('groupSshConfigHint'), configHosts, msg('emptySshConfig')),
				];
			}

			const pageChildren = [
				h(
					'header',
					{ className: cx('header'), key: 'header' },
					h(
						'div',
						{ className: cx('heading') },
						h('h1', { className: cx('title') }, msg('pageTitle')),
						h('p', { className: cx('subtitle') }, msg('pageSubtitle')),
						metaParts.length === 0 && updatedAt.length === 0
							? null
							: h(
									'div',
									{ className: cx('meta') },
									metaParts.map((part, index) => h('span', { key: `meta-${index}`, className: cx('metaCode') }, part)),
									updatedAt.length > 0 ? h('span', null, msg('lastUpdated', { time: updatedAt })) : null,
								),
					),
					h(
						'div',
						{ className: cx('toolbar') },
						h('div', { className: cx('searchWrap') },
							h(TextInput, {
								id: 'remote-ssh-search',
								type: 'search',
								value: query,
								onChange: setQuery,
								placeholder: msg('searchPlaceholder'),
								ariaLabel: msg('searchLabel'),
							}),
						),
						h(
							ActionButton,
							{ tone: 'secondary', pending: refreshing, onClick: () => void refresh(), ariaLabel: msg('refresh') },
							refreshing ? msg('refreshing') : msg('refresh'),
						),
						h(ActionButton, { tone: 'primary', onClick: () => setDialog({ mode: 'create' }) }, msg('addHost')),
					),
				),
				banners.length === 0 ? null : h('div', { className: cx('banners'), key: 'banners' }, banners),
				openResultNode === null ? null : h('div', { key: 'open-result' }, openResultNode),
				h('div', { key: 'body' }, body),
				dialog === undefined
					? null
					: h(HostDialog, {
							key: `host-dialog-${dialog.mode}-${dialog.host === undefined ? 'new' : str(dialog.host.id)}`,
							t,
							mode: dialog.mode,
							host: dialog.host,
							existingAliases,
							onSave: saveDraft,
							onTest: testDraft,
							onClose: () => setDialog(undefined),
						}),
				deleteTarget === undefined
					? null
					: h(DeleteDialog, { key: 'delete-dialog', t, host: deleteTarget, onConfirm: removeHost, onClose: () => setDeleteTarget(undefined) }),
				installTarget === undefined
					? null
					: h(InstallDialog, {
							key: 'install-dialog',
							t,
							host: installTarget,
							settings,
							details: installDetails,
							onConfirm: installThenOpen,
							onClose: () => {
								setInstallTarget(undefined);
								setInstallDetails(undefined);
							},
						}),
			];

			return h('div', { className: cx('page') }, pageChildren);
		}

		/**
		 * Keep one rendering error from blanking the whole main panel: a slot entry
		 * that throws is dropped by the shell, so this boundary renders a plain
		 * message instead and the rest of the UI stays usable.
		 */
		class PanelErrorBoundary extends React.Component {
			constructor(props) {
				super(props);
				this.state = { failed: false };
			}

			static getDerivedStateFromError() {
				return { failed: true };
			}

			componentDidCatch(error) {
				if (typeof console !== 'undefined' && typeof console.error === 'function') {
					console.error('[remote-ssh] panel failed', error);
				}
			}

			render() {
				if (this.state.failed) {
					return h('div', { className: cx('page') }, h(Banner, { tone: 'error' }, text(this.props.t, 'crash')));
				}
				return this.props.children;
			}
		}

		/** Render the page inside the error boundary. */
		function RemoteSshPanel(props) {
			return h(PanelErrorBoundary, { t: props.t }, h(RemoteSshPage, props));
		}

		/** Append this panel's stylesheet once, and remove it when the plugin disposes. */
		function installStyles() {
			if (typeof document === 'undefined' || document === null) return () => {};
			const existing = document.getElementById(STYLE_ID);
			if (existing !== null && existing !== undefined) return () => {};
			const style = document.createElement('style');
			style.id = STYLE_ID;
			style.textContent = CSS;
			document.head.append(style);
			return () => {
				if (style.parentNode !== null && style.parentNode !== undefined) style.parentNode.removeChild(style);
			};
		}

		/** Append the remote-workspace stylesheet once, and remove it when the plugin disposes. */
		function installWorkspaceStyles() {
			if (typeof document === 'undefined' || document === null) return () => {};
			const existing = document.getElementById(WORKSPACE_STYLE_ID);
			if (existing !== null && existing !== undefined) return () => {};
			const style = document.createElement('style');
			style.id = WORKSPACE_STYLE_ID;
			style.textContent = WORKSPACE_CSS;
			document.head.append(style);
			return () => {
				if (style.parentNode !== null && style.parentNode !== undefined) style.parentNode.removeChild(style);
			};
		}

		/**
		 * The Remote Workspaces panel: a read-only inventory of every managed
		 * host's workspaces and their sessions. Clicking a session starts (or
		 * reuses) that host's remote window and opens its authenticated URL; the
		 * Host-side pending marker makes the new window jump to that session.
		 */
		function RemoteWorkspacePage(props) {
			const t = typeof props.t === 'function' ? props.t : () => '';
			const api = props.api;
			const msg = React.useCallback((key, values) => text(t, key, values), [t]);
			const [data, setData] = React.useState(undefined);
			const [loading, setLoading] = React.useState(true);
			const [refreshing, setRefreshing] = React.useState(false);
			const [pollError, setPollError] = React.useState('');
			const [actionError, setActionError] = React.useState('');
			const [notice, setNotice] = React.useState('');
			const [pending, setPending] = React.useState({});
			const [openResult, setOpenResult] = React.useState(undefined);
			const pendingRef = React.useRef({});
			const mountedRef = React.useRef(true);
			const refreshRef = React.useRef(false);

			React.useEffect(() => {
				mountedRef.current = true;
				return () => {
					mountedRef.current = false;
				};
			}, []);

			React.useEffect(() => {
				if (notice.length === 0) return undefined;
				const timer = window.setTimeout(() => {
					if (mountedRef.current) setNotice('');
				}, 4000);
				return () => window.clearTimeout(timer);
			}, [notice]);

			// One Host scan per visible tick; the Host reads only this machine's disk.
			React.useEffect(() => {
				const controller = new AbortController();
				let stopped = false;
				let timer = 0;
				let inflight = false;
				const schedule = () => {
					if (!stopped) timer = window.setTimeout(tick, WORKSPACE_POLL_MS);
				};
				const tick = async () => {
					if (stopped) return;
					if (inflight) {
						schedule();
						return;
					}
					if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
						schedule();
						return;
					}
					inflight = true;
					try {
						const next = await api.remoteWorkspaces({}, controller.signal);
						if (stopped) return;
						setData(asObject(next) === undefined ? {} : next);
						setPollError('');
					} catch (error) {
						if (stopped || controller.signal.aborted) return;
						setPollError(messageOf(error) || msg('errors.rpcFailed'));
					} finally {
						inflight = false;
						if (!stopped) {
							setLoading(false);
							schedule();
						}
					}
				};
				const onVisibility = () => {
					if (typeof document === 'undefined' || stopped || document.visibilityState !== 'visible') return;
					if (timer !== 0) {
						window.clearTimeout(timer);
						timer = 0;
					}
					void tick();
				};
				void tick();
				if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
				return () => {
					stopped = true;
					controller.abort();
					if (timer !== 0) window.clearTimeout(timer);
					if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
				};
			}, [api, msg]);

			const refresh = async () => {
				if (refreshRef.current) return;
				refreshRef.current = true;
				if (mountedRef.current) setRefreshing(true);
				try {
					const next = await api.remoteWorkspaces({});
					if (!mountedRef.current) return;
					setData(asObject(next) === undefined ? {} : next);
					setPollError('');
				} catch (error) {
					if (mountedRef.current) setPollError(messageOf(error) || msg('errors.rpcFailed'));
				} finally {
					refreshRef.current = false;
					if (mountedRef.current) setRefreshing(false);
				}
			};

			const markPending = (key, on) => {
				if (on) pendingRef.current[key] = true;
				else delete pendingRef.current[key];
				if (mountedRef.current) setPending({ ...pendingRef.current });
			};

			const run = async (key, work) => {
				if (pendingRef.current[key] === true) return;
				markPending(key, true);
				if (mountedRef.current) setActionError('');
				try {
					await work();
				} catch (error) {
					if (mountedRef.current) {
						const message = redact(messageOf(error)) || msg('errors.rpcFailed');
						const hint = /helper|not installed/i.test(message) ? ' ' + msg('workspaceHelperHint') : '';
						setActionError(msg('errors.unknown', { message: message + hint }));
					}
				} finally {
					markPending(key, false);
				}
			};

			/** Poll the Host snapshot until one instance reports running. */
			const waitForRunning = async (hostId) => {
				const deadline = Date.now() + OPEN_TIMEOUT_MS;
				while (mountedRef.current) {
					const snapshot = await api.snapshot({});
					const host = pickHost(snapshot, hostId);
					if (host === undefined) throw new Error(msg('workspaceHostMissing'));
					const instance = instanceOf(host);
					if (instance.running) return instance;
					if (instance.phase === 'failed') {
						throw new Error(instance.error.length > 0 ? instance.error : msg('errors.rpcFailed'));
					}
					if (Date.now() >= deadline) throw new Error(msg('workspaceOpenTimeout'));
					await sleep(OPEN_POLL_MS);
				}
				throw new Error(msg('workspaceOpenTimeout'));
			};

			/** Start (or reuse) a host window and open its authenticated URL. */
			const openRemoteWindow = async (host, sessionId) => {
				const id = str(host.id);
				const label = hostLabel(host);
				const payload = { id, allowInstall: false };
				if (typeof sessionId === 'string' && sessionId.length > 0) payload.sessionId = sessionId;
				await api.openHost(payload);
				if (mountedRef.current) setNotice(msg('workspaceOpenStarted', { host: label }));
				await waitForRunning(id);
				const result = await api.openUrl({ id });
				const url = asObject(result) === undefined ? '' : str(result.url);
				if (url.length === 0) throw new Error(msg('errors.openUrlEmpty'));
				if (mountedRef.current) {
					setOpenResult({ host: label, url });
					setNotice(msg('workspaceOpened', { host: label }));
				}
				try {
					if (typeof window !== 'undefined' && typeof window.open === 'function') window.open(url, '_blank', 'noopener');
				} catch (_blocked) {
					// The fallback link in the panel remains available when opening is blocked.
				}
				void refresh();
			};

			const openHostWindow = (host) => {
				void run('open:' + str(host.id), () => openRemoteWindow(host, undefined));
			};

			/**
			 * Mount one remote directory into the current window. The Host registers
			 * the SSH world and returns a local mirror path; the ordinary Workspace
			 * and Session APIs then create/attach the session and navigate to it.
			 */
			const openHere = (host, remotePath, title) => {
				const hostId = str(host.id);
				const path = str(remotePath);
				if (hostId.length === 0 || path.length === 0) return;
				const key = 'mixed:' + hostId + ':' + path;
				void run(key, async () => {
					await api.openRemoteWorkspaceHere({ hostId, remotePath: path, title });
					if (mountedRef.current) setNotice(msg('workspaceOpenHereDone', { path }));
				});
			};

			const openSession = (host, session) => {
				const hostId = str(host.id);
				const sessionId = str(session.id);
				const hostKey = 'open:' + hostId;
				// One open flow per host: a second session click joins the state
				// instead of starting a competing job.
				if (pendingRef.current[hostKey] === true) return;
				void run('session:' + hostId + ':' + sessionId, async () => {
					markPending(hostKey, true);
					try {
						await openRemoteWindow(host, sessionId);
					} finally {
						markPending(hostKey, false);
					}
				});
			};

			const stopHost = (host) => {
				void run('stop:' + str(host.id), async () => {
					await api.stopHost({ id: str(host.id) });
					if (mountedRef.current) setNotice(msg('workspaceStopped', { host: hostLabel(host) }));
					void refresh();
				});
			};

			// ------------------------------------------------------------ derive
			const record = asObject(data) === undefined ? {} : data;
			const hosts = Array.isArray(record.hosts) ? record.hosts.filter((host) => asObject(host) !== undefined) : [];
			const warnings = Array.isArray(record.warnings) ? record.warnings.filter((entry) => typeof entry === 'string' && entry.length > 0) : [];
			const updatedAt = formatTime(record.generatedAt);
			const totalSessions = hosts.reduce((total, host) => {
				const workspaces = Array.isArray(host.workspaces) ? host.workspaces : [];
				return total + workspaces.reduce(
					(count, workspace) => count + (Array.isArray(workspace.sessions) ? workspace.sessions.length : 0),
					0,
				);
			}, 0);

			// ------------------------------------------------------------- render
			const banners = [];
			if (pollError.length > 0) {
				banners.push(
					h(
						Banner,
						{ key: 'poll-error', tone: 'error', onDismiss: () => setPollError(''), dismissLabel: msg('dismiss') },
						h('div', null, msg('workspaceLoadFailed', { message: redact(pollError) })),
						data === undefined ? null : h('div', null, msg('workspaceStaleData')),
					),
				);
			}
			if (warnings.length > 0) {
				banners.push(
					h(
						Banner,
						{ key: 'warnings', tone: 'warn' },
						h(
							'div',
							null,
							h('div', null, msg('workspaceWarnings')),
							h(
								'ul',
								{ className: cxw('bannerList') },
								warnings.map((warning, index) => h('li', { key: 'warning-' + index }, redact(warning))),
							),
						),
					),
				);
			}
			if (actionError.length > 0) {
				banners.push(
					h(
						Banner,
						{ key: 'action-error', tone: 'error', onDismiss: () => setActionError(''), dismissLabel: msg('dismiss') },
						h('div', null, actionError),
					),
				);
			}
			if (notice.length > 0) {
				banners.push(
					h(
						Banner,
						{ key: 'notice', tone: 'success', onDismiss: () => setNotice(''), dismissLabel: msg('dismiss') },
						h('div', null, notice),
					),
				);
			}

			const openResultNode = openResult === undefined
				? null
				: h(
						'div',
						{ className: cx('openResult') },
						h(
							'div',
							{ className: cx('openResultMain') },
							h('div', { className: cx('openResultTitle') }, msg('workspaceOpenResultTitle', { host: openResult.host })),
							h('div', { className: cx('openResultBody') }, msg('workspaceOpenResultBody')),
						),
						h(
							'div',
							{ className: cx('openResultActions') },
							h('a', { className: cx('link'), href: openResult.url, target: '_blank', rel: 'noopener noreferrer' }, msg('workspaceOpenHost')),
							h(ActionButton, { tone: 'ghost', small: true, onClick: () => setOpenResult(undefined) }, msg('workspaceOpenResultClose')),
						),
					);

			const sessionRow = (host, session, index) => {
				const sessionId = str(session.id);
				const key = 'session:' + str(host.id) + ':' + sessionId;
				const hostBusy = pending['open:' + str(host.id)] === true || pending['stop:' + str(host.id)] === true;
				const busy = pending[key] === true;
				const blank = session.blank === true;
				const title = str(session.title) || msg(blank ? 'workspaceSessionBlank' : 'workspaceSessionUntitled');
				const time = relativeTime(t, str(session.lastActiveAt));
				return h(
					'button',
					{
						type: 'button',
						key: sessionId || 'session-' + index,
						className: cxw('session', blank ? 'sessionBlank' : undefined),
						disabled: busy || hostBusy,
						'aria-busy': busy ? 'true' : undefined,
						title: sessionId,
						onClick: () => openSession(host, session),
					},
					busy ? h(Spinner, null) : h('span', { className: cxw('sessionDot'), 'aria-hidden': 'true' }),
					h('span', { className: cxw('sessionTitle') }, title),
					time.length > 0 ? h('span', { className: cxw('sessionTime') }, time) : null,
					session.pinned === true ? h(Badge, { tone: 'badgeBusiness' }, msg('workspaceSessionPinned')) : null,
					session.archived === true ? h(Badge, null, msg('workspaceSessionArchived')) : null,
					h('span', { className: cxw('sessionOpen') }, msg('workspaceSessionOpen')),
				);
			};

			const workspaceBlock = (host, workspace, index) => {
				const path = str(workspace.path);
				const title = str(workspace.title) || path || msg('workspaceSessionUntitled');
				const sessions = Array.isArray(workspace.sessions) ? workspace.sessions.filter((session) => asObject(session) !== undefined) : [];
				const mixedKey = 'mixed:' + str(host.id) + ':' + path;
				const mixedPending = pending[mixedKey] === true;
				return h(
					'div',
					{ className: cxw('workspace'), key: (path || 'workspace') + '-' + index },
					h(
						'div',
						{ className: cxw('workspaceHeader') },
						h('span', { className: cxw('workspaceTitle') }, title),
						path.length > 0 && path !== title ? h('code', { className: cxw('workspacePath') }, path) : null,
						h('span', { className: cxw('workspaceCount') }, msg('workspaceSessionCount', { count: sessions.length })),
						path.length > 0
							? h(
								'span',
								{ key: 'mixed-action', className: cxw('workspaceAction') },
								h(
									ActionButton,
									{
										tone: 'ghost',
										small: true,
										pending: mixedPending,
										title: msg('workspaceOpenHereHint'),
										onClick: () => openHere(host, path, title),
									},
									mixedPending ? msg('workspaceOpenHerePending') : msg('workspaceOpenHere'),
								),
							)
							: null,
					),
					sessions.length === 0
						? h('div', { className: cxw('emptyRow') }, msg('workspaceEmptyWorkspace'))
						: h('div', { className: cxw('sessionList') }, sessions.map((session, at) => sessionRow(host, session, at))),
				);
			};

			const hostBlock = (host, index) => {
				const id = str(host.id);
				const name = hostLabel(host);
				const alias = str(host.alias);
				const runtime = hostRuntime(host);
				const workspaces = Array.isArray(host.workspaces) ? host.workspaces.filter((workspace) => asObject(workspace) !== undefined) : [];
				const sessionCount = workspaces.reduce(
					(total, workspace) => total + (Array.isArray(workspace.sessions) ? workspace.sessions.length : 0),
					0,
				);
				const opening = pending['open:' + id] === true;
				const stopping = pending['stop:' + id] === true;
				const remoteWorkspace = str(host.remoteWorkspace);
				const mixedKey = 'mixed:' + id + ':' + remoteWorkspace;
				const mixedPending = pending[mixedKey] === true;
				const actions = [
					h(
						ActionButton,
						{ key: 'open', tone: 'primary', pending: opening, disabled: stopping, onClick: () => openHostWindow(host) },
						opening ? msg('workspaceOpening') : msg('workspaceOpenHost'),
					),
				];
				if (remoteWorkspace.length > 0) {
					actions.push(
						h(
							ActionButton,
							{
								key: 'mixed',
								tone: 'secondary',
								pending: mixedPending,
								disabled: opening || stopping,
								title: msg('workspaceOpenHereHint'),
								onClick: () => openHere(host, remoteWorkspace, hostLabel(host)),
							},
							mixedPending ? msg('workspaceOpenHerePending') : msg('workspaceOpenHere'),
						),
					);
				}
				if (runtime.running || (runtime.phase !== 'idle' && runtime.phase !== 'failed')) {
					actions.push(
						h(
							ActionButton,
							{ key: 'stop', tone: 'danger', pending: stopping, disabled: opening, onClick: () => stopHost(host) },
							stopping ? msg('workspaceStopping') : msg('workspaceStopHost'),
						),
					);
				}
				return h(
					'section',
					{ className: cxw('host'), key: id || 'host-' + index },
					h(
						'div',
						{ className: cxw('hostHeader') },
						h(
							'div',
							{ className: cxw('hostHeading') },
							h(
								'div',
								{ className: cxw('hostTitle') },
								h('span', { className: cxw('hostName') }, name),
								alias.length > 0 && alias !== name ? h('span', { className: cxw('hostAlias') }, alias) : null,
								h(Badge, { tone: phaseTone(runtime.phase) }, phaseLabel(t, runtime.phase)),
								runtime.running ? h(Badge, { tone: 'badgeSuccess' }, msg('workspaceRunning')) : null,
								h('span', { className: cxw('hostCount') }, msg('workspaceSessionsCount', { count: sessionCount })),
							),
							remoteWorkspace.length > 0 ? h('div', { className: cxw('hostMeta') }, msg('workspaceRemoteDir', { path: remoteWorkspace })) : null,
						),
						h('div', { className: cxw('hostActions') }, actions),
					),
					workspaces.length === 0
						? h('div', { className: cxw('emptyRow') }, msg('workspaceEmptyHost'))
						: h('div', { className: cxw('workspaces') }, workspaces.map((workspace, at) => workspaceBlock(host, workspace, at))),
				);
			};

			let body;
			if (data === undefined) {
				body = loading
					? h(Banner, { tone: 'info' }, h('div', { className: cxw('loadingRow') }, h(Spinner, null), msg('workspaceLoading')))
					: null;
			} else if (hosts.length === 0) {
				body = h(
					'div',
					{ className: cxw('empty') },
					h('h2', { className: cxw('emptyTitle') }, msg('workspaceEmptyTitle')),
					h('p', { className: cxw('emptyBody') }, msg('workspaceEmptyBody')),
				);
			} else {
				body = h('div', { className: cxw('hosts') }, hosts.map((host, index) => hostBlock(host, index)));
			}

			return h(
				'div',
				{ className: cxw('page') },
				h(
					'header',
					{ className: cxw('header') },
					h(
						'div',
						{ className: cxw('heading') },
						h('h1', { className: cxw('title') }, msg('workspacePageTitle')),
						h('p', { className: cxw('subtitle') }, msg('workspacePageSubtitle')),
						h(
							'div',
							{ className: cxw('meta') },
							h('span', null, msg('workspaceHostCount', { count: hosts.length })),
							h('span', null, msg('workspaceSessionsCount', { count: totalSessions })),
							updatedAt.length > 0 ? h('span', null, msg('workspaceLastUpdated', { time: updatedAt })) : null,
						),
					),
					h(
						'div',
						{ className: cxw('toolbar') },
						h(
							ActionButton,
							{ tone: 'secondary', pending: refreshing, onClick: () => void refresh(), ariaLabel: msg('workspaceRefresh') },
							refreshing ? msg('workspaceRefreshing') : msg('workspaceRefresh'),
						),
					),
				),
				banners.length === 0 ? null : h('div', { className: cxw('banners') }, banners),
				openResultNode,
				body,
			);
		}

		/** Render the remote-workspace page inside the shared error boundary. */
		function RemoteWorkspacePanel(props) {
			return h(PanelErrorBoundary, { t: props.t }, h(RemoteWorkspacePage, props));
		}

		/**
		 * Services the panels need: the RPC connection, the slot registry, locale,
		 * and the ordinary Workspace/Session controllers used to open a mixed
		 * remote workspace in this window.
		 */
		const inject = ['connection', 'slots', 'locale', 'workspaces', 'uiWorkspace'];

		/**
		 * Register the locale dictionaries, both stylesheets, the two sidebar
		 * entries and the main panel each one opens.
		 * @param ctx - the client plugin context.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'remote-ssh: dictionaries');
			ctx.effect(() => installStyles(), 'remote-ssh: panel styles');
			const t = ctx.locale.bind(NS);
			const baseApi = createApi(ctx);
			/**
			 * Panel API plus the mixed-mode action. The Host half only prepares the SSH
			 * world and the local mirror path; registering the Workspace and opening
			 * its session stays on the ordinary client APIs, so the sidebar, session
			 * log, and conversation surfaces need no special case.
			 */
			const api = {
				...baseApi,
				async openRemoteWorkspaceHere(input) {
					const hostId = str(input?.hostId);
					const remotePath = str(input?.remotePath);
					if (hostId.length === 0 || remotePath.length === 0) {
						throw new Error('hostId and remotePath are required');
					}
					const result = await baseApi.registerMixedWorkspace({ id: hostId, remotePath });
					const record = asObject(result) ?? {};
					const workspaceRecord = asObject(record.workspace) ?? {};
					const mountPath = str(record.mountPath) || str(workspaceRecord.mountPath);
					if (mountPath.length === 0) throw new Error('mixed workspace did not return a mount path');
					let view;
					try {
						view = await ctx.workspaces.create({ path: mountPath });
					} catch (error) {
						// Do not leave a registered mirror that no Workspace can reach.
						const entryId = str(workspaceRecord.id);
						if (entryId.length > 0) {
							try {
								await baseApi.removeMixedWorkspace({ id: entryId });
							} catch {
								// The original failure is the one worth reporting.
							}
						}
						throw error;
					}
					const label = str(input?.title)
						|| [str(workspaceRecord.hostAlias), str(workspaceRecord.remotePath)].filter((part) => part.length > 0).join(' · ');
					if (label.length > 0 && view.title !== label) {
						try {
							await ctx.workspaces.rename(view.workspaceId, label);
						} catch {
							// The mirror path remains usable even when the Host refuses a title.
						}
					}
					await ctx.uiWorkspace.openWorkspace(view.workspaceId);
					return { mountPath, workspaceId: view.workspaceId };
				},
			};
			ctx.slots.inject('sidebar.panellist', () =>
				ctx.slots.register(
					{
						name: 'sidebar.panellist',
						id: PANEL_ID,
						order: 20,
						label: () => t('panel'),
						locale: NS,
					},
					RemoteSshIcon,
				),
			);
			ctx.slots.inject('main', () =>
				ctx.slots.register(
					{
						name: 'main',
						key: PANEL_ID,
						locale: NS,
						inject: () => ({ api }),
					},
					RemoteSshPanel,
				),
			);
			ctx.effect(() => installWorkspaceStyles(), 'remote-workspace: panel styles');
			ctx.slots.inject('sidebar.panellist', () =>
				ctx.slots.register(
					{
						name: 'sidebar.panellist',
						id: WORKSPACE_PANEL_ID,
						order: 21,
						label: () => t('workspacePanel'),
						locale: NS,
					},
					RemoteWorkspaceIcon,
				),
			);
			ctx.slots.inject('main', () =>
				ctx.slots.register(
					{
						name: 'main',
						key: WORKSPACE_PANEL_ID,
						locale: NS,
						inject: () => ({ api }),
					},
					RemoteWorkspacePanel,
				),
			);
		}

		return { inject, apply };
	},
});
