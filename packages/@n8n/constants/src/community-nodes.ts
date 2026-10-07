export const NPM_COMMUNITY_NODE_SEARCH_API_URL = 'https://api.npms.io/v2/';

/**
 * Node-authoring API level this runtime supports. The major mirrors the n8n
 * major for the v3 transition (`1` on master, `3` on `3.x`); bump the minor
 * in the release that adds a node-authoring API inside a major. Lives here
 * so tooling such as `@n8n/node-cli` can read it without the runtime packages.
 */
export const N8N_NODES_API_VERSION = '1.0';

export type NodesApiLevel = [major: number, minor: number];

const LEVEL_PATTERN = /^(\d+)(?:\.(\d+))?$/;

// An integer is the legacy form and means `<major>.0`. A minor level must be
// a string: an unquoted `3.10` in package.json is read as the number `3.1`.
export function parseNodesApiLevel(value: unknown): NodesApiLevel | null {
	if (typeof value === 'number') {
		return Number.isSafeInteger(value) && value >= 1 ? [value, 0] : null;
	}

	if (typeof value !== 'string') return null;

	const match = LEVEL_PATTERN.exec(value.trim());
	if (match === null) return null;

	const major = Number(match[1]);
	const minor = match[2] === undefined ? 0 : Number(match[2]);
	if (major < 1 || !Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) return null;

	return [major, minor];
}

export function formatNodesApiLevel([major, minor]: NodesApiLevel): string {
	return `${major}.${minor}`;
}

export function compareNodesApiLevels(a: NodesApiLevel, b: NodesApiLevel): number {
	return a[0] - b[0] || a[1] - b[1];
}
