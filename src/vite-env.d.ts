/// <reference types="vite/client" />

// custom/config.json 的结构（单一来源：主进程读取、store 与组件共用此类型）
// 注意：本文件不能出现 import/export，否则下面这些 interface 会失去「全局」语义。

/** 表单里的一个字段项，如 { "label": "等级", "name": "...", "type": "number" } */
interface AppMenuFormField {
	label: string;
	/**
	 * 数据路径（相对 store.fileData[dataKey]），支持嵌套写法：
	 *   "currentShip.primaryWeapons[0].attributes[1].id"
	 * 也兼容扁平 key："skill1"
	 */
	name?: string;
	type?: 'number' | 'select' | 'text' | string;
	/** type=number 时生效 */
	min?: number;
	max?: number;
	step?: number;
	precision?: number;
	disabled?: boolean;
	placeholder?: string;
	/** 静态选项：[{label,value}]，也允许直接给字符串数组 */
	options?: any[];
	/** 动态选项（交给 custom 下的脚本算）：取脚本返回对象的该字段 */
	optionKey?: string;
	/** 动态选项过滤函数：取脚本返回对象里同名的函数，在主进程执行 */
	optionFilterFn?: string;
}

/** 一个表单块，如 { "label": "主武器1", "items": [...] } */
interface AppMenuFormItem {
	label: string;
	tip?: string;
	items?: AppMenuFormField[];
	/** 为本块的下拉框动态取选项的脚本 */
	loadScript?: {
		dataKey?: string;
		loadSrc: string;
	};
}

/** config.json -> menu 的一个节点（可递归嵌套 children） */
interface AppMenuItem {
	label: string;
	tip?: string;
	children?: AppMenuItem[];
	category?: AppMenuFormItem[];
	dataKey: string;
	// 由 store 补齐后回填：antd Menu 需要唯一 key，此处用 label 充当
	key?: string;
}

/** config.json -> background */
interface AppBackground {
	src?: string;
	base64?: string;
	blur?: number;
}

interface AppConfig {
	name: string;
	width: number;
	height: number;
	loadFiles: Record<string>;
	menu: AppMenuItem[];
	background?: AppBackground;
	i18n?: Record<string, unknown>;
	// config.json 可自行扩展字段，都会原样带过来
	[key: string]: unknown;
}

interface Window {
	// preload 通过 contextBridge 暴露的自定义 API
	api: {
		ping: () => Promise<string>;
		getConfig: () => Promise<AppConfig>;
		getPaths: () => Promise<{ downloads: string; documents: string }>;
		readFile: (fileSrc: string, readScriptSrc: string) => Promise<any>;
		runScript: (payload: {
			scriptSrc: string;
			dataKey?: string;
			data?: any;
			itemName?: string;
			optionKey?: string;
			optionFilterFn?: string;
		}) => Promise<any[]>;
	};
}
