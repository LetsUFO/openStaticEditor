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
	type?: 'number' | 'select' | 'text' | 'enumText' | string;
	/** type=enumText 时生效：store.fileData[dataKey] 下的映射表名（如 "enemyIdMap"），
	 *  用 name 路径取出的原始值（ID）去查 label 显示 */
	useEnumMap?: string;
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
	/** 选项前的标记（如「已测」）：选项数据里 key 对应值为 truthy 时展示 */
	optionBeforeTag?: {
		key: string;
		text?: string;
		colorClass?: string;
	};
	/** 选项过滤函数名（最高优先级）：store 里注入的同名函数，签名 (formData, optionUseData) => options */
	optionFilterFn?: string;
}

/** 一个表单块，如 { "label": "主武器1", "items": [...] } */
interface AppMenuFormItem {
	label: string;
	tip?: string;
	/** 该块内每个字段所占的网格分母，默认 3（即一行 3 列）；最终 class 为 w-1/col */
	col?: number;
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
	/** 背景图模糊半径（px） */
	blur?: number;
	/** 背景图透明度（0~1） */
	alpha?: number;
}

/** config.json -> ads 的一项：图片推广位（淘宝联盟 CPS 等） */
interface AppAd {
	/** 图片路径：相对 custom 子目录时主进程会自动补前缀；也支持 http(s) / data: / blob: */
	src: string;
	/** 点击后打开的外部链接：仅 https，且限淘宝/天猫域名（白名单见主进程 shell:openExternal） */
	link: string;
	/** 图片替代文本，同时作为 hover 提示 */
	alt?: string;
}

/** config.json -> sponsor：赞助入口（爱发电等） */
interface AppSponsor {
	/** 二维码图片路径（可选）：相对 custom 子目录时主进程会自动补前缀；也支持 http(s) / data: / blob: */
	src?: string;
	/** 赞助主页链接：仅 https，域名白名单见主进程 shell:openExternal */
	link: string;
	/** 入口文案，默认「赞助支持」 */
	text?: string;
}

interface AppConfig {
	name: string;
	/** 应用图标路径，主进程用于设置窗口图标 */
	appIcon?: string;
	/** 配置版本号：config.json 里写纯 semver（0.1.3），经主进程读取后统一带 "v"（v0.1.3） */
	ver: string;
	width: number;
	height: number;
	loadFiles: Record<string>;
	menu: AppMenuItem[];
	background?: AppBackground;
	/** 侧栏底部图片推广位，按顺序纵向排列；不配置则不渲染 */
	ads?: AppAd[];
	/** 侧栏底部赞助入口（配了 src 则点击放大二维码）；不配置则不渲染 */
	sponsor?: AppSponsor;
	i18n?: Record<string, unknown>;
	// config.json 可自行扩展字段，都会原样带过来
	[key: string]: unknown;
}

interface Window {
	// preload 通过 contextBridge 暴露的自定义 API（类型单一来源：src/lib/lib.ts -> Api）
	api: import('./lib/lib').Api;
}
