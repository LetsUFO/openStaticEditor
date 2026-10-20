/**
 * Tailwind v4 配置文件
 *
 * 颜色「单一来源」= src/style/theme.ts 的 light 变量（其本身直接 import 自 antd 的 seed token）。
 * 不在此处写死任何 hex：所有字段都从 theme.ts 的 light 注入。
 * 无需在 style.scss 里写 @theme —— 本文件由 style.scss 的 `@config` 指向后被读取。
 */
import { light, size } from './src/style/theme';

// size 只定义「尺寸值」，键名去掉 radius- 前缀即 Tailwind 原生档位：
//   'radius-md' -> 'md' -> 覆盖原生 rounded-md 的值（原生 class 名不变）
// 页面照常写原生 class（rounded-md / rounded-lg），不引入 rounded-m 这类自定义名，
// 也避免撞 Tailwind 内置方向性圆角（rounded-l = 左侧圆角）。
const borderRadius = Object.fromEntries(Object.entries(size).map(([key, value]) => [key.replace(/^radius-/, ''), value]));

/** @type {import('tailwindcss').Config} */
export default {
	theme: {
		extend: {
			// 整体展开，light 新增字段时无需再改本文件
			colors: { ...light },
			borderRadius
		}
	}
};
