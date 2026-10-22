<script setup lang="ts">
import { reactive } from 'vue';

import { Form, Select } from 'ant-design-vue';

interface Props {
	data?: Array<any>;
}

const props = withDefaults(defineProps<Props>(), {
	data: () => []
});
const formState = reactive({});
</script>

<template>
	<Form :model="formState" :layout="'vertical'">
		<div v-for="li in props.data">
			<Form.Item v-for="item in li.items" :key="item.label" :label="item.label">
				<Select v-model:value="formState[item.name]"></Select>
			</Form.Item>
		</div>
	</Form>
</template>

<style scoped></style>
