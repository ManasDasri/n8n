import {
	createTeamProject,
	createWorkflow,
	linkUserToProject,
	mockInstance,
	shareWorkflowWithUsers,
	testDb,
} from '@n8n/backend-test-utils';
import type { Project, User } from '@n8n/db';
import {
	UserRepository,
	WorkflowRepository,
	WorkflowReviewRequestAuthorRepository,
	WorkflowReviewRequestRepository,
	WorkflowReviewRequestReviewerRepository,
	WorkflowReviewRequestWorkflowRepository,
} from '@n8n/db';
import { Container } from '@n8n/di';

import { ActiveWorkflowManager } from '@/active-workflow-manager';
import { WorkflowReviewPolicyService } from '@/services/workflow-review-policy.service';
import { WorkflowValidationService } from '@/workflows/workflow-validation.service';
import { createMember, createUser } from '@test-integration/db/users';
import type { SuperAgentTest } from '@test-integration/types';
import * as utils from '@test-integration/utils';

import {
	REVIEW_TABLES,
	seedReview,
	seedReviewActors,
	stubWorkflowValidation,
} from './support/workflow-review-test-data';

mockInstance(ActiveWorkflowManager);
const workflowValidationService = mockInstance(WorkflowValidationService);

const testServer = utils.setupTestServer({
	endpointGroups: ['workflow-reviews', 'workflows'],
	enabledFeatures: ['feat:workflowReviews'],
	modules: ['workflow-reviews', 'inbox'],
});

let owner: User;
let member: User;
let viewer: User;
let ownerProject: Project;
let teamProject: Project;
let ownerAgent: SuperAgentTest;
let memberAgent: SuperAgentTest;
let viewerAgent: SuperAgentTest;

let requestRepository: WorkflowReviewRequestRepository;
let workflowRepository: WorkflowReviewRequestWorkflowRepository;
let authorRepository: WorkflowReviewRequestAuthorRepository;
let reviewerRepository: WorkflowReviewRequestReviewerRepository;
let userRepository: UserRepository;
let workflowEntityRepository: WorkflowRepository;
let policyService: WorkflowReviewPolicyService;

beforeAll(async () => {
	await utils.initNodeTypes();
	requestRepository = Container.get(WorkflowReviewRequestRepository);
	workflowRepository = Container.get(WorkflowReviewRequestWorkflowRepository);
	authorRepository = Container.get(WorkflowReviewRequestAuthorRepository);
	reviewerRepository = Container.get(WorkflowReviewRequestReviewerRepository);
	userRepository = Container.get(UserRepository);
	workflowEntityRepository = Container.get(WorkflowRepository);
	policyService = Container.get(WorkflowReviewPolicyService);
});

beforeEach(async () => {
	testServer.license.enable('feat:workflowReviews');
	await testDb.truncate([...REVIEW_TABLES]);
	await policyService.set(true);
	stubWorkflowValidation(workflowValidationService);

	({ owner, member, viewer, ownerProject, teamProject, ownerAgent, memberAgent, viewerAgent } =
		await seedReviewActors(testServer.authAgentFor));
});

/** An open request only surfaces in the inbox while it covers a live workflow. */
async function linkToNewWorkflow(workflowReviewRequestId: string, project = teamProject) {
	const workflow = await createWorkflow({}, project);
	await workflowRepository.createWorkflowRow(
		{ workflowReviewRequestId, workflowId: workflow.id },
		{},
	);
	return workflow;
}

/** Seeds one open and one closed review, both with `member` as the assigned reviewer. */
async function seedInboxRequests() {
	const openRequest = await requestRepository.createRequest(
		{
			projectId: teamProject.id,
			title: 'Open review request',
			createdById: owner.id,
			state: 'open',
		},
		{},
	);
	const openWorkflow = await linkToNewWorkflow(openRequest.id);
	// No link row: a hard-deleted workflow leaves closed requests exactly like this
	const closedRequest = await requestRepository.createRequest(
		{
			projectId: teamProject.id,
			title: 'Closed review request',
			createdById: owner.id,
			state: 'closed',
		},
		{},
	);
	await reviewerRepository.addReviewers(
		{ workflowReviewRequestId: openRequest.id, userIds: [member.id] },
		{},
	);
	await reviewerRepository.addReviewers(
		{ workflowReviewRequestId: closedRequest.id, userIds: [member.id] },
		{},
	);
	return { openRequest, closedRequest, openWorkflow };
}

/** A review orphaned by a hard delete: the cascade drops the link row, the request stays open. */
async function seedOrphanedOpenReview() {
	const orphan = await requestRepository.createRequest(
		{
			projectId: teamProject.id,
			title: 'Orphaned review',
			createdById: owner.id,
			state: 'open',
		},
		{},
	);
	await reviewerRepository.addReviewers(
		{ workflowReviewRequestId: orphan.id, userIds: [member.id] },
		{},
	);
	const workflow = await linkToNewWorkflow(orphan.id);
	// Bypasses the auto-close hook and the sweep: the cascade removes the link
	// row and leaves the request open — visible until the next delete sweeps it
	await workflowEntityRepository.delete({ id: workflow.id });
	return orphan;
}

describe('GET /inbox/summary', () => {
	test('counts open and closed reviews for the instance owner', async () => {
		await seedInboxRequests();

		const response = await ownerAgent.get('/inbox/summary').expect(200);

		expect(response.body.data.counts).toEqual({ open: 1, closed: 1 });
	});

	test('counts the reviews an assigned reviewer was asked to look at', async () => {
		await seedInboxRequests();

		const response = await memberAgent.get('/inbox/summary').expect(200);

		expect(response.body.data.counts).toEqual({ open: 1, closed: 1 });
	});

	test('counts nothing for an uninvolved project member', async () => {
		await seedInboxRequests();

		const response = await viewerAgent.get('/inbox/summary').expect(200);

		expect(response.body.data.counts).toEqual({ open: 0, closed: 0 });
	});

	test('counts a requester their own review even without publish scope', async () => {
		const ownRequest = await seedReview({
			projectId: teamProject.id,
			author: viewer,
			title: 'Review submitted by viewer',
		});
		await linkToNewWorkflow(ownRequest.id);

		const response = await viewerAgent.get('/inbox/summary').expect(200);

		expect(response.body.data.counts).toEqual({ open: 1, closed: 0 });
	});

	test('still counts an open review orphaned by a workflow hard delete until a sweep closes it', async () => {
		await seedInboxRequests();
		await seedOrphanedOpenReview();

		// Owner exercises the whole-inbox scope, member the involvement filter
		const ownerResponse = await ownerAgent.get('/inbox/summary').expect(200);
		expect(ownerResponse.body.data.counts).toEqual({ open: 2, closed: 1 });

		const memberResponse = await memberAgent.get('/inbox/summary').expect(200);
		expect(memberResponse.body.data.counts).toEqual({ open: 2, closed: 1 });
	});

	test('omits review counts once an admin turns reviews off', async () => {
		await policyService.set(false);

		const response = await ownerAgent.get('/inbox/summary').expect(200);
		expect(response.body.data).toMatchObject({
			counts: { open: 0, closed: 0 },
			disabledSources: ['workflow_review'],
		});
	});
});

describe('GET /inbox', () => {
	test('shows the instance owner every open review', async () => {
		const { openRequest, openWorkflow } = await seedInboxRequests();

		const response = await ownerAgent.get('/inbox').query({ state: 'open', limit: 15 }).expect(200);

		expect(response.body.data.data).toHaveLength(1);
		expect(response.body.data.data[0]).toMatchObject({
			id: openRequest.id,
			title: 'Open review request',
			state: 'open',
			workflowName: openWorkflow.name,
			workflowVersionId: null,
		});
		expect(response.body.data.hasMore).toBe(false);
		expect(response.body.data.nextCursor).toBeNull();
	});

	test('shows nothing to an uninvolved project member', async () => {
		await seedInboxRequests();

		const response = await viewerAgent.get('/inbox').expect(200);

		expect(response.body.data.data).toEqual([]);
		expect(response.body.data.hasMore).toBe(false);
	});

	test('still lists an open review orphaned by a workflow hard delete until a sweep closes it', async () => {
		const { openRequest } = await seedInboxRequests();
		const orphan = await seedOrphanedOpenReview();

		// Owner exercises the whole-inbox scope, member the involvement filter
		const ownerResponse = await ownerAgent
			.get('/inbox')
			.query({ state: 'open', limit: 15 })
			.expect(200);
		expect(ownerResponse.body.data.data.map((row: { id: string }) => row.id).sort()).toEqual(
			[openRequest.id, orphan.id].sort(),
		);

		const memberResponse = await memberAgent
			.get('/inbox')
			.query({ state: 'open', limit: 15 })
			.expect(200);
		expect(memberResponse.body.data.data.map((row: { id: string }) => row.id).sort()).toEqual(
			[openRequest.id, orphan.id].sort(),
		);
	});

	test('still lists a closed review whose workflow was hard-deleted', async () => {
		const { closedRequest } = await seedInboxRequests();

		const response = await ownerAgent
			.get('/inbox')
			.query({ state: 'closed', limit: 15 })
			.expect(200);

		// The closed seed request has no link rows — deleted-workflow history stays visible
		expect(response.body.data.data).toEqual([
			expect.objectContaining({ id: closedRequest.id, state: 'closed', workflowName: null }),
		]);
	});

	test('omits review rows once an admin turns reviews off', async () => {
		await policyService.set(false);

		const response = await ownerAgent.get('/inbox').expect(200);
		expect(response.body.data).toMatchObject({ data: [], disabledSources: ['workflow_review'] });
	});

	test('pages through the inbox with a cursor', async () => {
		await seedInboxRequests();
		const secondRequest = await requestRepository.createRequest(
			{
				projectId: teamProject.id,
				title: 'Second open review',
				createdById: owner.id,
				state: 'open',
			},
			{},
		);
		await linkToNewWorkflow(secondRequest.id);

		const firstPage = await ownerAgent.get('/inbox').query({ state: 'open', limit: 1 }).expect(200);

		expect(firstPage.body.data.data).toHaveLength(1);
		expect(firstPage.body.data.hasMore).toBe(true);
		expect(firstPage.body.data.nextCursor).toBeTruthy();

		const secondPage = await ownerAgent
			.get('/inbox')
			.query({
				state: 'open',
				limit: 1,
				cursor: firstPage.body.data.nextCursor,
			})
			.expect(200);

		expect(secondPage.body.data.data).toHaveLength(1);
		expect(secondPage.body.data.data[0].id).not.toBe(firstPage.body.data.data[0].id);
	});

	test('hides reviews from projects the member cannot read, even when assigned as reviewer', async () => {
		const otherProject = await createTeamProject('Other Reviews Project', owner);
		const privateRequest = await requestRepository.createRequest(
			{
				projectId: otherProject.id,
				title: 'Private other-project review',
				createdById: owner.id,
				state: 'open',
			},
			{},
		);
		await linkToNewWorkflow(privateRequest.id, otherProject);
		// Assignment alone must not widen visibility beyond readable projects
		await reviewerRepository.addReviewers(
			{ workflowReviewRequestId: privateRequest.id, userIds: [member.id] },
			{},
		);

		const memberResponse = await memberAgent.get('/inbox').expect(200);
		expect(memberResponse.body.data.data).toEqual([]);

		const ownerResponse = await ownerAgent.get('/inbox').expect(200);
		expect(ownerResponse.body.data.data).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					title: 'Private other-project review',
				}),
			]),
		);
	});

	test("hides a requester's own review in a project they cannot read", async () => {
		const otherProject = await createTeamProject('Unrelated Project', owner);
		const ownRequest = await requestRepository.createRequest(
			{
				projectId: otherProject.id,
				title: 'Review I submitted',
				createdById: member.id,
				state: 'open',
			},
			{},
		);
		await linkToNewWorkflow(ownRequest.id, otherProject);

		const response = await memberAgent.get('/inbox').expect(200);

		expect(response.body.data.data).toEqual([]);
	});

	test('shows a project admin every review in their project without involvement', async () => {
		const projectAdmin = await createMember();
		await linkUserToProject(projectAdmin, teamProject, 'project:admin');
		const { openRequest } = await seedInboxRequests();

		const response = await testServer.authAgentFor(projectAdmin).get('/inbox').expect(200);

		expect(response.body.data.data).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: openRequest.id })]),
		);
	});

	test('does not truncate pagination when the cursor row is deleted', async () => {
		await seedInboxRequests();
		const secondRequest = await requestRepository.createRequest(
			{
				projectId: teamProject.id,
				title: 'Second open review',
				createdById: owner.id,
				state: 'open',
			},
			{},
		);
		await linkToNewWorkflow(secondRequest.id);

		const firstPage = await ownerAgent.get('/inbox').query({ state: 'open', limit: 1 }).expect(200);
		const cursor = firstPage.body.data.nextCursor as string;
		const firstId = firstPage.body.data.data[0].id as string;

		// Delete the anchor row before requesting the next page.
		await requestRepository.delete({ id: firstId });

		const secondPage = await ownerAgent
			.get('/inbox')
			.query({ state: 'open', limit: 1, cursor })
			.expect(200);

		expect(secondPage.body.data.data).toHaveLength(1);
		expect(secondPage.body.data.data[0].id).not.toBe(firstId);
	});

	test('hydrates the requester and requested reviewers on list items', async () => {
		const reviewer = await createUser();
		const request = await seedReview({
			projectId: teamProject.id,
			author: owner,
			reviewerIds: [reviewer.id],
			title: 'Needs review',
		});
		await linkToNewWorkflow(request.id);

		const response = await ownerAgent.get('/inbox').query({ state: 'open', limit: 15 }).expect(200);

		const item = response.body.data.data.find((row: { id: string }) => row.id === request.id);
		expect(item.requester).toEqual({
			id: owner.id,
			email: owner.email,
			firstName: owner.firstName,
			lastName: owner.lastName,
		});
		expect(item.reviewers).toEqual([
			{
				id: reviewer.id,
				email: reviewer.email,
				firstName: reviewer.firstName,
				lastName: reviewer.lastName,
			},
		]);
	});

	test('drops a requester and reviewers whose accounts were deleted, and leaves a creatorless review with no requester', async () => {
		// No FK on these rows, so a deleted user leaves a dangling id that must resolve to null.
		const departedCreator = await createUser();
		const survivingReviewer = await createUser();
		const departedReviewer = await createUser();
		const request = await requestRepository.createRequest(
			{
				projectId: teamProject.id,
				title: 'With departed users',
				createdById: departedCreator.id,
				state: 'open',
			},
			{},
		);
		await linkToNewWorkflow(request.id);
		await reviewerRepository.addReviewers(
			{
				workflowReviewRequestId: request.id,
				userIds: [survivingReviewer.id, departedReviewer.id],
			},
			{},
		);

		// A review whose `createdById` was never set at all.
		const authorless = await requestRepository.createRequest(
			{ projectId: teamProject.id, title: 'Authorless', createdById: null, state: 'open' },
			{},
		);
		await linkToNewWorkflow(authorless.id);

		await userRepository.delete({ id: departedCreator.id });
		await userRepository.delete({ id: departedReviewer.id });

		const response = await ownerAgent.get('/inbox').query({ state: 'open', limit: 15 }).expect(200);

		const rows = response.body.data.data as Array<{
			id: string;
			requester: unknown;
			reviewers: unknown[];
		}>;
		const withDeparted = rows.find((row) => row.id === request.id)!;
		expect(withDeparted.requester).toBeNull();
		expect(withDeparted.reviewers).toEqual([
			{
				id: survivingReviewer.id,
				email: survivingReviewer.email,
				firstName: survivingReviewer.firstName,
				lastName: survivingReviewer.lastName,
			},
		]);

		const withoutCreator = rows.find((row) => row.id === authorless.id)!;
		expect(withoutCreator.requester).toBeNull();
		expect(withoutCreator.reviewers).toEqual([]);
	});

	test('includes authored and assigned reviews in one list', async () => {
		const mine = await seedReview({ projectId: teamProject.id, author: member, title: 'Mine' });
		const theirs = await seedReview({
			projectId: teamProject.id,
			author: owner,
			title: 'Assigned',
		});
		await reviewerRepository.addReviewers(
			{ workflowReviewRequestId: theirs.id, userIds: [member.id] },
			{},
		);
		const response = await memberAgent.get('/inbox').expect(200);
		expect(response.body.data.data.map((row: { id: string }) => row.id).sort()).toEqual(
			[mine.id, theirs.id].sort(),
		);
	});

	test('keeps co-authored reviews visible', async () => {
		const request = await seedReview({
			projectId: teamProject.id,
			author: owner,
			title: 'Co-authored',
		});
		await authorRepository.addAuthor(
			{ workflowReviewRequestId: request.id, userId: member.id },
			{},
		);
		const response = await memberAgent.get('/inbox').expect(200);
		expect(response.body.data.data).toEqual([expect.objectContaining({ id: request.id })]);
	});

	test('shows a requester the review for a workflow shared only with them', async () => {
		const sharedWorkflow = await createWorkflow({}, owner);
		await shareWorkflowWithUsers(sharedWorkflow, [member]);
		const request = await seedReview({
			projectId: ownerProject.id,
			workflowId: sharedWorkflow.id,
			author: member,
			title: 'Shared with me',
		});
		const response = await memberAgent.get('/inbox').expect(200);
		expect(response.body.data.data).toEqual([expect.objectContaining({ id: request.id })]);
	});
});
