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
		saveScript: node.saveScript,
		...(node.children?.length ? { children: toMenuItems(node.children) } : {})
	}));
}

/** 脚本随数据回传的「函数文本」条目：加载后 eval 成真函数注入 fileData */
interface IFunctionTextListObj {
	name: string; // 注入到 fileData 的键（如 skillFilter）
	function: string; // 函数文本，如 "function (list, ctx) { return list.filter(...) }"
}
export const useConfigStore = defineStore('config', () => {
	const config = ref<AppConfig | null>(null);
	const fileData = ref<Record<string, any>>({}); //经过转换的文件数据
	// dataKey -> 已解析的存档绝对路径（loadFiles 时把 fileSrc 的 %download% 等简写转换后存入，
	// 保存脚本直接拿这个路径写回）
	const filePaths = ref<Record<string, string>>({});
	// fileData 每次写入自增。表单/下拉选项靠它触发刷新，
	// 避免对整份存档数据做 deep watch（存档里属性条目多，深度监听开销大）
	const dataVersion = ref(0);

	/** 当前加载的 custom 子目录（如 'ES2/'），用于路径重写 */
	const baseSrc = ref<string>('');

	/** 直接给 <Menu :items> 用 */
	const menu = computed<ItemType[]>(() => toMenuItems(config.value?.menu ?? []));
	/** config.json -> loadFiles（App.vue / LoadFile.vue 共用一个取值入口） */
	const loadFiles = computed<Record<string, any>>(() => config.value?.loadFiles ?? {});

	async function load(subPath?: string): Promise<void> {
		config.value = await window.api.getConfig(subPath);
	}
	function setBaseSrc(src: string): void {
		baseSrc.value = src;
	}
	function setFileData(fileKey: string, data: Record<string, any>): Promise<void> {
		return new Promise((resolve) => {
			if (!fileData.value[fileKey]) {
				fileData.value[fileKey] = {};
			}
			Object.assign(fileData.value[fileKey], data);
			if (Array.isArray(data?.functionTextList)) {
				data.functionTextList.forEach((li: IFunctionTextListObj) => {
					// 外层括号让 eval 把 "function (...)" 按函数表达式处理（直接 eval 会被当声明，返回 undefined）
					fileData.value[fileKey][li.name] = eval(`(${li.function})`);
				});
			}
			dataVersion.value++;
			console.log(fileData.value);
			resolve();
		});
	}

	/** 记录某个 dataKey 解析后的存档绝对路径（供保存脚本写回使用） */
	function setFilePath(fileKey: string, filePath: string): void {
		if (filePath) filePaths.value[fileKey] = filePath;
	}

	return {
		config,
		baseSrc,
		menu,
		loadFiles,
		load,
		setBaseSrc,
		fileData,
		filePaths,
		dataVersion,
		setFileData,
		setFilePath
	};
});
