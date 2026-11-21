import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { ItemType } from 'ant-design-vue/es/menu';
import { isObject } from 'lodash';
import { isLoadFileEntryConfigured } from '@renderer/lib/lib';

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
	// 默认空对象而非 null：各处统一用可选链读取，避免 null 判断散落；
	// 用 Partial 表示「尚未加载完整配置」，字段访问保持可选（App.vue 里 cfg?.width 等）。
	const config = ref<Partial<AppConfig>>({});
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
	/**
	 * 是否需要走文件加载流程（对象级判定，决定加载页展示与否）：
	 * 只看 config.json 里 loadFiles 字段本身——字段缺失，或值为空对象 {} 时为 false（跳过加载页）；
	 * 只要 loadFiles 下存在任意 key 即为 true（展示加载页）。条目内部字段（fileSrc / useFolderSelect 等）
	 * 不影响此判定，那些只影响下面 loadFiles computed 里哪些条目参与加载与列表展示。
	 */
	const hasLoadFiles = computed(() => {
		const raw = config.value?.loadFiles;
		return Boolean(
			raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length > 0
		);
	});

	/** config.json -> loadFiles（App.vue / LoadFile.vue 共用一个取值入口）。
	 *  过滤掉未真正配置的空条目（模板里 loadFiles.<key> 子字段全为空值的情况），
	 *  判定不依赖具体字段名（见 lib.isLoadFileEntryConfigured），
	 *  避免加载页列表展示出无法加载的条目、或加载时报「未配置 fileSrc」卡住。
	 *  注意：Object.fromEntries 只新建外层容器，条目对象仍是 config 里的同一引用，
	 *  所以 LoadFile.vue 回写 fileObj.fileSrc 仍能生效到原始 config。 */
	const loadFiles = computed<Record<string, any>>(() => {
		const raw = config.value?.loadFiles;
		if (!raw || typeof raw !== 'object') return {};
		return Object.fromEntries(
			Object.entries(raw).filter(([, entry]) => isLoadFileEntryConfigured(entry))
		);
	});

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
			//处理functionTextList，这是允许自建的方法库
			if (Array.isArray(data?.functionTextList)) {
				data.functionTextList.forEach((li: IFunctionTextListObj) => {
					// 外层括号让 eval 把 "function (...)" 按函数表达式处理（直接 eval 会被当声明，返回 undefined）
					fileData.value[fileKey][li.name] = eval(`(${li.function})`);
				});
			}
			//处理输入模板索引
			if (isObject(data?.inputGroupMap)) {
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
	/** 写回某个 dataKey 条目的 fileSrc。
	 *  ??= 兜底：loadFiles 容器或条目缺失时自动创建，已存在则就地修改（保留 readScript 等字段）；
	 *  空值直接返回，避免凭空多出一个空条目把 hasLoadFiles 顶成 true。 */
	function setFileSrc(fileKey: string, fileSrc: string): void {
		if (!fileSrc) return;
		const loadFiles = (config.value.loadFiles ??= {});
		(loadFiles[fileKey] ??= {}).fileSrc = fileSrc;
	}

	return {
		config,
		baseSrc,
		menu,
		hasLoadFiles,
		loadFiles,
		load,
		setBaseSrc,
		fileData,
		filePaths,
		dataVersion,
		setFileData,
		setFilePath,
		setFileSrc
	};
});
