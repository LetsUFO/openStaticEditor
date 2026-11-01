<script setup lang="ts">
import { reactive, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useConfigStore } from '@renderer/stores/config';
import { resolvePathShorthand } from '@renderer/lib/lib';

import { Button, Select } from 'ant-design-vue';

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

// fileListMap / targetFileMap 的 key 与 config.json -> loadFiles 的 key 一一对应
const state = reactive({
	targetFileMap: {} as Record<string, string>,
	fileListMap: {} as Record<string, string[]>
});
const needFiles = storeToRefs(useConfigStore()).loadFiles;

// 各 key 解析后的目录（点「加载文件」拼接最终 fileSrc 时复用，避免重复解析简写）
const resolvedDirMap: Record<string, string> = {};

watch(
	() => needFiles.value,
	async (fileMap) => {
		for (const key of Object.keys(fileMap)) {
			const fileObj = fileMap[key];
			if (!fileObj?.beforeScript) continue;
			// 解析 filePath 里的系统目录简写（%download% / %document% / %user%），规则见 @renderer/lib/lib
			let dir: string = fileObj.filePath || '';
			if (dir.includes('%')) dir = resolvePathShorthand(dir, await window.api.getPaths());
			resolvedDirMap[key] = dir;
			// 主进程 Node 环境运行 beforeScript，返回文件名列表
			const list = await window.api.runScript({
				scriptSrc: fileObj.beforeScript,
				filePath: dir
			});
			state.fileListMap[key] = Array.isArray(list) ? list : [];
			// 未选择或所选已不在列表中时，默认选中第一个
			if (!state.fileListMap[key].includes(state.targetFileMap[key])) {
				state.targetFileMap[key] = state.fileListMap[key][0] || '';
			}
		}
	},
	{ immediate: true }
);

// 点「加载文件」：把目录型条目（filePath + 选中文件名）拼成实际文件路径，
// 以 fileSrc 字段写回 store.config.loadFiles[key]，之后由 App.vue 按 fileSrc 统一加载
const onLoadFiles = function () {
	for (const key of Object.keys(needFiles.value)) {
		const fileObj = needFiles.value[key];
		if (!fileObj?.filePath || fileObj?.fileSrc) continue;
		const dir = resolvedDirMap[key] ?? fileObj.filePath;
		fileObj.fileSrc = dir + (state.targetFileMap[key] || '');
	}
	emit('loadFiles');
};
</script>

<template>
	<div
		class="root fixed w-full h-full backdrop-blur-md z-1 grid place-content-center transition ease-in-out"
		:class="{ 'opacity-0 pointer-events-none': loaded }"
	>
		<ul class="dark-fcLv3">
			<li v-for="(file, key) in needFiles" :key="key" class="mb-4 pb-4 border-b">
				<template v-if="file.fileSrc"> {{ key }}: {{ file.fileSrc }} </template>
				<template v-else>
					<div class="mb-2">
						{{ key }}: {{ file.filePath + (state.targetFileMap[key] || '') }}
					</div>
					<Select
						v-model:value="state.targetFileMap[key]"
						:options="
							(state.fileListMap[key] || []).map((fileName) => ({
								label: fileName,
								value: fileName
							}))
						"
						class="w-full"
					></Select>
				</template>
			</li>
		</ul>
		<Button :type="'primary'" :size="'large'" :loading="loading" @click="onLoadFiles"
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
