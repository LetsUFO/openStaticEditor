import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { ItemType } from 'ant-design-vue/es/menu';

// AppConfig / AppMenuItem 为全局类型，定义在 src/vite-env.d.ts（单一来源，避免字段两处漂移）

/**
 * config.json 的 menu 树 → antd Menu 需要的 items。
 * antd 的 Menu 依赖 key 做展开/选中，而 config.json 里只有 label，
 * 所以这里递归用 label 充当 key（不修改原始数据，返回新对象）。
 */
function toMenuItems(list: AppMenuItem[]): ItemType[] {
	return list.map((node) => ({
		key: node.label,
		label: node.label,
		tip: node.tip,
		category: node.category,
		dataKey: node.dataKey,
		...(node.children?.length ? { children: toMenuItems(node.children) } : {})
	}));
}

export const useConfigStore = defineStore('config', () => {
	const config = ref<AppConfig | null>(null);
	const fileData = ref<Record<string, any>>({}); //经过转换的文件数据

	/** 直接给 <Menu :items> 用 */
	const menu = computed<ItemType[]>(() => toMenuItems(config.value?.menu ?? []));

	/** 顶层菜单 key 列表，可作为 openKeys 默认值 */
	const rootKeys = computed<string[]>(() => (config.value?.menu ?? []).map((item) => item.label));

	async function load(): Promise<void> {
		config.value = await window.api.getConfig();
	}
	function setFileData(fileKey: string, data: Record<string, any>): Promise<void> {
		return new Promise((resolve, reject) => {
			if (!fileData.value[fileKey]) {
				fileData.value[fileKey] = {};
			}
			Object.assign(fileData.value[fileKey], data);
			resolve();
		});
	}

	return { config, menu, rootKeys, load, fileData, setFileData };
});
