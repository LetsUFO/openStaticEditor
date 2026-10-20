/**
 * Tailwind v4 配置文件
 *
 * 「单一来源」= src/style/theme.ts：
 *   light（颜色，本身 import 自 antd 的 seed token）
 *   size（尺寸：间距基准 / 圆角 / 字号）
 * 不在此处写死任何值，全部从 theme.ts 注入。
 * 无需在 style.scss 里写 @theme —— 本文件由 style.scss 的 `@config` 指向后被读取。
 */
import { light, size } from './src/style/theme';

/**
 * size → Tailwind theme 的映射规则表（可扩展）
 *
 * 以后新增属性映射，只需在这里加一条规则，不要在别处写分支：
 *   themeKey : Tailwind 的 theme 分组（spacing / borderRadius / fontSize / ...）
 *   match    : 命中哪些 size 键（(key) => boolean）
 *   key      : 可选，键名转换（默认原样；返回的值即 Tailwind 的档位名）
 *   value    : 可选，值转换（默认原样）
 *
 * 未命中任何规则的 size 键会被忽略，不会污染其它分组。
 */
const SIZE_MAPPINGS = [
	{
		// spaceBase（间距基准）→ Tailwind 的 spacing 基准
		// v4 把 spacing.DEFAULT 当作乘法基准：p-1 = base×1、p-4 = base×4、m-4 = base×4
		// 所以改这一个值，padding / margin / gap / w / h / space-x 等全部按新基准缩放。
		// ⚠️ 必须写成对象形式（{ DEFAULT }）：标量 spacing: '8px' 会让 v4 抛 TypeError。
		// 值支持两种写法：数字（按 px 处理，8 -> 8px）或已带单位的字符串（'0.5rem' 原样使用）。
		themeKey: 'spacing',
		match: (key) => key === 'spaceBase',
		key: () => 'DEFAULT',
		value: (value) => (typeof value === 'number' ? `${value}px` : value)
	},
	{
		// radius-md / radius-lg → borderRadius.md / .lg
		// 去掉 radius- 前缀后即 Tailwind 原生档位：页面照常写 rounded-md / rounded-lg。
		themeKey: 'borderRadius',
		match: (key) => key.startsWith('radius-'),
		key: (key) => key.replace(/^radius-/, '')
	}
	// 例：把 fsLv1/2/3 映射为 fontSize（键名按需要转换），加这一条即可：
	// {
	// 	themeKey: 'fontSize',
	// 	match: (key) => key.startsWith('fsLv'),
	// 	key: (key) => key.replace(/^fs/, '').toLowerCase() // fsLv1 -> lv1 -> text-lv1
	// }
];

/** 按映射表把 size 转成 Tailwind 的 theme 分片 */
function buildThemeFromSize(sizeMap, mappings) {
	const theme = {};

	for (const [key, value] of Object.entries(sizeMap)) {
		const rule = mappings.find((item) => item.match(key));
		if (!rule) continue; // 未映射的属性直接忽略，避免串到别的分组

		const group = (theme[rule.themeKey] ??= {});
		group[rule.key ? rule.key(key) : key] = rule.value ? rule.value(value) : value;
	}

	return theme;
}

/** @type {import('tailwindcss').Config} */
export default {
	theme: {
		extend: {
			// 整体展开，light 新增字段时无需再改本文件
			colors: { ...light },
			...buildThemeFromSize(size, SIZE_MAPPINGS)
		}
	}
};
