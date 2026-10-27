'use strict';
/*
 * skillOption.js — 舰船被动技能下拉选项
 * ---------------------------------------------------------------
 * 由 custom/config.json 的 category[].loadScript 引用：
 *   "loadScript": { "dataKey": "base", "loadSrc": "custom/skillOption.js" }
 *
 * 脚本在主进程执行（不是渲染进程），返回值里：
 *   skillList    —— 选项数组，给 optionKey: "skillList" 的字段用
 *   skillFilter  —— 过滤函数，给 optionFilterFn: "skillFilter" 的字段用。
 *                   在主进程内部执行，只有过滤后的结果回传给界面，
 *                   （函数本身不能跨 IPC 传递，所以不能写进返回值再拿去渲染层调用）
 *
 * 入参 ctx:
 *   ctx.dataKey   —— config.json 配的 dataKey
 *   ctx.data      —— store.fileData[dataKey]，即 es2_loadout.js 解析出的整份存档数据
 *   ctx.itemName  —— 当前字段的 name（如 "skill1"），可按字段做差异化过滤
 *   ctx.customDir / downloadsPath / documentsPath —— 目录，方便读同目录的静态数据
 *
 * 返回值格式（两种都支持）：
 *   [{ label: '显示名', value: '存档里的值' }, ...]
 *   或直接给字符串数组 ['a', 'b']（会被自动补成 {label,value}）
 */

/**
 * 被动技能清单。
 * TODO: 这里目前是空的 —— es2_loadout.js 只解析了装备，还没解析舰船被动技能槽，
 *       所以存档里拿不到真实列表。请按下面的格式补数据，或者改成从
 *       ctx.customDir 下的静态数据表里读。
 */
const SKILL_DEFS = [
	// 示例（取消注释即可用）：
	// { id: 'perk_armor', label: '装甲强化' },
	// { id: 'perk_shield', label: '护盾强化' }
];

module.exports = function (ctx) {
	// 当前飞船模板（如 ship_light_rogue），过滤时会用到
	const shipTemplateId = ctx?.data?.currentShip?.templateId || '';

	return {
		skillList: SKILL_DEFS.map((it) => ({ label: it.label, value: it.id })),

		/**
		 * 过滤：只保留「当前飞船适合」的被动技能。
		 * @param {Array} list  —— 上面的 skillList
		 * @param {object} c    —— 同一个 ctx
		 * @returns {Array} 过滤后的选项
		 */
		skillFilter: function (list, c) {
			// TODO: 拿到真实的「飞船 ↔ 被动技能」对应关系后在这里过滤。
			// 当前没有任何依据可以判断适配关系，先原样返回，避免瞎猜。
			void shipTemplateId;
			void c;
			return list;
		}
	};
};
