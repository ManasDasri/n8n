import type { InboxCounts, InboxItem, InboxSourceType, InboxState } from '@n8n/api-types';
import type { User } from '@n8n/db';
import { Service } from '@n8n/di';
import { UnexpectedError } from '@n8n/errors';

export type InboxSourceBoundary =
	| { mode: 'before' | 'through'; createdAt: Date }
	| { mode: 'after'; createdAt: Date; id: string };

export type InboxSourceQuery = {
	state: InboxState;
	limit: number;
	boundary?: InboxSourceBoundary;
};

export interface InboxSource {
	type: InboxSourceType;
	isAvailable(): Promise<boolean>;
	list(user: User, query: InboxSourceQuery): Promise<InboxItem[]>;
	count(user: User): Promise<InboxCounts>;
}

@Service()
export class InboxSourceRegistry {
	private readonly sources = new Map<InboxSourceType, InboxSource>();

	register(source: InboxSource) {
		if (this.sources.has(source.type)) {
			throw new UnexpectedError('Inbox source is already registered', {
				extra: { type: source.type },
			});
		}
		this.sources.set(source.type, source);
	}

	find(type: InboxSourceType) {
		return this.sources.get(type);
	}

	types() {
		return [...this.sources.keys()];
	}
}
