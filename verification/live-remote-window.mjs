#!/usr/bin/env node
/**
 * Optional live check for the plugin-owned remote window UI.
 *
 *   node verification/live-remote-window.mjs --alias MyOracleCloud-dsh
 *
 * It opens a real remote window through the controller, then drives a local
 * headless Chromium over the DevTools protocol (no Playwright dependency) to
 * prove three things that unit tests cannot:
 *
 *   1. the session deeplink marker reveals the requested Session;
 *   2. Add workspace opens the REMOTE directory listing (a temp directory
 *      created only on the SSH host is visible);
 *   3. the remote window composition itself boots (no missing provider).
 *
 * It writes an optional screenshot to verification/out/live-remote-window.png.
 * The real plugin data directory and the existing dsh-remote profile are used,
 * exactly like a user click; the instance is stopped and the remote temp
 * directory removed in the finally block. Never run by CI.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { RemoteSshController } from "../lib/controller.js";
import { resolveConfig } from "../lib/config.js";
import { resolveRuntime } from "../lib/paths.js";
import { quote, runProcess } from "../lib/ssh.js";

const CHROME_CANDIDATES = [
	process.env.RSSH_CHROME,
	join(homedir(), ".cache", "ms-playwright", "chromium-1217", "chrome-linux64", "chrome"),
	"/usr/bin/chromium",
	"/usr/bin/google-chrome",
].filter((value) => typeof value === "string" && value !== "");
const SESSION_KEY = "dsh.sessions.current";
const MARKER_PREFIX = "rssh-live-";

const { values } = parseArgs({
	options: {
		alias: { type: "string" },
		version: { type: "string" },
		timeout: { type: "string" },
		json: { type: "boolean", default: false },
		screenshot: { type: "boolean", default: true },
	},
	allowPositionals: false,
});

function log(message) {
	if (values.json !== true) process.stderr.write(message + "\n");
}

/** Poll one predicate until it returns truthy or the deadline passes. */
async function until(predicate, timeoutMs, intervalMs = 250) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			const value = await predicate();
			if (value) return value;
		} catch {
			// transient while the child boots
		}
		if (Date.now() >= deadline) return undefined;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}

/** Launch headless Chromium with the DevTools protocol on an ephemeral port. */
function launchChrome(userDataDir) {
	const executable = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
	if (executable === undefined) throw new Error("live window: cannot find a Chromium binary");
	const child = spawn(executable, [
		"--headless=new",
		"--no-sandbox",
		"--disable-gpu",
		"--disable-dev-shm-usage",
		"--no-first-run",
		"--no-default-browser-check",
		"--remote-debugging-port=0",
		"--user-data-dir=" + userDataDir,
		"about:blank",
	], { stdio: ["ignore", "ignore", "pipe"] });
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("live window: Chromium DevTools did not start")), 20_000);
		let buffer = "";
		child.stderr.on("data", (chunk) => {
			buffer += chunk.toString();
			const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffer);
			if (match === null) return;
			clearTimeout(timer);
			resolve({ child, browserWs: match[1] });
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			reject(new Error("live window: Chromium exited early (code " + String(code) + ")"));
		});
	});
}

/** Minimal DevTools protocol client. */
class Cdp {
	constructor(socket) {
		this.socket = socket;
		this.nextId = 0;
		this.pending = new Map();
		socket.addEventListener("message", (event) => {
			const message = JSON.parse(String(event.data));
			if (message.id === undefined) return;
			const pending = this.pending.get(message.id);
			if (pending === undefined) return;
			this.pending.delete(message.id);
			if (message.error !== undefined) pending.reject(new Error(message.error.message));
			else pending.resolve(message.result);
		});
	}

	static async connect(wsUrl) {
		const socket = new WebSocket(wsUrl);
		await new Promise((resolve, reject) => {
			socket.addEventListener("open", resolve, { once: true });
			socket.addEventListener("error", () => reject(new Error("live window: DevTools socket failed")), { once: true });
		});
		return new Cdp(socket);
	}

	send(method, params = {}) {
		const id = (this.nextId += 1);
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.socket.send(JSON.stringify({ id, method, params }));
		});
	}

	async evaluate(expression) {
		const result = await this.send("Runtime.evaluate", {
			expression,
			returnByValue: true,
			awaitPromise: true,
			userGesture: true,
		});
		if (result.exceptionDetails !== undefined) {
			throw new Error("live window: page evaluation failed: " + JSON.stringify(result.exceptionDetails));
		}
		return result.result.value;
	}

	close() {
		try {
			this.socket.close();
		} catch {
			// already closed
		}
	}
}

/** Open a new DevTools target and connect to it. */
async function attachTarget(browserWs) {
	const url = new URL(browserWs);
	const base = "http://" + url.host;
	const response = await fetch(base + "/json/new?url=about:blank", { method: "PUT" });
	if (!response.ok) throw new Error("live window: cannot create a DevTools target: " + String(response.status));
	const target = await response.json();
	const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
	await cdp.send("Page.enable");
	await cdp.send("Runtime.enable");
	return { cdp, base };
}

/** Wait until the SPA rendered its sidebar. */
async function waitForApp(cdp, timeoutMs = 60_000) {
	return await until(async () => await cdp.evaluate(
		"document.readyState === \"complete\" && document.body !== null && document.body.innerText.length > 120"
	), timeoutMs);
}

/** List the sidebar buttons so the selector stays readable when the UI changes. */
async function interactive(cdp) {
	return await cdp.evaluate([
		"(() => {",
		"  const nodes = [...document.querySelectorAll(\"button, [role=button], a[href], [role=menuitem]\")];",
		"  return nodes.slice(0, 200).map((node) => ({",
		"    tag: node.tagName.toLowerCase(),",
		"    text: (node.innerText || node.textContent || \"\").trim().slice(0, 80),",
		"    aria: node.getAttribute(\"aria-label\") || \"\",",
		"    title: node.getAttribute(\"title\") || \"\",",
		"  }));",
		"})()",
	].join("\n"));
}

/** Click the first interactive element whose text/aria/title matches. */
async function clickMatching(cdp, source) {
	const regex = new RegExp(source, "i");
	return await cdp.evaluate([
		"(() => {",
		"  const candidates = [...document.querySelectorAll(\"button, [role=button], a[href], [role=menuitem]\")];",
		"  for (const node of candidates) {",
		"    const label = [(node.innerText || node.textContent || \"\"), node.getAttribute(\"aria-label\") || \"\", node.getAttribute(\"title\") || \"\"].join(\" \");",
		"    if (" + regex.toString() + ".test(label)) {",
		"      node.click();",
		"      return label.trim().slice(0, 120);",
		"    }",
		"  }",
		"  return null;",
		"})()",
	].join("\n"));
}

/** Text of the visible dialog, or null when none is open. */
async function dialogText(cdp) {
	return await cdp.evaluate([
		"(() => {",
		"  const nodes = [...document.querySelectorAll(\"[role=dialog], dialog, [class*=dialog i]\")];",
		"  const visible = nodes.filter((node) => {",
		"    const style = window.getComputedStyle(node);",
		"    if (style.display === \"none\" || style.visibility === \"hidden\") return false;",
		"    const rect = node.getBoundingClientRect();",
		"    return rect.width > 0 && rect.height > 0;",
		"  });",
		"  const node = visible[visible.length - 1];",
		"  return node === undefined ? null : node.innerText;",
		"})()",
	].join("\n"));
}

/** Persisted main selection, decoded from the Workspace store. */
async function persistedSession(cdp) {
	return await cdp.evaluate([
		"(() => {",
		"  try {",
		"    const raw = window.localStorage.getItem(" + JSON.stringify(SESSION_KEY) + ");",
		"    return raw === null ? null : JSON.parse(raw);",
		"  } catch {",
		"    return null;",
		"  }",
		"})()",
	].join("\n"));
}

/** Run one ssh command through the plugin ssh_config. */
async function remote(config, alias, command) {
	const result = await runProcess("/usr/bin/ssh", [
		"-F", config.sshConfigPath,
		"-o", "BatchMode=yes",
		"-o", "ConnectTimeout=15",
		"--", alias, command,
	], { timeoutMs: 30_000 });
	if (result.code !== 0) throw new Error("live window: remote command failed: " + result.stderr.trim());
	return result.stdout;
}

async function main() {
	if (values.alias === undefined || values.alias.trim() === "") {
		throw new Error("--alias is required (a managed host alias or an ssh_config alias)");
	}
	const alias = values.alias.trim();
	const timeoutMs = values.timeout === undefined ? 240_000 : Number(values.timeout);
	const runtime = resolveRuntime();
	const version = values.version ?? process.env.DSH_VERSION ?? runtime.version;
	if (version === undefined || version === "") {
		throw new Error("cannot determine the DSH version; pass --version (for example 0.2.1-rc.2)");
	}
	const config = resolveConfig({
		dataDir: join(homedir(), ".dsh", "remote-ssh"),
		sshConfigPath: join(homedir(), ".dsh", "remote-ssh", "ssh_config"),
		sshPackageVersion: version,
		inheritDesktopSettings: true,
		mirrorWorkspace: true,
	});
	const result = { alias, phases: [], ok: false };
	let controller;
	let chrome;
	let userDataDir;
	let cdp;
	let bc;
	const markerName = MARKER_PREFIX + String(Date.now());
	const remoteDirectory = "$HOME/" + markerName;
	let markerCreated = false;
	let sessionId;
	try {
		controller = new RemoteSshController({}, config);
		await controller.start();
		const snapshot = await controller.snapshot();
		const host = snapshot.hosts.find((entry) => entry.alias === alias && entry.source === "managed")
			?? snapshot.hosts.find((entry) => entry.alias === alias);
		if (host === undefined) throw new Error("host alias " + alias + " is not visible to the plugin");
		result.hostId = host.id;
		const inventory = await controller.remoteWorkspaces();
		const workspaceHost = inventory.hosts.find((entry) => entry.id === host.id);
		const sessions = workspaceHost === undefined ? [] : workspaceHost.workspaces.flatMap((entry) => entry.sessions);
		const chosen = sessions.find((entry) => entry.blank !== true) ?? sessions[0];
		sessionId = chosen === undefined ? undefined : chosen.id;
		result.sessionId = sessionId;
		log("[1/6] remote window " + alias + " (host " + host.id + ", session " + String(sessionId) + ")");
		// A directory that exists only on the SSH host proves the picker is remote.
		await remote(config, alias, "mkdir -p -- \"" + remoteDirectory + "\"");
		markerCreated = true;
		const opened = await controller.openHost(host.id, sessionId === undefined ? {} : { sessionId });
		result.jobId = opened.jobId;
		let instance;
		await until(async () => {
			const current = await controller.snapshot();
			instance = current.hosts.find((entry) => entry.id === host.id)?.instance;
			if (instance !== undefined && instance.phase !== result.phases.at(-1)?.phase) {
				result.phases.push({ phase: instance.phase, message: instance.message });
				log("      " + instance.phase + (instance.message === undefined ? "" : " - " + instance.message));
			}
			return instance !== undefined && (instance.phase === "running" || instance.phase === "failed");
		}, timeoutMs, 1_000);
		if (instance?.phase !== "running") throw new Error("remote window did not reach running (last phase " + String(instance?.phase) + ")");
		const { url } = await controller.openUrl(host.id);
		result.url = url.replace(/token=[^&]+/, "token=<redacted>");
		userDataDir = await mkdtemp(join(tmpdir(), "rssh-live-chrome-"));
		chrome = await launchChrome(userDataDir);
		const attached = await attachTarget(chrome.browserWs);
		cdp = attached.cdp;
		bc = attached.base;
		log("[2/6] navigating to the tokenized remote window URL");
		await cdp.send("Page.navigate", { url });
		if (!(await waitForApp(cdp))) throw new Error("remote window UI did not render");
		if (sessionId !== undefined) {
			const selected = await until(async () => {
				const selection = await persistedSession(cdp);
				return selection !== null && selection.sessionId === sessionId ? selection : undefined;
			}, 45_000, 500);
			result.deeplink = selected === undefined ? "not applied" : "applied";
			log("[3/6] session deeplink: " + result.deeplink);
		}
		log("[4/6] opening Add workspace");
		const buttonsBefore = await interactive(cdp);
		const clicked = await clickMatching(cdp, "add workspace|添加工作区|添加目录|打开文件夹|选择文件夹|浏览目录");
		if (clicked === null) {
			result.buttons = buttonsBefore.filter((entry) => entry.text !== "" || entry.aria !== "").slice(0, 60);
			throw new Error("cannot find an Add workspace control; buttons were dumped into result.buttons");
		}
		result.addWorkspaceControl = clicked;
		const markerVisible = await until(async () => {
			const text = await dialogText(cdp);
			return typeof text === "string" && text.includes(markerName) ? text : undefined;
		}, 30_000, 500);
		if (markerVisible === undefined) {
			const text = await dialogText(cdp);
			result.dialog = typeof text === "string" ? text.slice(0, 2000) : null;
			const buttons = await interactive(cdp);
			result.dialogButtons = buttons.filter((entry) => entry.text !== "" || entry.aria !== "").slice(0, 40);
			throw new Error("the remote-only directory " + markerName + " is not visible in the directory dialog; dialog text: " + JSON.stringify(result.dialog));
		}
		result.remotePicker = "remote listing contains " + markerName;
		log("[5/6] remote picker: " + result.remotePicker);
		if (values.screenshot !== false) {
			const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
			const file = join(process.cwd(), "verification", "out", "live-remote-window.png");
			await writeFile(file, Buffer.from(shot.data, "base64"));
			result.screenshot = file;
		}
		// The same running window must follow a *second* panel click: this is the
		// reused-instance path where the window is not restarted and only the
		// follow-up claim watch can reveal the new Session.
		if (sessionId !== undefined && sessions.length > 1) {
			const second = sessions.find((entry) => entry.id !== sessionId);
			if (second !== undefined) {
				await cdp.evaluate("document.dispatchEvent(new KeyboardEvent(\"keydown\", { key: \"Escape\", bubbles: true }))");
				const openedAgain = await controller.openHost(host.id, { sessionId: second.id });
				result.reused = openedAgain.reused === true;
				const swapped = await until(async () => {
					const selection = await persistedSession(cdp);
					return selection !== null && selection.sessionId === second.id;
				}, 45_000, 500);
				result.deeplinkReuse = swapped ? "applied" : "not applied";
				log("[6/6] reused window deeplink: " + result.deeplinkReuse + " (reused=" + String(result.reused) + ")");
				if (!swapped) throw new Error("a reused remote window did not follow the second session marker");
			}
		}
		result.ok = true;
		log("[7/7] live remote window OK");
	} finally {
		if (cdp !== undefined) cdp.close();
		if (chrome !== undefined) {
			try {
				chrome.child.kill("SIGKILL");
			} catch {
				// gone
			}
		}
		if (userDataDir !== undefined) await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
		if (controller !== undefined) {
			try {
				if (result.hostId !== undefined) await controller.stopHost(result.hostId);
			} catch {
				// best effort
			}
			await controller.dispose().catch(() => undefined);
		}
		if (markerCreated) {
			await remote(config, alias, "rmdir -- \"" + remoteDirectory + "\"").catch(() => undefined);
		}
	}
	return result;
}

try {
	const result = await main();
	if (values.json === true) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
	else process.stdout.write("\n[OK] " + result.alias + " (" + (result.deeplink ?? "no session") + ", " + result.remotePicker + ")\n");
	process.exitCode = result.ok ? 0 : 1;
} catch (error) {
	process.stderr.write("live remote window failed: " + (error instanceof Error ? error.message : String(error)) + "\n");
	process.exitCode = 1;
}
