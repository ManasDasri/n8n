import type { PackageWriter } from '../../io/package-writer';
import type { ManifestEntry, PackageManifest } from '../../spec/manifest.schema';
import type {
	SerializedAgent,
	SerializedAgentSkill,
	SerializedAgentTool,
} from '../../spec/serialized/agent.schema';

export interface AgentPackageFixture {
	manifest: PackageManifest & { agents: ManifestEntry[] };
	files: Record<string, unknown>;
}

function agentFiles(entry: ManifestEntry, availableInMCP: boolean): Record<string, unknown> {
	const skill: SerializedAgentSkill = {
		id: 'shared-skill',
		name: `${entry.name} reference`,
		description: 'Use the support reference.',
		instructions: 'Read references/guide.md.',
		allowedTools: ['lookup'],
		references: [
			{ path: 'references/guide.md', content: `# ${entry.name}\nKeep this reference text.\n` },
		],
	};
	const tool: SerializedAgentTool = {
		id: 'shared_tool',
		code: 'throw new Error("Package parsing must not run tool code");',
		descriptor: {
			name: 'lookup',
			description: `Look up a ${entry.name} reference.`,
			systemInstruction: 'Use the reference result.',
			inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
			outputSchema: { type: 'object', properties: { text: { type: 'string' } } },
			hasSuspend: true,
			hasResume: true,
			hasToMessage: true,
			requireApproval: true,
			outputTrust: 'untrusted',
			providerOptions: { provider: { cache: false } },
		},
	};
	const task = {
		id: `${entry.id}_task`,
		name: 'Daily summary',
		objective: 'Summarize the open requests.',
		cronExpression: '0 9 * * *',
	};
	const agent: SerializedAgent = {
		id: entry.id,
		name: entry.name,
		config: {
			name: entry.name,
			model: '',
			instructions: '',
			skills: [{ type: 'skill', id: skill.id, enabled: false }],
			tools: [{ type: 'custom', id: tool.id, enabled: false, requireApproval: true }],
			tasks: [{ type: 'task', id: task.id, enabled: false }],
			mcpServers: [
				{ name: 'Reference', url: '', transport: 'streamableHttp', authentication: 'none' },
			],
		},
		availableInMCP,
		skills: [{ id: skill.id, name: skill.name, target: `${entry.target}/skills/reference` }],
		tools: [{ id: tool.id, name: tool.descriptor.name, target: `${entry.target}/tools/lookup` }],
		tasks: [{ id: task.id, name: task.name, target: `${entry.target}/tasks/daily` }],
	};
	return {
		[`${entry.target}/agent.json`]: agent,
		[`${entry.target}/agent-metadata.json`]: {
			versionId: 'draft-version',
			publishedVersionId: 'published-version',
		},
		[`${entry.target}/skills/reference/skill.json`]: skill,
		[`${entry.target}/tools/lookup/tool.json`]: tool,
		[`${entry.target}/tasks/daily/task.json`]: task,
	};
}

export function looseAgentsFixture(): AgentPackageFixture {
	const agents = [
		{ id: 'support_source', name: 'Support', target: 'agents/support' },
		{ id: 'research_source', name: 'Research', target: 'agents/research' },
	];
	return {
		manifest: {
			packageFormatVersion: '1',
			exportedAt: '2026-10-01T12:00:00.000Z',
			sourceN8nVersion: '2.0.0',
			sourceId: 'source-instance',
			agents,
			requirements: {
				credentials: [
					{ id: 'model-credential', usedByWorkflows: [], usedByAgents: ['support_source'] },
				],
				agents: [{ id: 'external-agent', usedByWorkflows: [], usedByAgents: ['support_source'] }],
			},
		},
		files: { ...agentFiles(agents[0], true), ...agentFiles(agents[1], false) },
	};
}

export function projectAgentsFixture(): AgentPackageFixture {
	const fixture = looseAgentsFixture();
	const projectTarget = 'projects/operations';
	const agents = fixture.manifest.agents.map((entry) => ({
		...entry,
		target: `${projectTarget}/${entry.target}`,
	}));
	return {
		manifest: {
			...fixture.manifest,
			agents,
			projects: [{ id: 'project_source', name: 'Operations', target: projectTarget }],
			workflows: [
				{ id: 'workflow_source', name: 'Lookup', target: `${projectTarget}/workflows/lookup` },
			],
		},
		files: {
			...agentFiles(agents[0], true),
			...agentFiles(agents[1], false),
			[`${projectTarget}/project.json`]: { id: 'project_source', name: 'Operations' },
			[`${projectTarget}/workflows/lookup/workflow.json`]: {
				id: 'workflow_source',
				name: 'Lookup',
				nodes: [],
				connections: {},
				parentFolderId: null,
				isArchived: false,
			},
			[`${projectTarget}/workflows/lookup/workflow-metadata.json`]: {
				versionId: 'workflow-version',
				publishedVersionId: null,
			},
		},
	};
}

export async function writeAgentPackageFixture(
	writer: PackageWriter,
	fixture: AgentPackageFixture,
): Promise<void> {
	await writer.writeFile('manifest.json', JSON.stringify(fixture.manifest));
	for (const [path, content] of Object.entries(fixture.files)) {
		await writer.writeFile(path, typeof content === 'string' ? content : JSON.stringify(content));
	}
}
