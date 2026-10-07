import { Service } from '@n8n/di';
import { DataSource, type SelectQueryBuilder } from '@n8n/typeorm';

import { BaseRepository } from './base-repository';
import { SharedWorkflow } from '../entities/shared-workflow';
import { WorkflowReviewRequestAuthor } from '../entities/workflow-review-request-author.ee';
import { WorkflowReviewRequestReviewer } from '../entities/workflow-review-request-reviewer.ee';
import { WorkflowReviewRequestWorkflow } from '../entities/workflow-review-request-workflow.ee';
import {
	WorkflowReviewRequest,
	type WorkflowReviewRequestState,
} from '../entities/workflow-review-request.ee';
import { TransactionRunner } from '../services/transaction';

export type WorkflowReviewInboxBoundary =
	| { mode: 'before' | 'through'; createdAt: Date }
	| { mode: 'after'; createdAt: Date; id: string };

export type InboxVisibility =
	| { scope: 'all' }
	| {
			scope: 'involved';
			userId: string;
			adminProjectIds: string[];
			/** Null means the user can read workflows in every project. */
			readableProjectIds: string[] | null;
			readableWorkflowRoles: string[];
	  };

type FindInboxRequestsOptions = {
	visibility: InboxVisibility;
	state?: WorkflowReviewRequestState;
	limit: number;
	boundary?: WorkflowReviewInboxBoundary;
};

export type InboxStateCounts = {
	open: number;
	closed: number;
};

function participantExistsSubquery(
	queryBuilder: SelectQueryBuilder<WorkflowReviewRequest>,
	junctionEntity: typeof WorkflowReviewRequestAuthor | typeof WorkflowReviewRequestReviewer,
	alias: string,
	userParameter: string,
): string {
	return queryBuilder
		.subQuery()
		.select('1')
		.from(junctionEntity, alias)
		.where(`${alias}.workflowReviewRequestId = review.id`)
		.andWhere(`${alias}.userId = :${userParameter}`)
		.getQuery();
}

function linkedWorkflowExistsSubquery(
	queryBuilder: SelectQueryBuilder<WorkflowReviewRequest>,
	alias: string,
): string {
	return queryBuilder
		.subQuery()
		.select('1')
		.from(WorkflowReviewRequestWorkflow, alias)
		.where(`${alias}.workflowReviewRequestId = review.id`)
		.getQuery();
}

function readableLinkedWorkflowExistsSubquery(
	queryBuilder: SelectQueryBuilder<WorkflowReviewRequest>,
): string {
	return queryBuilder
		.subQuery()
		.select('1')
		.from(SharedWorkflow, 'visibilityShared')
		.innerJoin(
			WorkflowReviewRequestWorkflow,
			'visibilityLink',
			'visibilityLink.workflowId = visibilityShared.workflowId',
		)
		.where('visibilityLink.workflowReviewRequestId = review.id')
		.andWhere('visibilityShared.role IN (:...readableWorkflowRoles)')
		.andWhere('visibilityShared.projectId IN (:...readableProjectIds)')
		.getQuery();
}

function applyInboxVisibility(
	queryBuilder: SelectQueryBuilder<WorkflowReviewRequest>,
	visibility: InboxVisibility,
): void {
	if (visibility.scope === 'all') return;

	const { userId, adminProjectIds, readableProjectIds, readableWorkflowRoles } = visibility;
	const parameters: Record<string, unknown> = { involvedUserId: userId };
	const clauses: string[] = [];

	if (adminProjectIds.length > 0) {
		clauses.push('review.projectId IN (:...adminProjectIds)');
		parameters.adminProjectIds = adminProjectIds;
	}

	const authorExists = participantExistsSubquery(
		queryBuilder,
		WorkflowReviewRequestAuthor,
		'visibilityAuthor',
		'involvedUserId',
	);
	const reviewerExists = participantExistsSubquery(
		queryBuilder,
		WorkflowReviewRequestReviewer,
		'visibilityReviewer',
		'involvedUserId',
	);
	clauses.push(`(EXISTS ${authorExists} OR EXISTS ${reviewerExists})`);

	if (readableProjectIds === null) {
		queryBuilder.andWhere(`(${clauses.join(' OR ')})`, parameters);
		return;
	}

	if (readableProjectIds.length === 0 || readableWorkflowRoles.length === 0) {
		queryBuilder.andWhere('1 = 0');
		return;
	}

	parameters.readableProjectIds = readableProjectIds;
	parameters.readableWorkflowRoles = readableWorkflowRoles;

	// Use current workflow access because the request's stored project can become stale.
	const anyLinkExists = linkedWorkflowExistsSubquery(queryBuilder, 'visibilityAnyLink');
	const readableLinkExists = readableLinkedWorkflowExistsSubquery(queryBuilder);
	queryBuilder.andWhere(
		`(${clauses.join(' OR ')}) AND (NOT EXISTS ${anyLinkExists} OR EXISTS ${readableLinkExists})`,
		parameters,
	);
}

@Service()
export class WorkflowReviewInboxRepository extends BaseRepository<WorkflowReviewRequest> {
	constructor(dataSource: DataSource, transactionRunner: TransactionRunner) {
		super(WorkflowReviewRequest, dataSource.manager, transactionRunner);
	}

	async findRequests(options: FindInboxRequestsOptions): Promise<WorkflowReviewRequest[]> {
		const { visibility, state, limit, boundary } = options;
		const queryBuilder = this.createQueryBuilder('review')
			.orderBy('review.createdAt', 'DESC')
			.addOrderBy('review.id', 'ASC');

		applyInboxVisibility(queryBuilder, visibility);
		if (state !== undefined) {
			queryBuilder.andWhere('review.state = :state', { state });
		}
		if (boundary?.mode === 'after') {
			queryBuilder.andWhere(
				'(review.createdAt < :createdAt OR (review.createdAt = :createdAt AND review.id > :id))',
				{ createdAt: boundary.createdAt, id: boundary.id },
			);
		} else if (boundary) {
			queryBuilder.andWhere(
				`review.createdAt ${boundary.mode === 'through' ? '<=' : '<'} :createdAt`,
				{ createdAt: boundary.createdAt },
			);
		}

		queryBuilder.take(limit);
		return await queryBuilder.getMany();
	}

	async countRequestsByState(visibility: InboxVisibility): Promise<InboxStateCounts> {
		const queryBuilder = this.createQueryBuilder('review')
			.select('review.state', 'state')
			.addSelect('COUNT(*)', 'count')
			.groupBy('review.state');

		applyInboxVisibility(queryBuilder, visibility);
		const rows = await queryBuilder.getRawMany<{
			state: WorkflowReviewRequestState;
			count: string | number;
		}>();

		return {
			open: Number(rows.find((row) => row.state === 'open')?.count ?? 0),
			closed: Number(rows.find((row) => row.state === 'closed')?.count ?? 0),
		};
	}
}
