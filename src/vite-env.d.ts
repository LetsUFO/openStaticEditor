/// <reference types="vite/client" />

// custom/config.json 的结构（单一来源：主进程读取、store 与组件共用此类型）
// 注意：本文件不能出现 import/export，否则下面这些 interface 会失去「全局」语义。

/** 表单里的一个字段项，如 { "label": "等级", "name": "...", "type": "number" } */
interface AppMenuFormField {
	label: string;
	/**
	 * 数据路径（相对 store.fileData[dataKey]），支持嵌套写法：
	 *   "currentShip.primaryWeapons[0].attributes[1].id"
	 *   "currentShip.skills[0]"（数组下标写法同样由 _.get / _.set 处理）
	 * 也兼容扁平 key："skillFilter"
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
	/** 动态选项数据：store.fileData[dataKey] 下该路径的值（如 "skillMap"）。
	 * 配了 optionFilterFn 时作为其第二参数传入；否则直接作为选项使用 */
	optionUse?: string;
	/** 选项过滤函数名（最高优先级）：store 里注入的同名函数，签名 (formData, optionUseData) => options */
	optionFilterFn?: string;
}

/** 一个表单块，如 { "label": "主武器1", "items": [...] } */
interface AppMenuFormItem {
	label: string;
	tip?: string;
	/** 块级启停：指向数据路径（如 "currentShip.primaryWeapons[0].level"），
	 *  该路径值 truthy 时块启用，falsy 时块置灰且不可交互；不填则始终启用 */
	enableKey?: string;
	items?: AppMenuFormField[];
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
	// 该分类的保存配置（保存按钮点击时使用）
	saveScript?: {
		needFileKey: string;
		saveScript: string;
	};
}

/** config.json -> background */
interface AppBackground {
	src?: string;
	base64?: string;
	blur?: number;
}

interface AppConfig {
	name: string;
	/** 应用图标路径，主进程用于设置窗口图标 */
	appIcon?: string;
	/** 配置版本号 */
	ver: string;
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
	// preload 通过 contextBridge 暴露的自定义 API（类型单一来源：src/lib/lib.ts -> Api）
	api: import('./lib/lib').Api;
}
