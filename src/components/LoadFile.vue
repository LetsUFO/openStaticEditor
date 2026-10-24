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

const loadFiles = async function (needFiles: Record<string, any>) {
	state.loading = true;
	//todo 批量加载文件，以及让脚本处理每个文件
	const setFileData = useConfigStore().setFileData;
	const errors: string[] = [];
	const loadList = Object.keys(needFiles).map(async (key) => {
		const { fileSrc, readScriptSrc } = needFiles[key] || {};
		try {
			// 由主进程在 Node 环境中加载 custom 目录下的脚本并运行，返回解析后的数据
			const data = await window.api.readFile(fileSrc, readScriptSrc);
			await setFileData(key, data);
		} catch (err: any) {
			errors.push(`${key}: ${err?.message || err}`);
		}
	});
	await Promise.all(loadList);
	state.loading = false;
	if (errors.length) {
		message.error(`文件加载失败：\n${errors.join('\n')}`);
	} else {
		state.loaded = true;
		message.success('文件加载成功！');
	}
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
		<Button :type="'primary'" :size="'large'" @click="loadFiles(needFiles)">加载文件</Button>
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
