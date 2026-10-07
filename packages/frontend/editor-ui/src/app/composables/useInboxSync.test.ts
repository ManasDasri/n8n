import type { PushMessage } from '@n8n/api-types';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, reactive } from 'vue';

import { useInboxSync } from './useInboxSync';
import type { OnPushMessageHandler } from '@/app/stores/pushConnection.store';

const removeListener = vi.fn();
const inbox = reactive({
	enabled: true,
	isActive: false,
	refreshIfVisible: vi.fn(async () => {}),
	fetchSummary: vi.fn(async () => {}),
});
const push = reactive({
	isConnected: false,
	addEventListener: vi.fn((_listener: OnPushMessageHandler) => removeListener),
});
vi.mock('@n8n/frontend-module-inbox', () => ({ useInboxStore: () => inbox }));
vi.mock('@/app/stores/pushConnection.store', () => ({ usePushConnectionStore: () => push }));

const reviewEvent = { type: 'workflowReviewStateChanged', data: {} } as PushMessage;
function renderSync() {
	return mount(defineComponent({ setup: useInboxSync, template: '<div />' }));
}
async function sendReviewEvent() {
	push.addEventListener.mock.calls.at(-1)![0](reviewEvent);
	await flushPromises();
}

beforeEach(() => {
	vi.clearAllMocks();
	inbox.enabled = true;
	inbox.isActive = false;
	push.isConnected = false;
});
afterEach(() => vi.restoreAllMocks());

it('updates the navigation badge when a review changes outside Inbox', async () => {
	const view = renderSync();
	await sendReviewEvent();
	expect(inbox.fetchSummary).toHaveBeenCalledOnce();
	expect(inbox.refreshIfVisible).not.toHaveBeenCalled();
	view.unmount();
});

it('refreshes the mounted Inbox with its selected detail', async () => {
	inbox.isActive = true;
	const view = renderSync();
	await sendReviewEvent();
	expect(inbox.refreshIfVisible).toHaveBeenCalledOnce();
	expect(inbox.fetchSummary).not.toHaveBeenCalled();
	view.unmount();
});

it('refreshes counts after reconnecting outside Inbox', async () => {
	const view = renderSync();
	push.isConnected = true;
	await flushPromises();
	expect(inbox.fetchSummary).toHaveBeenCalledOnce();
	view.unmount();
});

it.each(['disabled', 'hidden'] as const)('does not request %s Inbox data', async (condition) => {
	if (condition === 'disabled') inbox.enabled = false;
	else vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
	const view = renderSync();
	await sendReviewEvent();
	expect(inbox.fetchSummary).not.toHaveBeenCalled();
	expect(inbox.refreshIfVisible).not.toHaveBeenCalled();
	view.unmount();
});

it('removes the listener when its scope is destroyed', () => {
	const view = renderSync();
	view.unmount();
	expect(removeListener).toHaveBeenCalledOnce();
});
