/**
 * Authenticated RPC bridge between the browser panel and the Host controller.
 *
 * One exact Fetch route per endpoint rides the Connection service's own `/api`
 * channel, which already applies the Host/Origin fence and browser
 * authentication. The browser posts `{type:'client-request', rpcId, payload}`
 * and receives `{type:'server-response', rpcId, result}`.
 * @module @junjiangao/dsh-plugin-remote-ssh/rpc
 */
import { RemoteSshError, ERROR_CODES, toRemoteSshError } from './errors.js';

/** Shared channel mounted by the Connection service. */
const API_CHANNEL = '/api';
/** Endpoint prefix this plugin owns. */
const PREFIX = 'remote-ssh';
/** Largest accepted request body, in bytes. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Every endpoint, in registration order. */
export const ENDPOINTS = [
	'snapshot',
	'remoteWorkspaces',
	'saveHost',
	'deleteHost',
	'testConnection',
	'doctor',
	'installHelper',
	'openHost',
	'openUrl',
	'stopHost',
	'mixedWorkspaces',
	'registerMixedWorkspace',
	'removeMixedWorkspace',
];

/** Absolute Fetch path for one endpoint. */
export function routePath(endpoint) {
	return `${API_CHANNEL}/${PREFIX}/${endpoint}`;
}

/**
 * Register every endpoint.
 * @param ctx - Host plugin Context with `connection`.
 * @param controller - the remote SSH controller.
 * @returns a disposer removing all routes.
 */
export function registerRpc(ctx, controller) {
	const disposers = ENDPOINTS.map((endpoint) => ctx.effect(
		() => ctx.connection.fetch.register({
			path: routePath(endpoint),
			methods: ['POST'],
			requestBody: 'buffered',
			fetch: (request) => handleRequest(controller, endpoint, request),
		}),
		`remote-ssh: ${routePath(endpoint)} route`,
	));
	return async () => {
		await Promise.all(disposers.map((dispose) => Promise.resolve(dispose())));
	};
}

/** Validate, dispatch and frame one request. */
async function handleRequest(controller, endpoint, request) {
	if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
		return new Response(null, { status: 415 });
	}
	const declaredLength = request.headers.get('content-length');
	if (declaredLength !== null && Number(declaredLength) > MAX_BODY_BYTES) {
		return new Response(null, { status: 413 });
	}
	let text;
	try {
		text = await request.text();
	} catch {
		return new Response(null, { status: 400 });
	}
	if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return new Response(null, { status: 413 });
	let envelope;
	try {
		envelope = JSON.parse(text);
	} catch {
		return new Response(null, { status: 400 });
	}
	const parsed = parseClientRequest(envelope);
	if (parsed === undefined) return new Response(null, { status: 400 });
	let result;
	try {
		const value = await dispatch(controller, endpoint, parsed.payload, request.signal);
		result = { ok: true, value };
	} catch (error) {
		const wrapped = error instanceof RemoteSshError
			? error
			: toRemoteSshError(error, `${endpoint} failed`);
		result = { ok: false, error: wrapped.toRpcError() };
	}
	const response = { type: 'server-response', rpcId: parsed.rpcId, result };
	return new Response(JSON.stringify(response), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	});
}

/** Validate the browser envelope before dispatch. */
function parseClientRequest(value) {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
	if (value.type !== 'client-request' || typeof value.rpcId !== 'string' || value.rpcId.length === 0) return undefined;
	if (value.rpcId.length > 256) return undefined;
	return { rpcId: value.rpcId, payload: value.payload };
}

/** Route one decoded payload to the controller. */
async function dispatch(controller, endpoint, payload, signal) {
	const input = typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? payload : {};
	switch (endpoint) {
		case 'snapshot':
			return controller.snapshot();
		case 'remoteWorkspaces':
			return controller.remoteWorkspaces();
		case 'saveHost':
			return controller.saveHost(input.host);
		case 'deleteHost':
			return controller.deleteHost(requireId(input));
		case 'testConnection':
			return controller.testConnection(input);
		case 'doctor':
			return controller.doctor(requireId(input));
		case 'installHelper':
			if (input.confirm !== true) {
				throw new RemoteSshError(ERROR_CODES.validation, 'helper installation needs explicit confirmation');
			}
			return controller.installHelper(requireId(input));
		case 'openHost': {
			const options = { allowInstall: input.allowInstall === true };
			// Optional deep link: the controller writes a pending marker that the
			// remote window claims once its session registry is ready.
			if (typeof input.sessionId === 'string' && input.sessionId !== '') options.sessionId = input.sessionId;
			return controller.openHost(requireId(input), options);
		}
		case 'openUrl':
			return controller.openUrl(requireId(input));
		case 'stopHost':
			return controller.stopHost(requireId(input));
		case 'mixedWorkspaces':
			return controller.mixedWorkspaces();
		case 'registerMixedWorkspace':
			return controller.registerMixedWorkspace(requireId(input), {
				remotePath: input.remotePath,
				signal,
			});
		case 'removeMixedWorkspace':
			return controller.removeMixedWorkspace(requireId(input));
		default:
			throw new RemoteSshError(ERROR_CODES.notFound, `unknown endpoint ${endpoint}`);
	}
}

/** Read a required host id. */
function requireId(input) {
	if (typeof input.id !== 'string' || input.id === '') {
		throw new RemoteSshError(ERROR_CODES.validation, 'id is required');
	}
	return input.id;
}
