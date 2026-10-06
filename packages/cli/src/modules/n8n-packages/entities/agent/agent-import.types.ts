import type {
	SerializedAgent,
	SerializedAgentMetadata,
	SerializedAgentSkill,
	SerializedAgentTask,
	SerializedAgentTool,
} from '../../spec/serialized/agent.schema';

export interface PreparedAgent extends Omit<SerializedAgent, 'id' | 'skills' | 'tools' | 'tasks'> {
	sourceAgentId: string;
	metadata: SerializedAgentMetadata;
	skills: SerializedAgentSkill[];
	tools: SerializedAgentTool[];
	tasks: SerializedAgentTask[];
}
