<script setup lang="ts">
import { ref, watch } from 'vue';

import { Form, InputNumber, Select } from 'ant-design-vue';
import { useConfigStore } from '@renderer/stores/config';

interface Props {
	config?: Array<any>;
	dataKey: string;
}

const props = withDefaults(defineProps<Props>(), {
	config: () => [],
	dataKey: ''
});
const formState = ref<Record<string, any>>({});
watch(
	() => props.dataKey,
	(key: string) => {
		formState.value = useConfigStore().fileData?.[key] || {};
	}
	// { immediate: true }
);
</script>

<template>
	<Form :model="formState" :layout="'vertical'">
		<template v-for="li in props.config" :key="li.label">
			<div class="px-4 pt-4 pb-2 text-fcLv1 text-base border-b border-split italic">
				{{ li.label }}
			</div>
			<div class="mt-2 px-4 flex flex-wrap">
				<Form.Item
					v-for="item in li.items"
					:key="item.label"
					:label="item.label"
					class="w-1/3 !pr-4"
				>
					<InputNumber
						v-if="item.type == 'number'"
						v-model:value="formState[item.name]"
						:min="item.min"
						:max="item.max"
						class="w-full!"
					></InputNumber>
					<Select
						v-else-if="item.type == 'select'"
						v-model:value="formState[item.name]"
						:options="item.options"
					></Select>
				</Form.Item>
			</div>
		</template>
	</Form>
</template>

<style scoped></style>
