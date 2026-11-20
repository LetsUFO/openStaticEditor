<script setup lang="ts">
import { reactive, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useConfigStore } from '@renderer/stores/config';
import { resolvePathShorthand, splitFileSrcCandidates } from '@renderer/lib/lib';

import { Button, Input, Select } from 'ant-design-vue';

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

const configStore = useConfigStore();
const needFiles = storeToRefs(configStore).loadFiles;

// fileListMap / targetFileMap / dirMap 的 key 与 config.json -> loadFiles 的 key 一一对应
const state = reactive({
	targetFileMap: {} as Record<string, string>,
	fileListMap: {} as Record<string, string[]>,
	// 各 key 实际选中的目录（点「加载文件」拼接最终 fileSrc 时复用，避免重复解析简写）
	dirMap: {} as Record<string, string>
});

// filePath 支持用 `|` 配置多个备选目录，先拆分再逐个解析系统目录简写
const resolveDirCandidates = async function (filePath: string): Promise<string[]> {
	const candidates = splitFileSrcCandidates(filePath);
	if (!candidates.some((item) => item.includes('%'))) return candidates;
	const paths = await window.api.getPaths();
	return candidates.map((item) => resolvePathShorthand(item, paths));
};

// 刷新单个条目的文件列表：用 beforeScript 探测 filePath 指向的目录，
// 取第一个有文件的目录写入 dirMap / fileListMap，并默认选中第一个文件。
// 供「配置加载后整体刷新」与「用户选完文件夹后局部刷新」共用，避免重复逻辑。
const refreshFileList = async function (key: string) {
	const fileObj = needFiles.value[key];
	if (!fileObj?.beforeScript) return;
	// filePath 里的系统目录简写（%download% / %document% / %user%），规则见 @renderer/lib/lib
	const candidates = await resolveDirCandidates(fileObj.filePath || '');
	// 依次探测各备选目录，取第一个有文件的目录；都为空则退回第一个能访问的目录
	let dir = candidates[0] || '';
	let list: string[] = [];
	let fallbackDir = '';
	for (const candidate of candidates) {
		try {
			// 主进程 Node 环境运行 beforeScript，返回文件名列表
			const files = await window.api.runScript({
				scriptSrc: fileObj.beforeScript,
				filePath: candidate,
				baseSrc: configStore.baseSrc
			});
			const fileList = Array.isArray(files) ? files : [];
			if (fileList.length) {
				dir = candidate;
				list = fileList;
				break;
			}
			if (!fallbackDir) fallbackDir = candidate;
		} catch {
			// 目录不存在等异常，继续尝试下一个备选目录
		}
	}
	if (!list.length && fallbackDir) dir = fallbackDir;
	state.dirMap[key] = dir;
	state.fileListMap[key] = list;
	// 未选择或所选已不在列表中时，默认选中第一个
	if (!list.includes(state.targetFileMap[key])) {
		state.targetFileMap[key] = list[0] || '';
	}
};

// 配置加载 / 切换后，整体刷新所有条目的文件列表
watch(
	() => needFiles.value,
	async (fileMap) => {
		for (const key of Object.keys(fileMap)) {
			await refreshFileList(key);
		}
	},
	{ immediate: true }
);

// useFolderSelect 条目：弹出原生文件夹选择对话框，选中目录写回 file.filePath，
// 再刷新该目录下的文件列表（若配置了 beforeScript），供后续选择具体文件。
const pickFolder = async function (key: string) {
	const fileObj = needFiles.value[key];
	if (!fileObj) return;
	const dir = await window.api.selectDirectory(fileObj.filePath || '');
	if (!dir) return; // 用户取消，不改动
	fileObj.filePath = dir;
	state.dirMap[key] = dir;
	await refreshFileList(key);
};

// 点「加载文件」：把目录型条目（filePath + 选中文件名）拼成实际文件路径，
// 以 fileSrc 字段写回 store.config.loadFiles[key]，之后由 App.vue 按 fileSrc 统一加载
const onLoadFiles = function () {
	for (const key of Object.keys(needFiles.value)) {
		const fileObj = needFiles.value[key];
		if (!fileObj?.filePath || fileObj?.fileSrc) continue;
		const dir = state.dirMap[key] ?? fileObj.filePath;
		fileObj.fileSrc = dir + (state.targetFileMap[key] || '');
	}
	emit('loadFiles');
};
</script>

<template>
	<div
		class="loadFile fixed w-full h-full backdrop-blur-md z-1 grid place-content-center transition ease-in-out"
		:class="{ 'opacity-0 pointer-events-none': loaded }"
	>
		<div class="text-center pb-4 mb-8 text-white text-2xl border-b">加载文件</div>
		<ul class="dark-fcLv3">
			<li v-for="(file, key) in needFiles" :key="key" class="mb-4 pb-4 border-b">
				<template v-if="file.useFolderSelect">
					<div class="mb-2 flex items-center gap-2">
						<Input
							v-model:value="file.filePath"
							:placeholder="'输入游戏文件夹或通过右边的按钮进行选择'"
							class="flex-1"
						/>
						<Button @click="pickFolder(String(key))">选择文件夹</Button>
					</div>
				</template>
				<template v-else-if="file.fileSrc"> {{ key }}: {{ file.fileSrc }} </template>
				<template v-else>
					<div class="mb-2">
						{{ key }}:
						{{
							(state.dirMap[key] ?? file.filePath) + (state.targetFileMap[key] || '')
						}}
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
.loadFile {
	background-color: rgba(0, 0, 0, 0.8);
}
li {
	border-color: var(--dark-fcLv2);
}
</style>
