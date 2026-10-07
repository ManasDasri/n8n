import { z } from 'zod';

import { inboxStateSchema } from '../../inbox';
import { Z } from '../../zod-class';

export class ListInboxQueryDto extends Z.class({
	state: inboxStateSchema.default('open'),
	limit: z.coerce.number().int().min(1).max(100).default(15),
	cursor: z.string().min(1).max(2048).optional(),
}) {}
