/**
 * Typed errors shared by the Host controller and its RPC layer.
 *
 * Every failure that crosses the browser boundary carries a stable machine code
 * plus a user-facing message. The RPC layer maps these directly; unexpected
 * errors become `internal` without leaking stack traces.
 * @module @junjiangao/dsh-plugin-remote-ssh/errors
 */

/** Stable error codes understood by the browser panel. */
export const ERROR_CODES = Object.freeze({
	validation: 'validation',
	notFound: 'not-found',
	conflict: 'conflict',
	sshFailed: 'ssh-failed',
	remoteUnsupported: 'remote-unsupported',
	helperMissing: 'helper-missing',
	helperInstallFailed: 'helper-install-failed',
	profileInstallFailed: 'profile-install-failed',
	instanceFailed: 'instance-failed',
	cancelled: 'cancelled',
	internal: 'internal',
});

/** One expected, user-visible plugin failure. */
export class RemoteSshError extends Error {
	/**
	 * @param code - stable error code from {@link ERROR_CODES}.
	 * @param message - user-facing message; must never contain credentials or tokens.
	 * @param options - optional field/ hint metadata.
	 */
	constructor(code, message, options = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = 'RemoteSshError';
		this.code = code;
		this.details = options.details ?? {};
		this.hint = options.hint;
	}

	/** Project this error into the RPC error envelope. */
	toRpcError() {
		return {
			code: this.code,
			message: this.hint === undefined ? this.message : `${this.message} ${this.hint}`,
			details: this.details,
		};
	}
}

/** Wrap an arbitrary thrown value into a user-visible internal error. */
export function toRemoteSshError(error, fallbackMessage = 'remote SSH operation failed') {
	if (error instanceof RemoteSshError) return error;
	const message = error instanceof Error && error.message !== '' ? error.message : fallbackMessage;
	return new RemoteSshError(ERROR_CODES.internal, message, { cause: error });
}

/** Throw a validation failure for one field. */
export function validationError(message, field, hint) {
	throw new RemoteSshError(ERROR_CODES.validation, message, {
		details: field === undefined ? {} : { field },
		hint,
	});
}

/** True when a value is a plain object (not an array, not null). */
export function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
