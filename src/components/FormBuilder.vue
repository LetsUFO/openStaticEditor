<script setup lang="ts">
import { reactive } from 'vue';

import { Form } from 'ant-design-vue';

interface Props {
	data?: Array<any>;
}

const props = withDefaults(defineProps<Props>(), {
	data: []
});
const formState = reactive({});
</script>

<template>
	<div>
		<Form :model="formState" :layout="'vertical'">
			<Form.Item v-for="li in props.data" :key="li.label" :label="li.label"></Form.Item>
		</Form>
	</div>
</template>

<style scoped></style>
