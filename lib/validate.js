/**
 * Input validation and normalization for host drafts and RPC payloads.
 *
 * The browser is untrusted input even though it is same-origin: every value
 * that reaches a filesystem write or an OpenSSH argv passes through here.
 * @module @junjiangao/dsh-plugin-remote-ssh/validate
 */
import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { validationError } from './errors.js';

/** Characters that never belong in one ssh_config token. */
const CONTROL = /[\u0000-\u001f\u007f]/;
/** A literal alias usable as `ssh <alias>` and inside a Host line. */
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** Directive names accepted in the free-form extra option list. */
const DIRECTIVE = /^[A-Za-z][A-Za-z0-9]*$/;
/** Accepted StrictHostKeyChecking values. */
export const STRICT_MODES = ['accept-new', 'yes', 'no'];

/** Trim one optional string, rejecting control characters and newlines. */
function optionalText(value, field, maxLength) {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'string') validationError(`${field} must be a string`, field);
	if (CONTROL.test(value)) validationError(`${field} must not contain control characters or newlines`, field);
	const trimmed = value.trim();
	if (trimmed === '') return undefined;
	if (trimmed.length > maxLength) validationError(`${field} must be at most ${maxLength} characters`, field);
	return trimmed;
}

/** Read one required, non-empty string. */
function requiredText(value, field, maxLength) {
	const text = optionalText(value, field, maxLength);
	if (text === undefined) validationError(`${field} is required`, field);
	return text;
}

/** Read one optional integer in a closed range. */
function optionalInteger(value, field, min, max) {
	if (value === undefined || value === null || value === '') return undefined;
	const number = typeof value === 'number' ? value : Number(value);
	if (!Number.isInteger(number)) validationError(`${field} must be an integer`, field);
	if (number < min || number > max) validationError(`${field} must be between ${min} and ${max}`, field);
	return number;
}

/** Read one optional boolean. */
function optionalBoolean(value, field) {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'boolean') validationError(`${field} must be a boolean`, field);
	return value;
}

/** Validate a host alias. */
export function validateAlias(value) {
	const alias = requiredText(value, 'alias', 64);
	if (!ALIAS.test(alias)) {
		validationError('alias must match [A-Za-z0-9][A-Za-z0-9_.-]*', 'alias');
	}
	return alias;
}

/** Validate and normalize one host draft from the browser. */
export function validateHostDraft(value) {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		validationError('host must be an object', 'host');
	}
	const draft = {};
	const id = optionalText(value.id, 'id', 128);
	if (id !== undefined) draft.id = id;
	draft.alias = validateAlias(value.alias);
	draft.displayName = optionalText(value.displayName, 'displayName', 120);
	draft.description = optionalText(value.description, 'description', 500);
	draft.hostname = requiredText(value.hostname, 'hostname', 255);
	draft.user = optionalText(value.user, 'user', 64);
	draft.port = optionalInteger(value.port, 'port', 1, 65_535);
	draft.identityFile = optionalText(value.identityFile, 'identityFile', 1024);
	draft.proxyJump = optionalText(value.proxyJump, 'proxyJump', 255);
	draft.proxyCommand = optionalText(value.proxyCommand, 'proxyCommand', 1024);
	draft.identitiesOnly = optionalBoolean(value.identitiesOnly, 'identitiesOnly');
	draft.forwardAgent = optionalBoolean(value.forwardAgent, 'forwardAgent');
	draft.serverAliveInterval = optionalInteger(value.serverAliveInterval, 'serverAliveInterval', 0, 86_400);
	draft.serverAliveCountMax = optionalInteger(value.serverAliveCountMax, 'serverAliveCountMax', 0, 100);
	const strict = optionalText(value.strictHostKeyChecking, 'strictHostKeyChecking', 16);
	if (strict !== undefined && !STRICT_MODES.includes(strict)) {
		validationError(`strictHostKeyChecking must be one of ${STRICT_MODES.join(', ')}`, 'strictHostKeyChecking');
	}
	draft.strictHostKeyChecking = strict;
	draft.userKnownHostsFile = optionalText(value.userKnownHostsFile, 'userKnownHostsFile', 1024);
	draft.connectionAttempts = optionalInteger(value.connectionAttempts, 'connectionAttempts', 1, 100);
	draft.connectTimeout = optionalInteger(value.connectTimeout, 'connectTimeout', 1, 600);
	draft.extraOptions = validateExtraOptions(value.extraOptions);
	draft.remoteWorkspace = validateRemotePath(value.remoteWorkspace, 'remoteWorkspace');
	draft.remoteHelperRoot = validateRemotePath(value.remoteHelperRoot, 'remoteHelperRoot');
	return draft;
}

/** Validate the free-form extra ssh_config directives. */
function validateExtraOptions(value) {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) validationError('extraOptions must be an array', 'extraOptions');
	if (value.length > 64) validationError('extraOptions accepts at most 64 entries', 'extraOptions');
	const seen = new Set();
	return value.map((entry, index) => {
		if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
			validationError(`extraOptions[${index}] must be an object`, 'extraOptions');
		}
		const key = requiredText(entry.key, `extraOptions[${index}].key`, 64);
		if (!DIRECTIVE.test(key)) validationError(`extraOptions[${index}].key must be a directive name`, 'extraOptions');
		const lower = key.toLowerCase();
		if (lower === 'host' || lower === 'match' || lower === 'include') {
			validationError(`extraOptions must not override ${key}`, 'extraOptions');
		}
		if (seen.has(lower)) validationError(`extraOptions repeats ${key}`, 'extraOptions');
		seen.add(lower);
		const valueText = requiredText(entry.value, `extraOptions[${index}].value`, 1024);
		return { key, value: valueText };
	});
}

/** Validate a remote absolute path or a `~`-prefixed path. */
function validateRemotePath(value, field) {
	const text = optionalText(value, field, 1024);
	if (text === undefined) return undefined;
	if (!text.startsWith('~') && !isAbsolute(text)) {
		validationError(`${field} must be absolute or start with ~`, field);
	}
	return text;
}

/** Expand a remote `~` path against a known remote home directory. */
export function expandRemotePath(value, remoteHome) {
	if (value === undefined) return undefined;
	if (value === '~') return remoteHome;
	if (value.startsWith('~/')) return join(remoteHome, value.slice(2));
	return value;
}

/** Resolve the local identity file path for display and existence checks. */
export function expandLocalPath(value) {
	if (value === undefined) return undefined;
	if (value === '~') return homedir();
	if (value.startsWith('~/')) return join(homedir(), value.slice(2));
	return value;
}

/** Validate one RPC endpoint payload is a plain object. */
export function requireRecord(value, field) {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		validationError(`${field} must be an object`, field);
	}
	return value;
}
