import type { ToolDescriptor } from '@n8n/agents';
import {
	AgentJsonConfigSchema,
	agentSkillSchema,
	agentTaskSchema,
	AGENT_TASK_ID_MAX_LENGTH,
	CUSTOM_TOOL_ID_REGEX,
} from '@n8n/api-types';
import { isRecord } from '@n8n/utils/is-record';
import { z } from 'zod';

import { manifestEntrySchema } from '../manifest.schema';

const assetIndexSchema = z.array(manifestEntrySchema.strict()).superRefine((entries, ctx) => {
	const ids = new Set<string>();
	for (const [index, entry] of entries.entries()) {
		if (ids.has(entry.id)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: [index, 'id'],
				message: `Duplicate Agent asset id: ${entry.id}`,
			});
		}
		ids.add(entry.id);
	}
});

export const serializedAgentSchema = z
	.object({
		id: z.string().min(1),
		name: z.string().min(1).max(128),
		config: AgentJsonConfigSchema.nullable(),
		availableInMCP: z.boolean(),
		skills: assetIndexSchema,
		tools: assetIndexSchema,
		tasks: assetIndexSchema,
	})
	.strict();

export const serializedAgentMetadataSchema = z
	.object({
		versionId: z.string().min(1).nullable(),
		publishedVersionId: z.string().min(1).nullable(),
	})
	.strict();

export const serializedAgentSkillSchema = agentSkillSchema.extend({
	id: z
		.string()
		.min(1)
		.regex(/^[A-Za-z0-9_-]+$/),
});

const toolDescriptorSchema = z
	.object({
		name: z.string(),
		description: z.string(),
		systemInstruction: z.string().nullable(),
		inputSchema: z.custom<NonNullable<ToolDescriptor['inputSchema']>>(isRecord).nullable(),
		outputSchema: z.custom<NonNullable<ToolDescriptor['outputSchema']>>(isRecord).nullable(),
		hasSuspend: z.boolean(),
		hasResume: z.boolean(),
		hasToMessage: z.boolean(),
		requireApproval: z.boolean(),
		outputTrust: z.literal('untrusted').nullish(),
		providerOptions: z.record(z.unknown()).nullable(),
	})
	.strict() satisfies z.ZodType<ToolDescriptor>;

export const serializedAgentToolSchema = z
	.object({
		id: z.string().min(1).regex(CUSTOM_TOOL_ID_REGEX),
		code: z.string(),
		descriptor: toolDescriptorSchema,
	})
	.strict();

export const serializedAgentTaskSchema = agentTaskSchema
	.extend({
		id: z
			.string()
			.min(1)
			.max(AGENT_TASK_ID_MAX_LENGTH)
			.regex(/^[A-Za-z0-9_-]+$/),
		timezone: agentTaskSchema.shape.timezone.default(null),
	})
	.strict();

export type SerializedAgent = z.infer<typeof serializedAgentSchema>;
export type SerializedAgentMetadata = z.infer<typeof serializedAgentMetadataSchema>;
export type SerializedAgentSkill = z.infer<typeof serializedAgentSkillSchema>;
export type SerializedAgentTool = z.infer<typeof serializedAgentToolSchema>;
export type SerializedAgentTask = z.infer<typeof serializedAgentTaskSchema>;
