<script setup lang="ts">
import { Button, Select } from 'ant-design-vue';
import { computed, reactive } from 'vue';
import { useConfigStore } from '@renderer/stores/config';

interface Props {
	// 加载状态与结果由父级（App.vue）持有，本组件只负责展示与 emit
	loading: boolean;
	loaded: boolean;
}

const props = withDefaults(defineProps<Props>(), {
	loading: false,
	loaded: false
});
const emit = defineEmits(['loadFiles']);

const state = reactive({ targetFile: '' });
const needFiles = computed(() => {
	return useConfigStore().config?.loadFiles || {};
});
</script>

<template>
	<div
		class="root fixed w-full h-full backdrop-blur-md z-1 grid place-content-center transition ease-in-out"
		:class="{ 'opacity-0 pointer-events-none': loaded }"
	>
		<ul class="dark-fcLv3">
			<li v-for="(file, key) in needFiles" :key="key" class="mb-2 pb-2 border-b">
				<template v-if="file.fileSrc"> {{ key }}: {{ file.fileSrc }} </template>
				<template v-else>
					<div>{{ key }}: {{ file.filePath + state.targetFile }}</div>
					<Select :options=""></Select>
				</template>
			</li>
		</ul>
		<Button :type="'primary'" :size="'large'" :loading="loading" @click="emit('loadFiles')"
			>加载文件</Button
		>
	</div>
</template>

<style scoped>
.root {
	background-color: rgba(0, 0, 0, 0.8);
}
li {
	border-color: var(--dark-fcLv2);
}
</style>
