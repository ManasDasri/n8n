import type { Logger } from '@n8n/backend-common';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mock } from 'vitest-mock-extended';

import type { NodeTypes } from '@/node-types';

import {
	looseAgentsFixture,
	projectAgentsFixture,
	writeAgentPackageFixture,
	type AgentPackageFixture,
} from '../../__tests__/fixtures/agent-package-fixtures';
import { streamToBuffer } from '../../__tests__/utils/tar-support';
import type { WorkflowSerializer } from '../../entities/workflow/workflow.serializer';
import { DirectoryPackageReader } from '../../io/directory/directory-package-reader';
import { DirectoryPackageWriter } from '../../io/directory/directory-package-writer';
import type { PackageReader } from '../../io/package-reader';
import { TarPackageReader } from '../../io/tar/tar-package-reader';
import { TarPackageWriter } from '../../io/tar/tar-package-writer';
import { PackageImportConfig } from '../../n8n-packages.config';
import type { SerializedAgent, SerializedAgentTool } from '../../spec/serialized/agent.schema';
import { N8nPackageParser } from '../n8n-package-parser';

const parser = new N8nPackageParser(mock<Logger>(), mock<NodeTypes>(), mock<WorkflowSerializer>());
const limits = new PackageImportConfig();
const agentTarget = 'agents/support';
const agentPath = `${agentTarget}/agent.json`;
const bodyPaths = [
	'agent.json',
	'agent-metadata.json',
	'skills/reference/skill.json',
	'tools/lookup/tool.json',
	'tasks/daily/task.json',
];

function memoryReader(fixture: AgentPackageFixture): PackageReader {
	return {
		readManifest: async () => fixture.manifest,
		readFile: async (filePath) => {
			if (!(filePath in fixture.files)) throw new Error(`Missing ${filePath}`);
			const content = fixture.files[filePath];
			return Buffer.from(typeof content === 'string' ? content : JSON.stringify(content));
		},
		listEntries: async () => Object.keys(fixture.files),
	};
}

describe('N8nPackageParser.getAgents', () => {
	let fixture: AgentPackageFixture;
	let agent: SerializedAgent;
	let directory: string;

	beforeEach(() => {
		fixture = looseAgentsFixture();
		agent = fixture.files[agentPath] as SerializedAgent;
	});

	afterEach(async () => {
		if (directory) await rm(directory, { recursive: true, force: true });
	});

	async function readers(input: AgentPackageFixture): Promise<PackageReader[]> {
		directory = await mkdtemp(path.join(tmpdir(), 'n8n-agent-package-'));
		const tarWriter = new TarPackageWriter();
		await writeAgentPackageFixture(tarWriter, input);
		await writeAgentPackageFixture(new DirectoryPackageWriter(directory), input);
		const directoryReader = new DirectoryPackageReader(directory, limits);
		await directoryReader.listEntries();
		return [
			new TarPackageReader(await streamToBuffer(tarWriter.finalize()), limits),
			directoryReader,
		];
	}

	it.each([
		{ name: 'loose Agents', fixture: looseAgentsFixture, prefix: '' },
		{ name: 'whole project', fixture: projectAgentsFixture, prefix: 'projects/operations/' },
	])('parses equivalent complete definitions from $name in both readers', async (testCase) => {
		const input = testCase.fixture();
		const [archiveReader, directoryReader] = await readers(input);
		const archived = await parser.getAgents(archiveReader, testCase.prefix);
		const loose = await parser.getAgents(directoryReader, testCase.prefix);

		expect(archived).toEqual(loose);
		expect(archived.map(({ sourceAgentId }) => sourceAgentId)).toEqual([
			'support_source',
			'research_source',
		]);
		expect(archived.map(({ availableInMCP }) => availableInMCP)).toEqual([true, false]);
		for (const [index, parsed] of archived.entries()) {
			const target = input.manifest.agents[index].target;
			expect(parsed.config).toMatchObject({
				model: '',
				skills: [{ id: 'shared-skill', enabled: false }],
				tools: [{ id: 'shared_tool', enabled: false, requireApproval: true }],
				tasks: [{ id: `${parsed.sourceAgentId}_task`, enabled: false }],
				mcpServers: [{ name: 'Reference', url: '' }],
			});
			expect(parsed.metadata).toEqual({
				versionId: 'draft-version',
				publishedVersionId: 'published-version',
			});
			expect(parsed.skills).toEqual([input.files[`${target}/skills/reference/skill.json`]]);
			expect(parsed.tools).toEqual([input.files[`${target}/tools/lookup/tool.json`]]);
			expect(parsed.tasks).toEqual([
				{
					id: `${parsed.sourceAgentId}_task`,
					name: 'Daily summary',
					objective: 'Summarize the open requests.',
					cronExpression: '0 9 * * *',
					timezone: null,
				},
			]);
		}
	});

	it('scopes Agents by the manifest project layout', async () => {
		const input = projectAgentsFixture();
		input.manifest.agents[1] = fixture.manifest.agents[1];
		Object.assign(input.files, fixture.files);
		const reader = memoryReader(input);

		expect((await parser.getAgents(reader)).map(({ sourceAgentId }) => sourceAgentId)).toEqual([
			'research_source',
		]);
		expect(
			(await parser.getAgents(reader, 'projects/operations/')).map(
				({ sourceAgentId }) => sourceAgentId,
			),
		).toEqual(['support_source']);
	});

	it('accepts null draft configuration and version metadata', async () => {
		agent.config = null;
		fixture.files[`${agentTarget}/agent-metadata.json`] = {
			versionId: null,
			publishedVersionId: null,
		};

		const [parsed] = await parser.getAgents(memoryReader(fixture));
		expect(parsed).toMatchObject({
			config: null,
			availableInMCP: true,
			metadata: { versionId: null, publishedVersionId: null },
		});
	});

	it.each(bodyPaths)('rejects a missing %s body', async (bodyPath) => {
		const filePath = `${agentTarget}/${bodyPath}`;
		delete fixture.files[filePath];
		await expect(parser.getAgents(memoryReader(fixture))).rejects.toThrow(
			`missing Agent file at ${filePath}`,
		);
	});

	it('identifies invalid JSON by file', async () => {
		fixture.files[agentPath] = '{';
		await expect(parser.getAgents(memoryReader(fixture))).rejects.toThrow(
			`${agentPath} is not valid JSON`,
		);
	});

	it.each([
		['agent.json', { availableInMCP: undefined }],
		[
			'agent.json',
			{ config: { name: 'Draft', model: '', credential: 'cred-1', instructions: '' } },
		],
		['agent-metadata.json', { versionId: undefined }],
		['skills/reference/skill.json', { instructions: 42 }],
		['skills/reference/skill.json', { references: [{ path: '../guide.md', content: 'Guide' }] }],
		['tools/lookup/tool.json', { code: 42 }],
		['tools/lookup/tool.json', { descriptor: { name: 'Incomplete' } }],
		['tasks/daily/task.json', { timezone: 'Invalid/Zone' }],
		['tasks/daily/task.json', { objective: '' }],
	])('rejects malformed %s: %j', async (bodyPath, fields) => {
		const filePath = `${agentTarget}/${bodyPath}`;
		fixture.files[filePath] = { ...(fixture.files[filePath] as object), ...fields };
		await expect(parser.getAgents(memoryReader(fixture))).rejects.toThrow(
			`${filePath} failed schema validation`,
		);
	});

	it.each(bodyPaths)('rejects runtime fields in the %s envelope', async (bodyPath) => {
		const filePath = `${agentTarget}/${bodyPath}`;
		fixture.files[filePath] = { ...(fixture.files[filePath] as object), createdAt: '2026-10-01' };
		await expect(parser.getAgents(memoryReader(fixture))).rejects.toThrow(
			`${filePath} failed schema validation`,
		);
	});

	it.each([
		['inputSchema', []],
		['outputSchema', false],
		['systemInstruction', 42],
		['hasSuspend', 'true'],
		['outputTrust', 'trusted'],
		['providerOptions', []],
		['runtimeState', {}],
	])('validates the tool descriptor field %s', async (field, value) => {
		const filePath = `${agentTarget}/tools/lookup/tool.json`;
		const tool = fixture.files[filePath] as SerializedAgentTool;
		fixture.files[filePath] = { ...tool, descriptor: { ...tool.descriptor, [field]: value } };
		await expect(parser.getAgents(memoryReader(fixture))).rejects.toThrow(
			`${filePath} failed schema validation`,
		);
	});

	it.each([
		'agent.json',
		'skills/reference/skill.json',
		'tools/lookup/tool.json',
		'tasks/daily/task.json',
	])('rejects an ID mismatch in %s', async (bodyPath) => {
		const filePath = `${agentTarget}/${bodyPath}`;
		fixture.files[filePath] = { ...(fixture.files[filePath] as object), id: 'different_id' };
		await expect(parser.getAgents(memoryReader(fixture))).rejects.toThrow(
			`${filePath} declares id "different_id"`,
		);
	});

	it.each(['skills', 'tools', 'tasks'] as const)(
		'rejects duplicate %s IDs within an Agent',
		async (collection) => {
			agent[collection].push({
				...agent[collection][0],
				target: `${agentTarget}/${collection}/duplicate`,
			});
			await expect(parser.getAgents(memoryReader(fixture))).rejects.toThrow(
				`${agentPath} failed schema validation`,
			);
		},
	);

	it.each(['skills', 'tools', 'tasks'] as const)(
		'requires an indexed body for disabled %s',
		async (collection) => {
			const missingId = agent[collection][0].id;
			agent[collection] = [];
			await expect(parser.getAgents(memoryReader(fixture))).rejects.toThrow(
				`${collection} asset "${missingId}" without an indexed body`,
			);
		},
	);

	it('validates indexed bodies that have no configuration reference', async () => {
		agent.config = null;
		fixture.files[`${agentTarget}/skills/reference/skill.json`] = { id: 'shared-skill' };
		await expect(parser.getAgents(memoryReader(fixture))).rejects.toThrow(
			'skills/reference/skill.json failed schema validation',
		);
	});

	it.each(['not a cron', '0 9 30 2 *'])(
		'uses the task cron validator for %s',
		async (cronExpression) => {
			const filePath = `${agentTarget}/tasks/daily/task.json`;
			fixture.files[filePath] = { ...(fixture.files[filePath] as object), cronExpression };
			await expect(parser.getAgents(memoryReader(fixture))).rejects.toThrow(
				'Agent "support_source" task "support_source_task" has an invalid cron expression',
			);
		},
	);

	it.each([
		'agents/support/../../agents/research',
		'projects/unlisted/agents/support',
		'agents/support/child',
		'/agents/support',
		'agents//support',
		'agents/./support',
		'agents\\support',
		'agents/support/',
	])('rejects an invalid Agent location: %s', async (target) => {
		fixture.manifest.agents[0].target = target;
		for (const reader of await readers(fixture)) {
			await expect(parser.getAgents(reader)).rejects.toThrow('Agent "support_source"');
		}
	});

	it.each([
		'agents/support/skills/../../research/skills/reference',
		'agents/support/skills/reference/../reference',
		'agents/research/skills/reference',
		'agents/support/tools/lookup',
		'agents/support-other/skills/reference',
		'agents/support/skills/reference/nested',
		'agents/support/skills\\reference',
		'/agents/support/skills/reference',
		'agents/support/skills//reference',
	])('rejects an invalid asset location: %s', async (target) => {
		agent.skills[0].target = target;
		for (const reader of await readers(fixture)) {
			await expect(parser.getAgents(reader)).rejects.toThrow(
				'Agent "support_source" skills asset "shared-skill"',
			);
		}
	});
});
