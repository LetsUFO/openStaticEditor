/**
 * 全站颜色「单一来源」（Single Source of Truth）
 *
 * 颜色直接 import 自 antd 默认 design token（不再手写 hex）：
 *   node_modules/ant-design-vue/es/theme/themes/seed.js
 *   （ant-design-vue 4.2.6 默认 seed token）
 * antd 升级、改默认色时这里自动跟随，无需手动同步。
 *
 * 注入链路（不写死任何颜色）：
 *   theme.ts(light)  ──import──▶  tailwind.config.js(colors)
 *                                     │ @config
 *                                     ▼
 *                              src/style.scss  ──▶  text-primary / bg-success ...
 * style.scss 里只放一行 `@config` 指针，不含任何颜色值。
 */
import seedToken from 'ant-design-vue/es/theme/themes/seed.js';

// 只定义「尺寸值」，键名对齐 Tailwind 原生档位（去掉 radius- 前缀即原生 class 后缀）。
// 页面照常写原生 class：rounded-md / rounded-lg，其值由这里决定。
interface IThemeSize {
	spaceBase?: string;
	'radius-md': string;
	'radius-lg': string;
	fsLv1: string;
	fsLv2: string;
	fsLv3: string;
}
export const size: IThemeSize = {
	// spaceBase: '0.5rem',
	'radius-md': '0.5rem',
	'radius-lg': '1rem',
	fsLv1: '0.75rem',
	fsLv2: '1rem',
	fsLv3: '1.5rem'
};

export const light = {
	primary: `var(--ant-primary-color, ${seedToken.colorPrimary})`,
	success: `var(--ant-success-color, ${seedToken.colorSuccess})`,
	error: `var(--ant-error-color, ${seedToken.colorError})`,
	warning: `var(--ant-warning-color, ${seedToken.colorWarning})`,
	info: `var(--ant-info-color, ${seedToken.colorInfo})`,

	fcLv1: '#999999',
	fcLv2: '#333333',
	fcLv3: '#111111'
};
export const dark = {
	fcLv1: '#333333',
	fcLv2: '#999999',
	fcLv3: '#eeeeee'
};

export default light;
