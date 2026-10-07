import type { InboxItem, InboxSelfHealingItem, ListInboxResponse } from '@n8n/api-types';
import { ResponseError } from '@n8n/rest-api-client';
import { useSettingsStore } from '@n8n/stores/settings.store';
import { createDeferredPromise } from '@n8n/utils/promise/deferred-promise';
import { nextTick } from 'vue';

import * as api from './inbox.api';
import { createInboxListSlice, useInboxStore } from './inbox.store';

vi.mock('./inbox.api');

function result(id: string): InboxSelfHealingItem {
	return {
		id,
		type: 'self_healing_result',
		state: 'open',
		projectId: 'project',
		workflowId: 'workflow',
		workflowName: 'Workflow',
		summary: 'Review the proposed fix',
		outcome: 'fix_ready',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		completedAt: '2026-01-01T00:00:00.000Z',
	};
}
function page(
	data: InboxItem[] = [],
	overrides: Partial<ListInboxResponse> = {},
): ListInboxResponse {
	return {
		data,
		nextCursor: null,
		hasMore: false,
		partial: false,
		failedSources: [],
		disabledSources: [],
		...overrides,
	};
}
function enableInbox() {
	useSettingsStore().settings.inbox = {
		enabled: true,
		availableTypes: ['workflow_review', 'self_healing_result'],
		failedTypes: [],
	};
}

beforeEach(() => {
	vi.resetAllMocks();
	enableInbox();
	vi.mocked(api.fetchInboxSummary).mockResolvedValue({
		counts: { open: 2, closed: 1 },
		partial: false,
		failedSources: [],
		disabledSources: [],
	});
	vi.mocked(api.fetchInbox).mockResolvedValue(page());
});

describe('Inbox list requests', () => {
	it('keeps existing rows during refresh and after a transient refresh failure', async () => {
		const pending = createDeferredPromise<ListInboxResponse>();
		const request = vi
			.fn()
			.mockResolvedValueOnce(page([result('first')]))
			.mockReturnValueOnce(pending.promise);
		const slice = createInboxListSlice(request, vi.fn());
		await slice.fetchList();
		const refresh = slice.fetchList({ background: true });
		expect(slice.items.map((item) => item.id)).toEqual(['first']);
		pending.reject(new Error('temporarily unavailable'));
		await refresh;
		expect(slice.items.map((item) => item.id)).toEqual(['first']);
		expect(slice.error).toBeInstanceOf(Error);
	});

	it('ignores an old load-more response after refreshing from the first page', async () => {
		const pending = createDeferredPromise<ListInboxResponse>();
		const request = vi
			.fn()
			.mockResolvedValueOnce(page([result('first')], { hasMore: true, nextCursor: 'page-2' }))
			.mockReturnValueOnce(pending.promise)
			.mockResolvedValueOnce(page([result('newest')]));
		const slice = createInboxListSlice(request, vi.fn());
		await slice.fetchList();
		const loadMore = slice.loadMore();
		await slice.fetchList();
		pending.resolve(page([result('older')]));
		await loadMore;
		expect(slice.items.map((item) => item.id)).toEqual(['newest']);
		expect(slice.loadingMore).toBe(false);
	});

	it('continues a partial cursor chain and retries a failed page without losing its rows', async () => {
		const partial = { partial: true, failedSources: ['workflow_review' as const] };
		const request = vi
			.fn()
			.mockResolvedValueOnce(
				page([result('first')], { ...partial, hasMore: true, nextCursor: 'partial-page' }),
			)
			.mockRejectedValueOnce(new Error('timeout'))
			.mockResolvedValueOnce(page([result('older')], partial));
		const slice = createInboxListSlice(request, vi.fn());
		await slice.fetchList();
		await slice.loadMore();
		expect(slice.nextCursor).toBe('partial-page');
		expect(slice.items).toHaveLength(1);
		await slice.retry();
		expect(request).toHaveBeenLastCalledWith('partial-page');
		expect(slice.items).toHaveLength(2);
		expect(slice.partial).toBe(true);
	});
});

describe('shared Inbox state', () => {
	it('keeps requests for Open and Closed independent', async () => {
		const open = createDeferredPromise<ListInboxResponse>();
		vi.mocked(api.fetchInbox).mockImplementation(async (_context, query) =>
			query.state === 'open' ? await open.promise : page([result('closed')]),
		);
		const store = useInboxStore();
		const request = store.refresh();
		await store.setActiveTab('closed');
		open.resolve(page([result('open')]));
		await request;
		expect(store.activeTab).toBe('closed');
		expect(store.activeList.items[0].id).toBe('closed');
		expect(store.lists.open.items[0].id).toBe('open');
	});

	it('treats a failed count as unknown while the list remains usable', async () => {
		vi.mocked(api.fetchInbox).mockResolvedValue(page([result('first')]));
		vi.mocked(api.fetchInboxSummary).mockResolvedValue({
			counts: null,
			partial: true,
			failedSources: ['workflow_review'],
			disabledSources: [],
		});
		const store = useInboxStore();
		await store.refresh();
		expect(store.activeList.items).toHaveLength(1);
		expect(store.openCount).toBeNull();
		expect(store.badgeCount).toBeNull();
	});

	it('invalidates pending lists and summaries when a source is disabled', async () => {
		const list = createDeferredPromise<ListInboxResponse>();
		const summary = createDeferredPromise<Awaited<ReturnType<typeof api.fetchInboxSummary>>>();
		vi.mocked(api.fetchInbox).mockReturnValueOnce(list.promise);
		vi.mocked(api.fetchInboxSummary).mockReturnValueOnce(summary.promise);
		const store = useInboxStore();
		const request = store.refresh();
		useSettingsStore().settings.inbox = {
			enabled: true,
			availableTypes: ['workflow_review'],
			failedTypes: [],
		};
		await nextTick();
		list.resolve(page([result('hidden')]));
		summary.resolve({
			counts: { open: 99, closed: 0 },
			partial: false,
			failedSources: [],
			disabledSources: [],
		});
		await request;
		expect(store.activeList.items).toEqual([]);
		expect(store.openCount).toBeNull();
		expect(store.disabledSources).toContain('self_healing_result');
	});

	it('clears disabled-source rows from both tabs even when all reads fail', async () => {
		const store = useInboxStore();
		store.lists.open.items = [result('open')];
		store.lists.closed.items = [result('closed')];
		vi.mocked(api.fetchInbox).mockRejectedValue(
			new ResponseError('unavailable', {
				httpStatusCode: 503,
				meta: { disabledSources: ['self_healing_result'], failedSources: ['workflow_review'] },
			}),
		);
		await store.refresh();
		expect(store.lists.open.items).toEqual([]);
		expect(store.lists.closed.items).toEqual([]);
		expect(store.disabledSources).toEqual(['self_healing_result']);
	});

	it('does not overlap background refreshes or load-more', async () => {
		const pending = createDeferredPromise<ListInboxResponse>();
		vi.mocked(api.fetchInbox).mockReturnValueOnce(pending.promise);
		const store = useInboxStore();
		const first = store.refresh({ background: true });
		await store.refresh({ background: true });
		expect(api.fetchInbox).toHaveBeenCalledTimes(1);
		pending.resolve(page());
		await first;
		store.activeList.loadingMore = true;
		await store.refresh({ background: true });
		expect(api.fetchInbox).toHaveBeenCalledTimes(1);
	});
});

it('allows a source to recover on a fresh page without a settings reload', async () => {
	const store = useInboxStore();
	vi.mocked(api.fetchInbox)
		.mockResolvedValueOnce(page([], { disabledSources: ['self_healing_result'] }))
		.mockResolvedValueOnce(page([result('recovered')]));
	await store.refresh();
	expect(store.disabledSources).toContain('self_healing_result');
	await store.refresh();
	expect(store.disabledSources).not.toContain('self_healing_result');
	expect(store.activeList.items[0].id).toBe('recovered');
});

it('refreshes the latest mounted detail and keeps it active when an older view unmounts', async () => {
	const store = useInboxStore();
	const oldDetail = vi.fn().mockResolvedValue(undefined);
	const currentDetail = vi.fn().mockResolvedValue(undefined);
	const leaveOld = store.activate(oldDetail);
	const leaveCurrent = store.activate(currentDetail);
	leaveOld();
	await store.refreshIfVisible();
	expect(store.isActive).toBe(true);
	expect(oldDetail).not.toHaveBeenCalled();
	expect(currentDetail).toHaveBeenCalledOnce();
	leaveCurrent();
	await store.refreshIfVisible();
	expect(store.isActive).toBe(false);
	expect(currentDetail).toHaveBeenCalledOnce();
});

it('allows a source first seen on a later page when settings were stale', async () => {
	useSettingsStore().settings.inbox = {
		enabled: true,
		availableTypes: ['self_healing_result'],
		failedTypes: [],
	};
	const review: InboxItem = {
		type: 'workflow_review',
		id: 'review',
		projectId: 'project',
		title: 'Review',
		workflowName: 'Workflow',
		requester: null,
		authors: [],
		reviewers: [],
		state: 'open',
		decision: 'pending',
		workflowVersionId: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	};
	vi.mocked(api.fetchInbox)
		.mockResolvedValueOnce(page([result('newer')], { hasMore: true, nextCursor: 'next' }))
		.mockResolvedValueOnce(page([review]));
	const store = useInboxStore();
	await store.refresh();
	expect(store.disabledSources).toContain('workflow_review');
	await store.activeList.loadMore();
	expect(store.disabledSources).not.toContain('workflow_review');
	expect(store.activeList.items.at(-1)?.id).toBe('review');
});
