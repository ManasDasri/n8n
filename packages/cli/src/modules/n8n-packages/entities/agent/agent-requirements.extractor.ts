import type { AgentJsonConfig, AgentJsonNodeToolConfig } from '@n8n/api-types';
import { Service } from '@n8n/di';

import { extractAgentCredentialIds } from '@/modules/agents/utils/extract-agent-credential-ids';
import { extractAgentWorkflowRefs } from '@/modules/agents/utils/extract-agent-workflow-refs';

import type { AgentExportRequirements, PreparedAgentExport } from './agent-export.types';
import type { CredentialReference } from '../credential/credential.types';
import { DataTableRequirementsExtractor } from '../data-table/data-table-requirements.extractor';
import { PackageExportBlockedError } from '../package-export.errors';
import { VariableRequirementsExtractor } from '../variable/variable-requirements.extractor';
import { getStaticSubworkflowId } from '../workflow/references/sub-workflow-node.reference';
import type { AgentWorkflowRequirement } from '../workflow/workflow.types';

@Service()
export class AgentRequirementsExtractor {
	constructor(
		private readonly dataTables: DataTableRequirementsExtractor,
		private readonly variables: VariableRequirementsExtractor,
	) {}

	extract(
		{ content, projectId }: PreparedAgentExport,
		origin: AgentWorkflowRequirement['origin'] = 'top-level',
	): AgentExportRequirements {
		const config = content.config;
		const source = { agentId: content.id, projectId };
		const nodeTools = (config?.tools ?? []).filter((tool) => tool.type === 'node');
		const nodes = nodeTools.map(({ node }) => ({
			type: node.nodeType,
			typeVersion: node.nodeTypeVersion,
			parameters: node.nodeParameters,
		}));
		const workflowIds = new Set(
			extractAgentWorkflowRefs(config).map((tool) => {
				if (!tool.workflowId) {
					throw new PackageExportBlockedError(
						`Agent "${content.id}" workflow tool "${tool.workflow}" has no workflow ID. Export aborted.`,
					);
				}
				return tool.workflowId;
			}),
		);
		for (const node of nodes) {
			const id = getStaticSubworkflowId(node);
			if (id) workflowIds.add(id);
		}
		return {
			credentials: this.credentials(config, nodeTools).map((reference) => ({
				...source,
				...reference,
			})),
			dataTables: this.dataTables
				.extractIds(nodes)
				.map((dataTableId) => ({ ...source, dataTableId })),
			variables: this.variables
				.extractNames({ nodes })
				.map((variableName) => ({ ...source, variableName })),
			tags: [],
			nodeTypes: nodes.length > 0 ? [{ ...source, nodes }] : [],
			workflows: [...workflowIds].map((referencedWorkflowId) => ({
				...source,
				referencedWorkflowId,
				origin,
			})),
			agentIds: [...new Set((config?.subAgents?.agents ?? []).map(({ agentId }) => agentId))],
		};
	}

	private credentials(
		config: AgentJsonConfig | null,
		nodeTools: AgentJsonNodeToolConfig[],
	): CredentialReference[] {
		const credentials = new Map<string, CredentialReference>(
			[...extractAgentCredentialIds(config)].map((id) => [id, { credentialId: id }]),
		);
		const nodeCredentials = nodeTools.flatMap(({ node }) => Object.entries(node.credentials ?? {}));
		for (const [type, details] of nodeCredentials) {
			const credential = details.id === null ? undefined : credentials.get(details.id);
			if (!credential) continue;
			if (details.name) credential.credentialName ??= details.name;
			if (type) credential.credentialType ??= type;
		}
		return [...credentials.values()];
	}
}
