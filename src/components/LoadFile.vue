<script setup lang="ts">
import { Button } from 'ant-design-vue';

interface Props {
	state: boolean;
}

const props = withDefaults(defineProps<Props>(), {
	state: false
});
</script>

<template>
	<div class="fixed w-full h-full">
		<Button :type="'primary'">加载</Button>
	</div>
</template>

<style scoped>
.hello {
	font-weight: 600;
	color: #2c3e50;
	margin: 12px 0;
}
</style>
