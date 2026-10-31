<script setup lang="ts">
import { useConfigStore } from './stores/config';
import { computed, reactive, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { dark } from './style/theme';

import { Button, Menu, message } from 'ant-design-vue';
import FormBuilder from './components/FormBuilder.vue';
import LoadFile from './components/LoadFile.vue';
import { DownloadOutlined, ReloadOutlined } from '@ant-design/icons-vue';

// 把 dark 的 fcLv 系列注入为 CSS 变量 --dark-fcLv*（单一来源 = theme.ts，供 style.scss 使用）
for (const [key, value] of Object.entries(dark)) {
	if (key.startsWith('fcLv')) {
		document.documentElement.style.setProperty(`--dark-${key}`, value as string);
	}
}

// menu 已在 store 里定义（store 负责把 config.json 的 menu 树转成 antd 需要的 items），
const configStore = useConfigStore();
const { menu } = storeToRefs(configStore);

/**
 * 只用 menu 推导 openKeys（不依赖 store 的 rootKeys）。
 * ItemType 是联合类型且可能为 null，key 的类型是 `Key | undefined`（Key = string | number），
 * 所以分两步收窄：
 *   1. `li?.key` —— 可选链，挡掉 TS18047（'li' is possibly 'null'）
 *   2. `.filter((k): k is string => ...)` —— 类型谓词，把 `(Key | undefined)[]` 收窄成 `string[]`，挡掉 TS2322
 */
interface IState {
	loading: boolean;
	openKey: string[];
	activeMenu: any;
}
const state = reactive<IState>({
	loading: false,
	openKey: menu.value.map((li) => li?.key).filter((k): k is string => typeof k === 'string'),
	activeMenu: {}
});
const activeCategory = computed(() => {
	return state.activeMenu.category || [];
});

// ---- 文件加载（原 LoadFile.vue 内逻辑，挪到父级以便重新加载按钮复用）----
const needFiles = computed(() => configStore.config?.loadFiles || {});
const fileState = reactive({ loaded: false, loading: false });

// fileSrc 系统目录简写（成对 %，不区分大小写）：
//   %download% → 系统下载目录，%document% → 系统文档目录
// 替换后得到绝对路径，主进程会直接使用；无简写时原样返回（仍按 custom 目录解析）
const resolveFileSrc = async function (fileSrc: string): Promise<string> {
	if (!fileSrc || !fileSrc.includes('%')) return fileSrc;
	const paths = await window.api.getPaths();
	const dirMap: Record<string, string> = {
		download: paths.downloads,
		document: paths.documents
	};
	return fileSrc.replace(/%([^%]+)%/g, (_match, key: string) => {
		const dir = dirMap[key.toLowerCase()];
		if (!dir) throw new Error(`未知路径简写 %${key}%（当前支持 %download% / %document%）`);
		return dir;
	});
};

const loadFiles = async function (files: Record<string, any>) {
	fileState.loading = true;
	const setFileData = configStore.setFileData;
	const errors: string[] = [];
	const loadList = Object.keys(files).map(async (key) => {
		const { fileSrc, readScriptSrc } = files[key] || {};
		try {
			// 先解析 fileSrc 里的系统目录简写，再由主进程在 Node 环境中加载脚本并运行，返回解析后的数据
			const filePath = await resolveFileSrc(fileSrc);
			// 解析后的绝对路径存进 store，保存时直接取用
			configStore.setFilePath(key, filePath);
			const data = await window.api.readFile(filePath, readScriptSrc);
			await setFileData(key, data);
		} catch (err: any) {
			errors.push(`${key}: ${err?.message || err}`);
		}
	});
	await Promise.all(loadList);
	fileState.loading = false;
	if (errors.length) {
		message.error(`文件加载失败：\n${errors.join('\n')}`);
		return false;
	}
	return true;
};

// LoadFile 遮罩的加载按钮：加载全部配置文件，成功后收起遮罩
const loadAll = async function () {
	if (await loadFiles(needFiles.value)) {
		fileState.loaded = true;
		message.success('文件加载成功！');
	}
};

// 重新加载按钮：只刷新当前分类对应的文件
const reload = async function () {
	const dataKey = state.activeMenu.dataKey;
	const fileCfg = dataKey ? needFiles.value[dataKey] : null;
	if (!fileCfg) {
		message.warning('当前分类未配置文件');
		return;
	}
	if (await loadFiles({ [dataKey]: fileCfg })) {
		message.success('文件加载成功！');
	}
};

const $FormBuilder = ref();

/**
 * @param saveCfg config.json 里的 { needFileKey, saveScript }
 * 表单直接绑定 store.fileData[dataKey]，所以这里拿到的就是改完的完整数据。
 */
const save = async function (saveCfg: any = {}) {
	const formData = ($FormBuilder.value as any)?.getFormData?.() || {};
	if (!saveCfg.saveScript) {
		message.warning('该分类未配置保存脚本（config.json -> saveScript.saveScript）');
		return;
	}
	state.loading = true;
	try {
		// IPC 走结构化克隆，无法传递函数（functionTextList 注入的 skillFilter 等），
		// 先做一次 JSON 往返，只保留可序列化的纯数据
		const data = JSON.parse(JSON.stringify(formData));

		// 写回目标 = 该分类 loadFiles 已解析好的存档绝对路径（存于 store.filePaths）
		const filePath = saveCfg.needFileKey
			? configStore.filePaths[saveCfg.needFileKey] || ''
			: '';

		await window.api.runScript({
			scriptSrc: saveCfg.saveScript,
			dataKey: saveCfg.needFileKey,
			filePath,
			data
		});
		message.success('保存成功！');
	} catch (error: any) {
		message.error(`保存失败：${error?.message || error}`);
	} finally {
		state.loading = false;
	}
};
</script>

<template>
	<div class="h-full">
		<LoadFile :loading="fileState.loading" :loaded="fileState.loaded" @loadFiles="loadAll" />
		<div class="flex justify-start h-full">
			<div class="menu w-[10rem] bg-primary overflow-y-auto">
				<Menu
					v-model:open-keys="state.openKey"
					:theme="'dark'"
					:items="menu"
					:mode="'inline'"
					class="relative select-none h-full"
					@select="
						({ item }) => {
							state.activeMenu = item;
						}
					"
				></Menu>
			</div>
			<div class="content flex-1 h-full overflow-y-auto">
				<FormBuilder
					:config="activeCategory"
					:dataKey="state.activeMenu.dataKey"
					ref="$FormBuilder"
				/>
				<div class="absolute bottom-4 right-4">
					<Button :loading="fileState.loading" @click="reload()">
						<ReloadOutlined />重新加载</Button
					>
					<Button
						v-if="state.activeMenu?.category?.length"
						class="ml-4"
						:type="'primary'"
						:loading="state.loading"
						@click="save(state.activeMenu.saveScript)"
					>
						<DownloadOutlined />保存</Button
					>
				</div>
			</div>
		</div>
	</div>
</template>

<style lang="scss" scoped>
.content {
	//底下多一点留白
	&::after {
		content: '';
		display: block;
		height: 1rem;
	}
}
</style>
