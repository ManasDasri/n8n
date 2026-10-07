import { ResponseError } from '@n8n/errors';

/**
 * A community package requires a node-authoring API version this runtime does
 * not support, or declares a malformed one.
 */
export class IncompatibleNodesApiVersionError extends ResponseError {
	constructor(
		message: string,
		readonly meta: {
			/** `null` if the declared value is malformed. */
			requiredNodesApiVersion: string | null;
			supportedNodesApiVersion: string;
		},
		cause?: unknown,
	) {
		super(message, 400, undefined, undefined, cause);
		this.name = 'IncompatibleNodesApiVersionError';
	}
}
