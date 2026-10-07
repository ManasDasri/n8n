import { useInboxStore } from '@n8n/frontend-module-inbox';
import { onScopeDispose, watch } from 'vue';

import { usePushConnectionStore } from '@/app/stores/pushConnection.store';

/** Keep shell transport dependencies outside the Inbox package. */
export function useInboxSync() {
	const inboxStore = useInboxStore();
	const pushStore = usePushConnectionStore();
	function refresh() {
		if (document.hidden || !inboxStore.enabled) return;
		if (inboxStore.isActive) void inboxStore.refreshIfVisible();
		else void inboxStore.fetchSummary();
	}
	const removeListener = pushStore.addEventListener((event) => {
		if (event.type === 'workflowReviewStateChanged') refresh();
	});
	watch(
		() => pushStore.isConnected,
		(connected, previous) => {
			if (connected && !previous) refresh();
		},
	);
	onScopeDispose(removeListener);
}
