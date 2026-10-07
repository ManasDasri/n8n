import type { InboxItem, InboxSourceType, InboxState, ListInboxResponse } from '@n8n/api-types';
import { ResponseError } from '@n8n/rest-api-client';
import { useRootStore } from '@n8n/stores/useRootStore';
import { useSettingsStore } from '@n8n/stores/settings.store';
import { defineStore } from 'pinia';
import { computed, reactive, ref, watch } from 'vue';

import { fetchInbox, fetchInboxSummary } from './inbox.api';
import { INBOX_PAGE_LIMIT } from './inbox.constants';
import { toError } from './reviews/workflowReviews.utils';

const sourceTypes: InboxSourceType[] = ['workflow_review', 'self_healing_result'];

type ListState = {
	items: InboxItem[];
	nextCursor: string | null;
	hasMore: boolean;
	loading: boolean;
	loadingMore: boolean;
	error: Error | null;
	failedRequest: 'list' | 'loadMore' | null;
	partial: boolean;
	failedSources: InboxSourceType[];
};

function isSourceType(value: unknown): value is InboxSourceType {
	return value === 'workflow_review' || value === 'self_healing_result';
}

function disabledTypesFromError(error: unknown): InboxSourceType[] {
	const types = error instanceof ResponseError ? error.meta?.disabledSources : undefined;
	return Array.isArray(types) ? types.filter(isSourceType) : [];
}

export function createInboxListSlice(
	requestPage: (cursor?: string) => Promise<ListInboxResponse>,
	onDisabledSources: (types: InboxSourceType[]) => void,
	onPage?: (page: ListInboxResponse, append: boolean) => void,
) {
	const state = reactive<ListState>({
		items: [],
		nextCursor: null,
		hasMore: false,
		loading: false,
		loadingMore: false,
		error: null,
		failedRequest: null,
		partial: false,
		failedSources: [],
	});
	let requestSeq = 0;

	function applyResponse(page: ListInboxResponse, append: boolean) {
		onPage?.(page, append);
		onDisabledSources(page.disabledSources);
		state.items = append ? [...state.items, ...page.data] : page.data;
		state.nextCursor = page.nextCursor;
		state.hasMore = page.hasMore;
		state.partial = page.partial;
		state.failedSources = page.failedSources;
	}

	async function fetchList({ background = false } = {}) {
		if (background && (state.loading || state.loadingMore)) return;
		const seq = ++requestSeq;
		state.loading = true;
		state.loadingMore = false;
		state.error = null;
		state.failedRequest = null;
		try {
			const page = await requestPage();
			if (seq === requestSeq) applyResponse(page, false);
		} catch (error) {
			if (seq !== requestSeq) return;
			onDisabledSources(disabledTypesFromError(error));
			state.error = toError(error);
			state.failedRequest = 'list';
		} finally {
			if (seq === requestSeq) state.loading = false;
		}
	}

	async function loadMore() {
		if (state.loading || state.loadingMore || !state.hasMore || !state.nextCursor) return;
		const seq = ++requestSeq;
		state.loadingMore = true;
		state.error = null;
		state.failedRequest = null;
		try {
			const page = await requestPage(state.nextCursor);
			if (seq === requestSeq) applyResponse(page, true);
		} catch (error) {
			if (seq !== requestSeq) return;
			onDisabledSources(disabledTypesFromError(error));
			state.error = toError(error);
			state.failedRequest = 'loadMore';
		} finally {
			if (seq === requestSeq) state.loadingMore = false;
		}
	}

	function removeSources(types: InboxSourceType[]) {
		state.items = state.items.filter((item) => !types.includes(item.type));
	}

	function invalidateSourceSet(types: InboxSourceType[]) {
		requestSeq++;
		removeSources(types);
		state.nextCursor = null;
		state.hasMore = false;
		state.loading = false;
		state.loadingMore = false;
	}

	function reset() {
		requestSeq++;
		state.items = [];
		state.nextCursor = null;
		state.hasMore = false;
		state.loading = false;
		state.loadingMore = false;
		state.error = null;
		state.failedRequest = null;
		state.partial = false;
		state.failedSources = [];
	}

	return Object.assign(state, {
		fetchList,
		loadMore,
		removeSources,
		invalidateSourceSet,
		reset,
		async retry() {
			if (state.failedRequest === 'loadMore') await loadMore();
			else await fetchList();
		},
	});
}

export const useInboxStore = defineStore('inbox', () => {
	const rootStore = useRootStore();
	const settingsStore = useSettingsStore();
	const activeTab = ref<InboxState>('open');
	const isActive = ref(false);
	const openCount = ref<number | null>(null);
	const closedCount = ref<number | null>(null);
	const summaryPartial = ref(false);
	const disabledSources = ref<InboxSourceType[]>([]);
	const enabled = computed(() => settingsStore.settings.inbox?.enabled === true);
	const activeViews: Array<() => Promise<void>> = [];
	let summaryRequestSeq = 0;
	let refreshPending: Promise<void> | undefined;

	function removeDisabledSources(types: InboxSourceType[]) {
		if (types.length === 0) return;
		disabledSources.value = [...new Set([...disabledSources.value, ...types])];
		lists.open.removeSources(types);
		lists.closed.removeSources(types);
	}

	function reconcileSources(page: ListInboxResponse, append: boolean) {
		if (append) {
			const returnedTypes = page.data.map((item) => item.type);
			disabledSources.value = disabledSources.value.filter(
				(type) => page.disabledSources.includes(type) || !returnedTypes.includes(type),
			);
			return;
		}
		const settings = settingsStore.settings.inbox;
		const knownTypes = new Set([
			...(settings?.availableTypes ?? []),
			...(settings?.failedTypes ?? []),
			...page.data.map((item) => item.type),
		]);
		disabledSources.value = sourceTypes.filter(
			(type) =>
				!knownTypes.has(type) ||
				page.disabledSources.includes(type) ||
				(disabledSources.value.includes(type) && page.failedSources.includes(type)),
		);
	}

	function requestPage(state: InboxState) {
		return async (cursor?: string) =>
			await fetchInbox(rootStore.restApiContext, { state, limit: INBOX_PAGE_LIMIT, cursor });
	}
	const lists = {
		open: createInboxListSlice(requestPage('open'), removeDisabledSources, reconcileSources),
		closed: createInboxListSlice(requestPage('closed'), removeDisabledSources, reconcileSources),
	};
	const activeList = computed(() => lists[activeTab.value]);
	const countsAreComplete = computed(
		() =>
			!summaryPartial.value &&
			(!isActive.value || (!activeList.value.partial && !activeList.value.error)),
	);
	const badgeCount = computed(() => (countsAreComplete.value ? openCount.value : null));

	async function fetchSummary() {
		if (!enabled.value) return;
		const seq = ++summaryRequestSeq;
		try {
			const summary = await fetchInboxSummary(rootStore.restApiContext);
			if (seq !== summaryRequestSeq) return;
			removeDisabledSources(summary.disabledSources);
			openCount.value = summary.counts?.open ?? null;
			closedCount.value = summary.counts?.closed ?? null;
			summaryPartial.value = summary.partial;
		} catch (error) {
			if (seq !== summaryRequestSeq) return;
			removeDisabledSources(disabledTypesFromError(error));
			openCount.value = null;
			closedCount.value = null;
			summaryPartial.value = true;
		}
	}

	async function refresh({ background = false } = {}) {
		if (!enabled.value) return;
		if (background && (refreshPending || activeList.value.loading || activeList.value.loadingMore))
			return;
		const request = Promise.allSettled([
			activeList.value.fetchList({ background }),
			fetchSummary(),
		]).then(() => {});
		refreshPending = request;
		try {
			await request;
		} finally {
			if (refreshPending === request) refreshPending = undefined;
		}
	}

	function activate(refreshDetail: () => Promise<void> = async () => {}) {
		activeViews.push(refreshDetail);
		isActive.value = true;
		return () => {
			const index = activeViews.indexOf(refreshDetail);
			if (index !== -1) activeViews.splice(index, 1);
			isActive.value = activeViews.length > 0;
		};
	}

	async function refreshIfVisible() {
		if (!isActive.value || document.hidden || !enabled.value) return;
		await refresh({ background: true });
		if (isActive.value && !document.hidden && enabled.value) await activeViews.at(-1)?.();
	}

	async function setActiveTab(tab: InboxState) {
		if (activeTab.value === tab) return;
		activeTab.value = tab;
		if (enabled.value) await lists[tab].fetchList();
	}

	function reset() {
		summaryRequestSeq++;
		lists.open.reset();
		lists.closed.reset();
		openCount.value = null;
		closedCount.value = null;
		summaryPartial.value = false;
		const settings = settingsStore.settings.inbox;
		const available = [...(settings?.availableTypes ?? []), ...(settings?.failedTypes ?? [])];
		disabledSources.value = sourceTypes.filter((type) => !available.includes(type));
	}

	watch(
		() => {
			const settings = settingsStore.settings.inbox;
			return `${settings?.enabled}:${settings?.availableTypes.join(',')}:${settings?.failedTypes.join(',')}`;
		},
		() => {
			const settings = settingsStore.settings.inbox;
			const available = [...(settings?.availableTypes ?? []), ...(settings?.failedTypes ?? [])];
			const disabled = sourceTypes.filter((type) => !available.includes(type));
			summaryRequestSeq++;
			openCount.value = null;
			closedCount.value = null;
			lists.open.invalidateSourceSet(disabled);
			lists.closed.invalidateSourceSet(disabled);
			disabledSources.value = disabled;
			if (!settings?.enabled) {
				lists.open.reset();
				lists.closed.reset();
			} else void refreshIfVisible();
		},
		{ immediate: true },
	);

	return {
		lists,
		activeTab,
		activeList,
		isActive,
		enabled,
		openCount,
		closedCount,
		disabledSources,
		countsAreComplete,
		badgeCount,
		fetchSummary,
		refresh,
		activate,
		refreshIfVisible,
		setActiveTab,
		reset,
	};
});
