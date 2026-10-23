/**
 * Remote readiness checks without installing anything.
 *
 * Doctor never installs anything (it may create the remote workspace and the
 * local mirror directory). It reports exactly which prerequisite is
 * missing and leaves the install decision to the confirmation flow.
 * @module @junjiangao/dsh-plugin-remote-ssh/doctor
 */
import { isAbsolute } from 'node:path';
import {
	discoverRemoteFacts,
	inspectHelper,
	isSupportedNode,
	prepareLocalMirror,
	prepareRemoteWorkspace,
	tail,
} from './helper.js';
import { runRemoteScript } from './helper.js';
import { RemoteSshError, ERROR_CODES } from './errors.js';

/** One check result. */
function check(id, title, ok, extra = {}) {
	return { id, title, ok, ...extra };
}

/**
 * Run every prerequisite check for one host.
 * @param options - host, config, runtime version, profile inspector, signal.
 * @returns `{ hostId, ready, durationMs, checks, facts }`.
 */
export async function runDoctor(options) {
	const { host, config, runtimeVersion, runtimeProfile, signal } = options;
	const startedAt = Date.now();
	const checks = [];
	const facts = {};
	let connectionOk = false;
	let durationMs = 0;
	try {
		const begin = Date.now();
		facts.remote = await discoverRemoteFacts(host, config, { signal });
		durationMs = Date.now() - begin;
		connectionOk = true;
		checks.push(check('ssh', 'SSH 连接', true, {
			detail: `${facts.remote.platform} · ${Math.round(durationMs)} ms`,
		}));
	} catch (error) {
		if (error instanceof RemoteSshError && error.code === ERROR_CODES.remoteUnsupported) {
			connectionOk = true;
			checks.push(check('ssh', 'SSH 连接', true, { detail: '连接成功' }));
			checks.push(check('platform', '远端平台', false, {
				detail: error.message,
				hint: '官方 dsh-ssh 只支持 Linux 和 macOS 远端。',
			}));
		} else {
			checks.push(check('ssh', 'SSH 连接', false, {
				detail: error instanceof Error ? error.message : String(error),
				hint: '检查 ~/.ssh/config 别名、密钥、代理和主机密钥。',
			}));
		}
	}
	const remote = facts.remote;
	if (connectionOk && remote !== undefined) {
		checks.push(check('platform', '远端平台', true, { detail: remote.platform }));
		const nodeOk = remote.nodePath !== undefined && remote.nodeVersion !== undefined && isSupportedNode(remote.nodeVersion);
		checks.push(check('node', '远端 Node.js', nodeOk, {
			detail: remote.nodeVersion === undefined
				? '未找到 node'
				: `v${remote.nodeVersion}${remote.nodePath === undefined ? '' : ` (${remote.nodePath})`}`,
			hint: nodeOk ? undefined : '远端需要 Node ^22.19.0 或 >=24.0.0；安装后重新检查。',
		}));
		const npmOk = remote.npmPath !== undefined;
		checks.push(check('npm', '远端 npm', npmOk, {
			detail: remote.npmVersion === undefined ? '未找到 npm' : `v${remote.npmVersion}`,
			hint: npmOk ? undefined : '安装 npm 后才能安装远端 SSH helper。',
		}));
		// Helper state.
		let helperState;
		try {
			helperState = await inspectHelper(host, config, remote, { signal, runtimeVersion });
			facts.helper = helperState;
			const installed = helperState.status === 'installed';
			checks.push(check('helper', '远端 SSH 服务 (dsh-ssh helper)', installed, {
				detail: installed
					? `v${helperState.version} · ${helperState.path}`
					: helperState.status === 'mismatch'
						? `已安装 v${helperState.version ?? '未知'}，需要 v${helperState.expectedVersion}`
						: `未安装，需要 v${helperState.expectedVersion}`,
				hint: installed ? undefined : '打开主机时会在确认后安装。',
			}));
		} catch (error) {
			checks.push(check('helper', '远端 SSH 服务 (dsh-ssh helper)', false, {
				detail: error instanceof Error ? error.message : String(error),
			}));
		}
		// Workspace.
		try {
			const workspace = await prepareRemoteWorkspace(host, config, remote, { signal });
			facts.workspace = workspace;
			checks.push(check('workspace', '远端工作目录', workspace.writable, {
				detail: `${workspace.path}${workspace.created ? ' · 已创建' : ''}${workspace.writable ? '' : ' · 不可写'}`,
				hint: workspace.writable ? undefined : '更换 remoteWorkspace 或修正远端权限。',
			}));
			if (config.mirrorWorkspace) {
				const mirror = await prepareLocalMirror(workspace.path);
				checks.push(check('mirror', '本地镜像目录', mirror.ok, {
					optional: true,
					detail: mirror.ok ? workspace.path : `${mirror.path}: ${mirror.error ?? '创建失败'}`,
					hint: mirror.ok ? undefined : '工作区附加的宿主 realpath 校验可能失败；可手动创建同名目录。',
				}));
			}
		} catch (error) {
			checks.push(check('workspace', '远端工作目录', false, {
				detail: error instanceof Error ? error.message : String(error),
			}));
		}
	} else {
		for (const id of ['platform', 'node', 'npm', 'helper', 'workspace']) {
			checks.push(check(id, titleFor(id), false, { detail: 'SSH 连接失败，无法检查' }));
		}
	}
	// Local runtime profile.
	try {
		const profile = await runtimeProfile.inspect();
		checks.push(check('profile', '本地远端运行时', profile.ready, {
			detail: profile.ready
				? `${profile.name} · v${profile.version}`
				: profile.missing.length > 0
					? `缺少 ${profile.missing.join(', ')}`
					: `版本不匹配：${profile.mismatched.join(', ')}`,
			hint: profile.ready ? undefined : '首次打开主机时自动安装；失败时查看实例日志。',
		}));
		facts.profile = profile;
	} catch (error) {
		checks.push(check('profile', '本地远端运行时', false, {
			detail: error instanceof Error ? error.message : String(error),
		}));
	}
	// Stricter host key verification after the accept-new bootstrap.
	if (connectionOk) {
		try {
			const strict = await runRemoteScript(host, config, 'printf DSH_STRICT_OK', {
				signal,
				strictHostKeyChecking: 'yes',
			});
			checks.push(check('host-key', '主机密钥（严格模式）', strict.ok, {
				detail: strict.ok ? 'known_hosts 已包含该主机' : tail(strict.stderr, 500) || '严格校验失败',
				hint: strict.ok ? undefined : '确认第一次连接已成功写入 known_hosts。',
			}));
		} catch (error) {
			checks.push(check('host-key', '主机密钥（严格模式）', false, {
				detail: error instanceof Error ? error.message : String(error),
			}));
		}
	}
	const required = checks.filter((entry) => entry.optional !== true && entry.id !== 'helper');
	const ready = required.every((entry) => entry.ok);
	return {
		hostId: host.id,
		ready,
		durationMs: Date.now() - startedAt,
		checks,
		facts,
	};
}

/** Human title used when a check cannot run. */
function titleFor(id) {
	switch (id) {
		case 'platform': return '远端平台';
		case 'node': return '远端 Node.js';
		case 'npm': return '远端 npm';
		case 'helper': return '远端 SSH 服务 (dsh-ssh helper)';
		case 'workspace': return '远端工作目录';
		default: return id;
	}
}

/** Validate the node path chosen for the SSH provider row. */
export function resolveRemoteNode(host, config, facts) {
	const candidate = config.remoteNode ?? facts?.nodePath;
	if (typeof candidate !== 'string' || candidate === '') {
		throw new RemoteSshError(
			ERROR_CODES.remoteUnsupported,
			`cannot determine the Node executable on ${host.alias}`,
			{ hint: 'Install Node.js on the remote host, or set remoteNode in the plugin config.' },
		);
	}
	if (!isAbsolute(candidate)) {
		throw new RemoteSshError(ERROR_CODES.remoteUnsupported, `remote node path must be absolute: ${candidate}`);
	}
	return candidate;
}
