import {
	N8N_NODES_API_VERSION,
	checkNodesApiVersion,
	formatNodesApiLevel,
	parseNodesApiLevel,
} from '../src/nodes-api-version';

const pkg = (n8nNodesApiVersion?: unknown) => ({
	n8n: n8nNodesApiVersion === undefined ? {} : { n8nNodesApiVersion },
});

const [supportedMajor, supportedMinor] = parseNodesApiLevel(N8N_NODES_API_VERSION)!;

describe('parseNodesApiLevel', () => {
	it.each([
		['3.1', [3, 1]],
		['3.0', [3, 0]],
		['3', [3, 0]],
		['3.10', [3, 10]],
		[' 3.2 ', [3, 2]],
		['03.1', [3, 1]],
	])('parses the string %p as %p', (value, expected) => {
		expect(parseNodesApiLevel(value)).toEqual(expected);
	});

	it.each([
		[1, [1, 0]],
		[3, [3, 0]],
	])('reads the legacy integer %p as %p', (value, expected) => {
		expect(parseNodesApiLevel(value)).toEqual(expected);
	});

	it.each([0, -1, 2.5, 3.1, '0', '3.', '.1', '3.1.2', 'v3', '', null, NaN, Infinity, true, {}])(
		'rejects %p',
		(value) => {
			expect(parseNodesApiLevel(value)).toBeNull();
		},
	);

	it.each([2 ** 53, '9007199254740992', '1.9007199254740992'])(
		'rejects the level %p above the safe integer range',
		(value) => {
			expect(parseNodesApiLevel(value)).toBeNull();
		},
	);
});

describe('formatNodesApiLevel', () => {
	it('writes major and minor', () => {
		expect(formatNodesApiLevel([3, 0])).toBe('3.0');
		expect(formatNodesApiLevel([3, 10])).toBe('3.10');
	});
});

describe('N8N_NODES_API_VERSION', () => {
	it('is a level written as major.minor', () => {
		expect(N8N_NODES_API_VERSION).toBe(formatNodesApiLevel([supportedMajor, supportedMinor]));
	});
});

describe('checkNodesApiVersion', () => {
	it('treats a missing n8n section as legacy level 1', () => {
		expect(checkNodesApiVersion({})).toEqual({ compatible: true });
	});

	it('treats a missing n8nNodesApiVersion as legacy level 1', () => {
		expect(checkNodesApiVersion(pkg())).toEqual({ compatible: true });
	});

	it('accepts the legacy integer 1', () => {
		expect(checkNodesApiVersion(pkg(1))).toEqual({ compatible: true });
	});

	it('accepts the supported level', () => {
		expect(checkNodesApiVersion(pkg(N8N_NODES_API_VERSION))).toEqual({ compatible: true });
	});

	it('accepts the supported major as a legacy integer', () => {
		expect(checkNodesApiVersion(pkg(supportedMajor))).toEqual({ compatible: true });
	});

	it('accepts a minor below the supported one', () => {
		if (supportedMinor === 0) return;
		expect(checkNodesApiVersion(pkg(`${supportedMajor}.${supportedMinor - 1}`))).toEqual({
			compatible: true,
		});
	});

	it('rejects one minor above the supported level', () => {
		const above = `${supportedMajor}.${supportedMinor + 1}`;
		expect(checkNodesApiVersion(pkg(above))).toEqual({
			compatible: false,
			reason: 'unsupported',
			declared: above,
			required: above,
		});
	});

	it('rejects the next major at minor 0', () => {
		const above = `${supportedMajor + 1}.0`;
		expect(checkNodesApiVersion(pkg(above))).toEqual({
			compatible: false,
			reason: 'unsupported',
			declared: above,
			required: above,
		});
	});

	it('reports the required level as major.minor whatever the author wrote', () => {
		expect(checkNodesApiVersion(pkg(` 0${supportedMajor + 1} `))).toMatchObject({
			required: `${supportedMajor + 1}.0`,
		});
		expect(checkNodesApiVersion(pkg(supportedMajor + 1))).toMatchObject({
			required: `${supportedMajor + 1}.0`,
		});
	});

	it.each(['3.1.0', 'three', 0, -1, 2.5, 3.1, null, NaN, Infinity, true, {}, '9007199254740992'])(
		'rejects the malformed value %p',
		(declared) => {
			expect(checkNodesApiVersion(pkg(declared))).toEqual({
				compatible: false,
				reason: 'malformed',
				declared,
			});
		},
	);
});
