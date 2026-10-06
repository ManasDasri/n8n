import type { INode } from 'n8n-workflow';
import type { RequirementSource, RequirementUsage } from '../requirement-source';

export type NodeTypeSource = RequirementSource & {
	nodes: Array<Pick<INode, 'type' | 'typeVersion'>>;
};

/** A unique node type/version pair and its package consumers. */
export interface NodeTypeUsage extends RequirementUsage {
	type: string;
	typeVersion: number;
}

/**
 * Include disabled nodes because they remain part of the authored definition.
 * Collect usage without node registry lookups.
 */
export function collectNodeTypeUsage(sources: NodeTypeSource[]): NodeTypeUsage[] {
	const usage = new Map<
		string,
		{
			type: string;
			typeVersion: number;
			workflowIds: Set<string>;
			agentIds: Set<string>;
		}
	>();

	for (const source of sources) {
		for (const node of source.nodes) {
			const key = `${node.type}@${node.typeVersion}`;
			const entry = usage.get(key) ?? {
				type: node.type,
				typeVersion: node.typeVersion,
				workflowIds: new Set<string>(),
				agentIds: new Set<string>(),
			};
			if ('workflowId' in source) entry.workflowIds.add(source.workflowId);
			else entry.agentIds.add(source.agentId);
			usage.set(key, entry);
		}
	}

	return [...usage.values()].map(({ type, typeVersion, workflowIds, agentIds }) => ({
		type,
		typeVersion,
		usedByWorkflows: [...workflowIds],
		...(agentIds.size > 0 ? { usedByAgents: [...agentIds] } : {}),
	}));
}
