/**
 * One-shot Session deeplink, browser half, for the plugin-owned remote window.
 *
 * The Host half registers `POST /api/remote-session-deeplink/claim`, which
 * returns `{ sessionId }` once (or `{}` when the main window did not leave a
 * marker). This bundle claims that id after boot, waits for the Workspace and
 * Session baselines, and then reveals the Session through the public
 * `uiWorkspace.openSession()` navigation API.
 *
 * Startup ordering is the subtle part: the Workspace plugin restores the
 * previous selection (persisted under `dsh.sessions.current`) as soon as both
 * baselines are ready, and that restoration must not undo this deeplink. If the
 * deeplink wins first, the restoration sees a main Session and skips; if the
 * restoration wins first, this bundle re-applies the target after the store
 * settles, verifying the persisted selection instead of assuming the call
 * stuck. After boot the bundle keeps watching for later markers while the
 * window is visible, so a panel click on an *already running* instance (where
 * the window is reused instead of restarted) still reveals the chosen Session.
 * Everything is best-effort: no connection, no Session row (deleted or archived
 * history), or a missing service all end silently instead of breaking the
 * remote window.
 */
window.__ModuleLoader__.load({
	id: '@junjiangao/dsh-plugin-remote-ssh-session-deeplink',
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;

		/** Absolute Connection channel the Host route lives under. */
		const CHANNEL = '/api';
		/** Channel-relative endpoint registered by this package's Host half. */
		const CLAIM_ENDPOINT = 'remote-session-deeplink/claim';
		/** Accepted Session id shape; anything else is ignored. */
		const SESSION_ID_RE = /^session-[A-Za-z0-9][A-Za-z0-9-]{0,120}$/;
		/** localStorage key of the Workspace plugin's persisted main selection. */
		const SELECTION_KEY = 'dsh.sessions.current';
		/** Baseline / Session-row polling cadence. */
		const POLL_MS = 100;
		/** Claim attempts while the Connection is still warming up. */
		const CLAIM_ATTEMPTS = 3;
		/** Delay between claim attempts. */
		const CLAIM_RETRY_MS = 500;
		/** How long the Workspace/Session baselines may take before giving up. */
		const BASELINE_TIMEOUT_MS = 20_000;
		/** How long the claimed Session may take to appear in the Session list. */
		const SESSION_TIMEOUT_MS = 8_000;
		/** Re-apply attempts when the startup restoration overwrites the target. */
		const APPLY_ATTEMPTS = 4;
		/** Quiet window after an apply that proves the selection stuck. */
		const SETTLE_MS = 1_200;
		/** Follow-up claim cadence while the remote window is visible. */
		const WATCH_MS = 3_000;

		/** Sleep helper (browser timers only). */
		const sleep = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

		/** The currently persisted main Session id, or undefined. */
		function persistedSelection() {
			try {
				const raw = window.localStorage.getItem(SELECTION_KEY);
				if (raw === null) return undefined;
				const parsed = JSON.parse(raw);
				return typeof parsed?.sessionId === 'string' ? parsed.sessionId : undefined;
			} catch {
				return undefined;
			}
		}

		/** Claim the one-shot marker; a valid empty answer ends the flow. */
		async function claimSessionId(ctx) {
			const connection = ctx.get('connection');
			if (connection === undefined) return undefined;
			for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
				try {
					const result = await connection.rpc.call(CHANNEL, CLAIM_ENDPOINT, {});
					if (result?.ok !== true) return undefined;
					const sessionId = result.value?.sessionId;
					return typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId) ? sessionId : undefined;
				} catch {
					if (attempt + 1 < CLAIM_ATTEMPTS) await sleep(CLAIM_RETRY_MS);
				}
			}
			return undefined;
		}

		/** Both baselines at `ready`, or undefined while still arriving. */
		function readyBaseline(ctx) {
			const workspaces = ctx.get('workspaces')?.list?.getSnapshot?.();
			const sessions = ctx.get('sessions')?.list?.getSnapshot?.();
			if (workspaces === undefined || sessions === undefined) return undefined;
			if (workspaces.phase !== 'ready' || sessions.phase !== 'ready') return undefined;
			return sessions;
		}

		/** Wait until the claimed Session is a known Session row. */
		async function waitForSessionRow(ctx, sessionId) {
			const deadline = Date.now() + SESSION_TIMEOUT_MS;
			for (;;) {
				const sessions = readyBaseline(ctx);
				if (sessions !== undefined && sessions.byId?.[sessionId] !== undefined) return true;
				if (Date.now() >= deadline) return false;
				await sleep(POLL_MS);
			}
		}

		/** Reveal the Session, surviving the competing startup restoration. */
		async function revealAfterRestore(ctx, sessionId) {
			const baselineDeadline = Date.now() + BASELINE_TIMEOUT_MS;
			while (readyBaseline(ctx) === undefined) {
				if (Date.now() >= baselineDeadline) return;
				await sleep(POLL_MS);
			}
			if (!(await waitForSessionRow(ctx, sessionId))) return;
			if (persistedSelection() === sessionId) return;
			const uiWorkspace = ctx.get('uiWorkspace');
			if (uiWorkspace === undefined || typeof uiWorkspace.openSession !== 'function') return;
			for (let attempt = 0; attempt < APPLY_ATTEMPTS; attempt += 1) {
				try {
					uiWorkspace.openSession(sessionId);
				} catch {
					return;
				}
				const settleDeadline = Date.now() + SETTLE_MS;
				while (Date.now() < settleDeadline && persistedSelection() !== sessionId) await sleep(50);
				if (persistedSelection() !== sessionId) continue;
				// The selection stuck, but the startup restoration may still be in
				// flight and overwrite it; only a quiet window proves the reveal.
				await sleep(SETTLE_MS);
				if (persistedSelection() === sessionId) return;
			}
		}

		/** One claim-and-reveal attempt; single-flight and silent. */
		let claiming = false;
		async function claimAndReveal(ctx) {
			if (claiming) return;
			claiming = true;
			try {
				const sessionId = await claimSessionId(ctx);
				if (sessionId === undefined) return;
				await revealAfterRestore(ctx, sessionId);
			} catch {
				// Best-effort: a stale marker or a transient failure must not surface
				// as an error in the remote window.
			} finally {
				claiming = false;
			}
		}

		/** React to markers written after boot (reused window, second panel click). */
		function watchForMarkers(ctx) {
			const tick = () => {
				if (window.document.visibilityState === 'visible') void claimAndReveal(ctx);
			};
			window.setInterval(tick, WATCH_MS);
			window.document.addEventListener('visibilitychange', tick);
			window.addEventListener('focus', tick);
		}

		/** Claim at boot, then keep watching; every failure stays silent. */
		let started = false;
		function apply(ctx) {
			ctx.inject(['connection', 'sessions', 'workspaces', 'uiWorkspace'], (injected) => {
				if (started) return;
				started = true;
				void claimAndReveal(injected);
				watchForMarkers(injected);
			});
		}

		exports.apply = apply;
		return module.exports;
	},
});
