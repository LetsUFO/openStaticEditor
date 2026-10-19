/**
 * Tailwind v4 配置文件
 *
 * 颜色「单一来源」= src/style/theme.ts 的 light 变量（其本身直接 import 自 antd 的 seed token）。
 * 不在此处写死任何 hex：所有字段都从 theme.ts 的 light 注入。
 * 无需在 style.scss 里写 @theme —— 本文件由 style.scss 的 `@config` 指向后被读取。
 */
import { light } from './src/style/theme';

/** @type {import('tailwindcss').Config} */
export default {
	theme: {
		extend: {
			colors: {
				primary: light.primary,
				success: light.success,
				warning: light.warning,
				error: light.error,
				info: light.info
			}
		}
	}
};
