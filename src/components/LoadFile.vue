<script setup lang="ts">
import { Button, message } from 'ant-design-vue';
import { computed, reactive } from 'vue';
import { useConfigStore } from '@renderer/stores/config';

interface Props {
	// state: boolean;
}

const props = withDefaults(defineProps<Props>(), {
	// state: false
});

const needFiles = computed(() => {
	return useConfigStore().config?.loadFiles || {};
});
const state = reactive({ loaded: false, loading: false });

const loadFiles = function (fileArray: Array<string>) {
	state.loading = true;
	//todo 批量加载文件，以及让脚本处理每个文件
	useConfigStore()
		.setFileData()
		.then(() => {
			state.loading = false;
			state.loaded = true;
			message.success('文件加载成功！');
		});
};
</script>

<template>
	<div
		class="root fixed w-full h-full backdrop-blur-md z-1 grid place-content-center transition ease-in-out"
		:class="{ 'opacity-0 pointer-events-none': state.loaded }"
	>
		<ul class="dark-fcLv3">
			<li v-for="(file, key) in needFiles" :key="key" class="mb-2 pb-2 border-b">
				{{ key }}: {{ file.fileSrc }}
			</li>
		</ul>
		<Button :type="'primary'" :size="'large'" @click="loadFiles()">加载文件</Button>
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
