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
 *                              src/style.css  ──▶  text-primary / bg-success ...
 * style.css 里只放一行 `@config` 指针，不含任何颜色值。
 */
import seedToken from 'ant-design-vue/es/theme/themes/seed.js'

export const light = {
	primary: `var(--ant-primary-color, ${seedToken.colorPrimary})`,
	success: `var(--ant-success-color, ${seedToken.colorSuccess})`,
	error: `var(--ant-error-color, ${seedToken.colorError})`,
	warning: `var(--ant-warning-color, ${seedToken.colorWarning})`,
	info: `var(--ant-info-color, ${seedToken.colorInfo})`
}

export default light
