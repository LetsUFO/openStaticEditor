/// <reference types="vite/client" />

// custom/config.json 的结构（单一来源：主进程读取、store 与组件共用此类型）
// 注意：本文件不能出现 import/export，否则下面这些 interface 会失去「全局」语义。

/** 表单里的一个字段项，如 { "name": "等级", "type": "number" } */
interface AppMenuFormField {
	name: string;
	type?: string;
}

/** 一个表单块，如 { "name": "主武器1", "items": [...] } */
interface AppMenuFormItem {
	name: string;
	tip?: string;
	items?: AppMenuFormField[];
}

/** config.json -> menu 的一个节点（可递归嵌套 children） */
interface AppMenuItem {
	label: string;
	tip?: string;
	children?: AppMenuItem[];
	form?: AppMenuFormItem[];
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
	loadFiles: Record<string, unknown>;
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
	};
}
