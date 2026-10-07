<script setup lang="ts">
import type { InboxItem, InboxState } from '@n8n/api-types';
import {
	N8nBadge,
	N8nButton,
	N8nCard,
	N8nHeading,
	N8nIcon,
	N8nLoading,
	N8nTabs,
	N8nText,
	N8nTimeAgo,
} from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { useRootStore } from '@n8n/stores/useRootStore';
import { computed } from 'vue';

import WorkflowReviewStatusDot from '../reviews/components/WorkflowReviewStatusDot.vue';

const props = defineProps<{
	items: InboxItem[];
	activeTab: InboxState;
	selectedKey: string | null;
	loading: boolean;
	loadingMore: boolean;
	hasMore: boolean;
	error: Error | null;
	partial: boolean;
	openCount: number | null;
	closedCount: number | null;
}>();
const emit = defineEmits<{
	select: [item: InboxItem];
	clear: [];
	'update:active-tab': [state: InboxState];
	loadMore: [];
	retry: [];
	refresh: [];
}>();
const i18n = useI18n();
const rootStore = useRootStore();
const tabs = computed(() => [
	{
		value: 'open',
		label: i18n.baseText('inbox.tabs.open'),
		tag: props.openCount === null ? undefined : String(props.openCount),
	},
	{
		value: 'closed',
		label: i18n.baseText('inbox.tabs.closed'),
		tag: props.closedCount === null ? undefined : String(props.closedCount),
	},
]);
function onTabChange(value: string | number | boolean) {
	if (value === 'open' || value === 'closed') emit('update:active-tab', value);
}
function outcomeLabel(item: InboxItem) {
	if (item.type === 'workflow_review') return i18n.baseText('inbox.source.workflowReview');
	switch (item.outcome) {
		case 'fix_ready':
			return i18n.baseText('inbox.outcome.fixReady');
		case 'needs_you':
			return i18n.baseText('inbox.outcome.needsAttention');
		case 'could_not_fix':
			return i18n.baseText('inbox.outcome.couldNotFix');
	}
}
</script>

<template>
	<aside :class="$style.sidebar" data-test-id="inbox-list">
		<div :class="$style.title">
			<N8nHeading bold tag="h2" size="xlarge">{{ i18n.baseText('inbox.title') }}</N8nHeading>
		</div>
		<N8nTabs
			:model-value="activeTab"
			:options="tabs"
			variant="modern"
			data-test-id="inbox-tabs"
			@update:model-value="onTabChange"
		/>
		<div v-if="partial" :class="$style.notice" role="status" data-test-id="inbox-partial">
			<N8nText size="small">{{ i18n.baseText('inbox.partial') }}</N8nText>
			<N8nButton
				size="mini"
				variant="subtle"
				:label="i18n.baseText('generic.retry')"
				@click="emit('refresh')"
			/>
		</div>
		<div
			:class="$style.list"
			role="listbox"
			:aria-label="i18n.baseText('inbox.title')"
			@click.self="emit('clear')"
		>
			<N8nLoading v-if="loading && items.length === 0" :loading="true" :rows="3" />
			<N8nCard
				v-for="item in items"
				:key="`${item.type}:${item.id}`"
				:class="[$style.card, { [$style.selected]: selectedKey === `${item.type}:${item.id}` }]"
				role="option"
				tabindex="0"
				:aria-selected="selectedKey === `${item.type}:${item.id}`"
				:data-source="item.type"
				data-test-id="inbox-row"
				@click="emit('select', item)"
				@keydown.enter.prevent="emit('select', item)"
				@keydown.space.prevent="emit('select', item)"
			>
				<div :class="$style.cardHeader">
					<N8nText bold tag="h3" :class="$style.cardTitle">{{
						item.type === 'workflow_review' ? item.title : item.summary
					}}</N8nText>
					<WorkflowReviewStatusDot
						v-if="item.type === 'workflow_review'"
						:state="item.state"
						:decision="item.decision"
					/>
					<N8nIcon v-else icon="sparkles" />
				</div>
				<N8nText size="xsmall" color="text-light">{{ outcomeLabel(item) }}</N8nText>
				<div :class="$style.meta">
					<N8nBadge v-if="item.workflowName" variant="outline" :class="$style.workflowName"
						><span :title="item.workflowName">{{ item.workflowName }}</span></N8nBadge
					>
					<N8nText :class="$style.time" size="xsmall" color="text-light"
						><N8nTimeAgo :date="item.createdAt" :locale="rootStore.defaultLocale"
					/></N8nText>
				</div>
			</N8nCard>
			<div v-if="error" :class="$style.notice" role="alert" data-test-id="inbox-list-error">
				<N8nText size="small">{{ i18n.baseText('inbox.loadError') }}</N8nText>
				<N8nButton
					size="mini"
					variant="subtle"
					:label="i18n.baseText('generic.retry')"
					@click="emit('retry')"
				/>
			</div>
			<N8nButton
				v-if="hasMore"
				:class="$style.loadMore"
				size="small"
				variant="subtle"
				:loading="loadingMore"
				:disabled="loading"
				:label="i18n.baseText('inbox.loadMore')"
				data-test-id="inbox-load-more"
				@click="emit('loadMore')"
			/>
		</div>
	</aside>
</template>

<style module lang="scss">
.sidebar {
	display: flex;
	flex-direction: column;
	min-width: 0;
	height: 100%;
	border-right: var(--border);
	padding-right: var(--spacing--md);
}
.title {
	display: flex;
	align-items: center;
	min-height: var(--spacing--2xl);
	padding-bottom: var(--spacing--sm);
}
.list {
	display: flex;
	flex: 1;
	flex-direction: column;
	gap: var(--spacing--2xs);
	overflow-y: auto;
	padding-block: var(--spacing--sm);
}
.notice {
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
	padding-block: var(--spacing--xs);
}
.card {
	cursor: pointer;
	padding: var(--spacing--xs);
	align-items: stretch;
}
.card:hover:not(.selected) {
	background: var(--background--hover);
}
.card:focus-visible {
	outline: var(--border-width) solid var(--focus--border-color);
}
.selected {
	background: var(--background--active);
}
.cardHeader {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--spacing--2xs);
}
.cardTitle {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	min-width: 0;
	font-size: var(--font-size--sm);
}
.meta {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--spacing--sm);
	margin-top: var(--spacing--2xs);
}
.workflowName {
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.time {
	flex-shrink: 0;
	white-space: nowrap;
}
.loadMore {
	align-self: center;
}
</style>
