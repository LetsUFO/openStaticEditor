<script setup lang="ts">
import { useConfigStore } from './stores/config';
import { computed, reactive, ref, onMounted } from 'vue';
import { storeToRefs } from 'pinia';
import { dark } from './style/theme';

import { Button, Menu, message } from 'ant-design-vue';
import FormBuilder from './components/FormBuilder.vue';
import LoadFile from './components/LoadFile.vue';
import { DownloadOutlined, ReloadOutlined } from '@ant-design/icons-vue';
import { resolvePathShorthand } from '@renderer/lib/lib';
import { version as uiVersion } from '../package.json';

// 把 dark 的 fcLv 系列注入为 CSS 变量 --dark-fcLv*（单一来源 = theme.ts，供 style.scss 使用）
for (const [key, value] of Object.entries(dark)) {
	if (key.startsWith('fcLv')) {
		document.documentElement.style.setProperty(`--dark-${key}`, value as string);
	}
}

// menu 已在 store 里定义（store 负责把 config.json 的 menu 树转成 antd 需要的 items），
const configStore = useConfigStore();
const { menu, loadFiles: needFiles } = storeToRefs(configStore);

/**
 * 只用 menu 推导 openKeys。
 * ItemType 是联合类型且可能为 null，key 的类型是 `Key | undefined`（Key = string | number），
 * 所以分两步收窄：
 *   1. `li?.key` —— 可选链，挡掉 TS18047（'li' is possibly 'null'）
 *   2. `.filter((k): k is string => ...)` —— 类型谓词，把 `(Key | undefined)[]` 收窄成 `string[]`，挡掉 TS2322
 */
interface IState {
	loading: boolean;
	openKey: string[];
	selectedKey: string[];
	activeMenu: any;
}
const state = reactive<IState>({
	loading: false,
	openKey: menu.value.map((li) => li?.key).filter((k): k is string => typeof k === 'string'),
	selectedKey: [],
	activeMenu: {}
});
const activeCategory = computed(() => {
	return state.activeMenu.category || [];
});

// 背景图：config.json -> background.src（也可用 base64）。相对路径（如 custom/xxx.png）
// 交给主进程的 app-asset 协议按 custom -> 项目根/resources 的顺序解析，dev 与打包后都能加载。
// blur / alpha 通过 CSS 变量交给 .root::before，避免直接滤镜/透明度影响页面内容。
const backgroundStyle = computed(() => {
	const background = configStore.config?.background;
	const src = background?.src || background?.base64;
	if (!src) return {};
	const url = /^(?:data:|blob:|http:|https:)/i.test(src)
		? src
		: `app-asset://local/?src=${encodeURIComponent(src)}`;
	return {
		'--app-bg-image': `url("${url}")`,
		'--app-bg-blur': `${background?.blur ?? 0}px`,
		'--app-bg-alpha': `${background?.alpha ?? 1}`
	};
});

// 第一个叶子菜单项（有 children 就递归取第一个子项）
const firstLeaf = function (items: any[]): any {
	const first = items?.[0];
	if (!first) return null;
	return first.children?.length ? firstLeaf(first.children) : first;
};

// 激活指定菜单项：高亮 + 切换表单内容（等价于用户点击）
const activateMenu = function (item: any) {
	if (!item) return;
	state.activeMenu = item;
	state.selectedKey = typeof item.key === 'string' ? [item.key] : [];
};

// ---- 文件加载（原 LoadFile.vue 内逻辑，挪到父级以便重新加载按钮复用）----
const fileState = reactive({ loaded: false, loading: false });

// fileSrc 系统目录简写（%download% / %document% / %user%），解析规则见 @renderer/lib/lib
// 例如 Windows 存档可写成 `%user%/AppData/Local/ES2/Saved/SaveGames/ufo.sav`
// 替换后得到绝对路径，主进程会直接使用；无简写时原样返回（仍按 custom 目录解析）
const resolveFileSrc = async function (fileSrc: string): Promise<string> {
	if (!fileSrc || !fileSrc.includes('%')) return fileSrc;
	return resolvePathShorthand(fileSrc, await window.api.getPaths());
};

const loadFiles = async function (files: Record<string, any>) {
	fileState.loading = true;
	const setFileData = configStore.setFileData;
	const errors: string[] = [];
	const loadList = Object.keys(files).map(async (key) => {
		const { fileSrc, readScript } = files[key] || {};
		try {
			// 先解析 fileSrc 里的系统目录简写，再由主进程在 Node 环境中加载脚本并运行，返回解析后的数据
			const filePath = await resolveFileSrc(fileSrc);
			// 解析后的绝对路径存进 store，保存时直接取用
			configStore.setFilePath(key, filePath);
			const data = await window.api.readFile(filePath, readScript);
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

// LoadFile 遮罩的加载按钮：加载全部配置文件，成功后收起遮罩，并默认激活第一个菜单（有子菜单则取第一个子项）
const loadAll = async function () {
	if (await loadFiles(needFiles.value)) {
		fileState.loaded = true;
		activateMenu(firstLeaf(menu.value));
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

onMounted(async () => {
	// 先扫描 custom 下的子目录，根据数量决定加载策略
	try {
		const dirs = await window.api.listCustomDirs();
		if (dirs.length === 1) {
			// 只有 1 个子目录 → 自动加载
			const subPath = `${dirs[0]}/config.json`;
			const baseSrc = `${dirs[0]}/`;
			configStore.setBaseSrc(baseSrc);
			await configStore.load(subPath);
			// 按本次加载的 config.json 的 width / height 调整窗口尺寸
			const cfg = configStore.config;
			if (cfg?.width && cfg?.height) {
				await window.api.setWindowSize(cfg.width, cfg.height);
			}
			state.openKey = menu.value
				.map((li) => li?.key)
				.filter((k): k is string => typeof k === 'string');
		}
		// 多个子目录 → 保留，稍后处理（让用户选择）
	} catch (error) {
		console.error('[App] 扫描 custom 子目录失败：', error);
	}
});
</script>

<template>
	<div class="root h-full" :style="backgroundStyle">
		<LoadFile :loading="fileState.loading" :loaded="fileState.loaded" @loadFiles="loadAll" />
		<div class="flex justify-start h-full">
			<div class="menu w-[10rem] bg-primary overflow-y-auto">
				<Menu
					v-model:open-keys="state.openKey"
					v-model:selected-keys="state.selectedKey"
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
				<div class="ver select-none">
					UI:{{ uiVersion }}<br />main:{{ configStore.config?.ver }}
				</div>
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
.root {
	position: relative;
	isolation: isolate;
	// 背景单独放在伪元素上：blur / alpha 只作用于背景，不影响页面内容
	&::before {
		content: '';
		position: fixed;
		// 向外扩出模糊半径，避免边缘露出透明缝
		inset: calc(-2 * var(--app-bg-blur, 0px));
		z-index: -1;
		background: var(--app-bg-image) no-repeat center / cover;
		filter: blur(var(--app-bg-blur, 0px));
		opacity: var(--app-bg-alpha, 0.2);
	}
	.ver {
		position: absolute;
		z-index: 1;
		bottom: 0.5rem;
		left: 0.5rem;
		// theme.ts -> dark.fcLv3（启动时已注入为 CSS 变量，见 style.scss 的 .dark-fcLv*）
		color: var(--dark-fcLv1);
	}
}
.content {
	//底下多一点留白
	&::after {
		content: '';
		display: block;
		height: 1rem;
	}
}
</style>
