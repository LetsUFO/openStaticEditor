#!/usr/bin/env node
/*
 * es2_loadout.js — EVERSPACE 2 存档读取
 * ---------------------------------------------------------------
 * 纯 Node（仅用内置 zlib / fs，无需 npm 安装），读取 ES2 的 GVAS 存档，
 * 提取【当前驾驶飞船】的装备附加属性。
 *
 * 输出口径（按需求精简）:
 *   - 主武器 / 副武器 / 模块: 每件输出
 *       templateId      (物品模板，用于辨识是哪件装备)
 *       level           (ItemLevel，原始等级)
 *       effectiveLevel  (ItemLevel + VirtualLevelOffset，游戏界面显示等级)
 *       attributes      (附加属性/占槽词缀: 属性ID + 0~1 归一化位置)
 *     —— attributes 只保留「附加词缀」: 采用负向剔除（去掉各品类固有核心属性 +
 *        隐藏/元数据标记），其余全部视为附加词缀，故能覆盖传说特效、导弹专属词缀、
 *        okkar 催化剂增益、all_modules_* 等全部真实属性（手动注入的可超过 4 条）。
 *   - 模块(modules): 每种模块只能装备一件，故直接输出单件对象（未装备为 null），
 *     不使用数组；主/副武器仍为数组（可装备多把）。
 *   - 携带货物(cargo): 固定输出空数组 []。
 *   - 传奇(Legendary)装备: 主武器/副武器/模块/装置所有传奇稀有度装备的附加属性暂不抽取
 *     （能否更换尚不确定），attributes 置空数组；templateId / level / effectiveLevel 仍照常输出。
 *
 * 用法（模块导出，由主进程 file:read 调用）:
 *   module.exports = function (ctx) {
 *     // ctx.fileSrc       —— config.json 里配置的原始文件路径
 *     // ctx.filePath      —— 主进程解析后的路径（相对路径按 custom 目录拼接）
 *     // ctx.customDir     —— custom 目录绝对路径
 *     // ctx.downloadsPath —— 系统下载目录绝对路径
 *     // ctx.documentsPath —— 系统文档目录绝对路径
 *     // return 解析后的数据对象
 *   }
 *
 * 注意: 存档里只存 ValuePositionInRange（0~1 归一化位置），真实数值由游戏
 *       运行时按品质/等级计算，此处不还原真实数值。
 */

'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const FIXED = new Set([
	'Int8Property',
	'Int16Property',
	'IntProperty',
	'Int64Property',
	'UInt16Property',
	'UInt32Property',
	'UInt64Property',
	'FloatProperty',
	'DoubleProperty'
]);
const STR_TYPES = new Set([
	'StrProperty',
	'NameProperty',
	'ObjectProperty',
	'InterfaceProperty',
	'EnumProperty',
	'ByteProperty',
	'FieldPathProperty',
	'ClassProperty',
	'DelegateProperty',
	'MulticastInlineDelegateProperty'
]);
const SOFT_TYPES = new Set(['SoftObjectProperty', 'SoftClassProperty']);
const RAW_STRUCTS = new Set([
	'Guid',
	'DateTime',
	'Timespan',
	'Vector',
	'Rotator',
	'Quat',
	'LinearColor',
	'Color',
	'IntPoint',
	'Vector2D',
	'Vector4',
	'Transform',
	'FrameNumber',
	'SmartName',
	'MovieSceneSegmentIdentifier',
	'MovieSceneSequenceID',
	'MovieSceneTrackIdentifier',
	'MovieSceneEvaluationKey',
	'MovieSceneFloatChannel',
	'Vector_NetQuantize',
	'ESVariant',
	'FSVariant'
]);

// ---------------------------------------------------------------- 附加属性判定
// AttributeStates 里混了三类：核心属性(模板固有,不占槽) + 隐藏标记 + 附加词缀(占槽)。
// 之前的「正向白名单」只收录了少数已知词缀，会漏掉大量真实附加属性（传说特效、
// 导弹专属词缀、okkar 催化剂增益、模块 all_modules_* 等）。
//
// 改用【负向剔除】：只剔除「各品类固有核心属性」+「隐藏/元数据标记」，其余一律视为
// 占槽附加属性。这样能覆盖所有真实词缀（含手动用存档工具注入的额外词缀）。
//
// 注意：手动用存档工具给装备追加词缀时，单件可能超过 4 条；Ascendant 本体 5 槽。
//       本脚本如实输出剔除核心/隐藏后的全部属性，不再硬性限制条数。

// 隐藏 / 元数据标记：永不占槽、UI 不显示，直接剔除
const HIDDEN_ATTR = new Set([
	'no_random_drop',
	'content_group',
	'min_level',
	'blueprintable',
	'system_drop',
	'item_price',
	'ascendant_rank',
	'level_dependence',
	'no_damage',
	'full_auto',
	'item_stack_amount' // 消耗品/货物固有堆叠数
]);

// 各品类「固有核心属性」：模板自带基础数值，不占附加槽，需剔除。
// 采用「前缀/精确名」规则，而非枚举全部词缀，以最大化覆盖真实附加属性。
function isCoreAttr(id) {
	if (!id) return true;
	// 武器基础属性族（weapon_* 但以 _buff 结尾的是附加增益，保留）
	if (/^weapon_/.test(id) && !/_buff$/.test(id)) return true;
	// 副武器基础属性族
	if (/^secondary_/.test(id)) return true;
	// 装置(Device)基础属性族：device_* 全为固有
	if (/^device_/.test(id)) return true;
	// 传感器固有探测范围族
	if (/^sensor_range_/.test(id)) return true;
	// 能量核心固有回充族
	if (/^energy_core_regen_/.test(id)) return true;
	// 消耗品固有持续时间 / 效果类型
	if (/^consumable_/.test(id)) return true;
	// 护盾基础属性（注意：shield_piercing 等是附加，不能一刀切排除 shield_）
	if (
		[
			'shield_capacity',
			'shield_recharge_speed',
			'shield_recharge_delay',
			'shield_shutdown_duration',
			'shield_absorption',
			'shield_bleed_through',
			'shield_damage_reduction',
			'shield_hardness'
		].includes(id)
	)
		return true;
	// 推进器(thruster/booster)基础属性：boost_* 固有基础数值，不占附加槽
	// （注意：boost_after_kill 等是附加词缀，用精确名单而非前缀以避免误删）
	if (
		[
			'boost_speed',
			'boost_acceleration',
			'boost_recharge_speed',
			'boost_energy_capacity',
			'boost_energy_consumption',
			'boost_recharge_delay',
			'boost_charge',
			'boost_regeneration',
			'boost_duration'
		].includes(id)
	)
		return true;
	// 货舱单元固有槽位数
	if (id === 'cargo_slots_buff') return true;
	// 装甲板基础护甲值（armor 裸词；armor_piercing / armor_per_kill 是附加）
	if (id === 'armor') return true;
	// 追踪导弹发射器固有「不可拦截」
	if (id === 'no_interception') return true;
	// 团结(togetherwestand) cargo unit 固有许愿效果
	if (id === 'xr_wish_effect') return true;
	return false;
}

// 附加属性 = 非隐藏 且 非核心
function isAffixAttr(id) {
	if (!id) return false;
	if (HIDDEN_ATTR.has(id)) return false;
	if (isCoreAttr(id)) return false;
	return true; // 其余一律保留（开放收录所有真实词缀）
}

// ---------------------------------------------------------------- 基础读
function readFString(buf, off) {
	let n = buf.readInt32LE(off);
	off += 4;
	if (n === 0) return { str: '', off };
	if (n > 0) {
		const raw = buf.subarray(off, off + n);
		off += n;
		let s = raw.toString('utf8');
		if (s.endsWith('\u0000')) s = s.slice(0, -1);
		return { str: s, off };
	}
	n = -n;
	const raw = buf.subarray(off, off + 2 * n);
	off += 2 * n;
	let s = raw.toString('utf16le').replace(/\u0000+$/, '');
	return { str: s, off };
}

function readFixed(buf, off, type) {
	switch (type) {
		case 'Int8Property':
			return buf.readInt8(off);
		case 'Int16Property':
			return buf.readInt16LE(off);
		case 'IntProperty':
			return buf.readInt32LE(off);
		case 'Int64Property':
			return Number(buf.readBigInt64LE(off));
		case 'UInt16Property':
			return buf.readUInt16LE(off);
		case 'UInt32Property':
			return buf.readUInt32LE(off);
		case 'UInt64Property':
			return Number(buf.readBigUInt64LE(off));
		case 'FloatProperty':
			return buf.readFloatLE(off);
		case 'DoubleProperty':
			return buf.readDoubleLE(off);
	}
	throw new Error('未知定长类型 ' + type);
}

function readTNode(buf, off, depth) {
	const r = readFString(buf, off);
	off = r.off;
	const name = r.str;
	let n = buf.readInt32LE(off);
	off += 4;
	if (!(n >= 0 && n <= 8) || depth > 8) throw new Error('类型树 nchild 异常 @' + (off - 4));
	const kids = [];
	for (let i = 0; i < n; i++) {
		const k = readTNode(buf, off, depth + 1);
		off = k.off;
		kids.push(k.node);
	}
	return { node: { name, children: kids }, off };
}

function readTypeTree(buf, off, tname) {
	let n = buf.readInt32LE(off);
	off += 4;
	if (!(n >= 0 && n <= 8)) throw new Error('类型树 nchild 异常 @' + (off - 4));
	const kids = [];
	for (let i = 0; i < n; i++) {
		const k = readTNode(buf, off, 0);
		off = k.off;
		kids.push(k.node);
	}
	return { node: { name: tname, children: kids }, off };
}

function flat(node) {
	let s = node.name;
	if (node.children && node.children.length) {
		s += '<' + node.children.map(flat).join(',') + '>';
	}
	return s;
}

function structNameOfT(t) {
	if (!t || !t.includes('<')) return t;
	return t.split('<', 1)[1].split('<', 1)[0].replace(/>+$/, '');
}

// ---------------------------------------------------------------- 解析
function parseGvas(data) {
	if (!(data[0] === 0x47 && data[1] === 0x56 && data[2] === 0x41 && data[3] === 0x53))
		throw new Error('不是 GVAS 文件');
	let off = 4;
	const saveVer = data.readInt32LE(off);
	off += 4;
	const pkgUe4 = data.readInt32LE(off);
	off += 4;
	const pkgUe5 = data.readInt32LE(off);
	off += 4;
	const major = data.readUInt16LE(off);
	off += 2;
	const minor = data.readUInt16LE(off);
	off += 2;
	const patch = data.readUInt16LE(off);
	off += 2;
	const build = data.readUInt32LE(off);
	off += 4;
	const br = readFString(data, off);
	const branch = br.str;
	off = br.off;
	const cvfmt = data.readInt32LE(off);
	off += 4;
	const n = data.readInt32LE(off);
	off += 4;
	off += 20 * n; // CustomVersions
	const cl = readFString(data, off);
	const cls = cl.str;
	off = cl.off;
	if (off < data.length && data[off] === 0x00) off += 1; // 类名后填充
	const header = data.subarray(0, off);
	const res = parseProps(data, off, data.length, true);
	const footer = data.subarray(res.off);
	return {
		header,
		props: res.props,
		footer,
		info: { saveVer, pkgUe4, pkgUe5, engine: [major, minor, patch, build], branch, cvfmt, cls }
	};
}

// 读一条裸值（数组/Map 元素），t 可能带尖括号
function readBareValue(buf, off, end, t) {
	const base = t ? t.split('<')[0] : '';
	if (FIXED.has(t)) return { value: readFixed(buf, off, t), off: off + typeSize(t) };
	if (FIXED.has(base)) return { value: readFixed(buf, off, base), off: off + typeSize(base) };
	if (STR_TYPES.has(t) || STR_TYPES.has(base)) {
		const r = readFString(buf, off);
		return { value: r.str, off: r.off };
	}
	if (base === 'BoolProperty') return { value: buf[off] !== 0, off: off + 1 };
	if (base === 'StructProperty') {
		const sn = structNameOfT(t);
		if (sn && sn.endsWith('BufferWrapper')) {
			const len = buf.readInt32LE(off);
			off += 4;
			return { value: '<buffer ' + len + ' bytes>', off: off + len };
		}
		const r = parseProps(buf, off, end);
		return { value: r.props, off: r.off };
	}
	if (base === 'ByteProperty' && !t.includes('<')) return { value: buf[off], off: off + 1 };
	throw new Error('无法读取裸值类型 ' + t);
}

function typeSize(t) {
	const map = {
		Int8Property: 1,
		Int16Property: 2,
		IntProperty: 4,
		Int64Property: 8,
		UInt16Property: 2,
		UInt32Property: 4,
		UInt64Property: 8,
		FloatProperty: 4,
		DoubleProperty: 8
	};
	return map[t] || 0;
}

function parseProps(buf, off, end, allowTail) {
	const props = [];
	while (off < end) {
		let p, noff;
		try {
			const r = parseOne(buf, off, end);
			p = r.prop;
			noff = r.off;
		} catch (e) {
			if (allowTail) break;
			throw e;
		}
		if (p === null) {
			off = noff;
			break;
		}
		props.push(p);
		off = noff;
	}
	return { props, off };
}

function parseOne(buf, off, end) {
	const start = off;
	const rn = readFString(buf, off);
	off = rn.off;
	const name = rn.str;
	if (name === 'None') return { prop: null, off };
	const rt = readFString(buf, off);
	off = rt.off;
	const tname = rt.str;
	const tt = readTypeTree(buf, off, tname);
	off = tt.off;
	const tnode = tt.node;
	const size = buf.readInt32LE(off);
	off += 4;
	if (!(size >= 0 && size <= buf.length))
		throw new Error(name + '(' + tname + '): Size=' + size + ' 不合理');
	const flag = buf[off];
	off += 1;
	let guid = null;
	if (flag === 1) {
		guid = buf.subarray(off, off + 16);
		off += 16;
	}
	const pstart = off;
	const pend = pstart + size;
	const prop = {
		name,
		type: tname,
		tnode,
		size,
		flag,
		guid,
		children: null,
		value: null,
		raw: buf.subarray(start, pend)
	};
	try {
		const o2 = parsePayload(buf, pstart, pend, prop);
		if (o2 !== pend) throw new Error('payload 消耗 ' + (o2 - pstart) + ' != Size ' + size);
	} catch (e) {
		prop.unparsed = true;
		prop.error = String(e.message || e);
		prop.payloadRaw = buf.subarray(pstart, pend);
	}
	return { prop, off: pend };
}

function parsePayload(buf, off, end, prop) {
	const t = prop.type;
	if (FIXED.has(t)) {
		prop.value = readFixed(buf, off, t);
		return off + typeSize(t);
	}
	if (SOFT_TYPES.has(t)) {
		const vals = [];
		while (off < end && vals.length < 4) {
			const r = readFString(buf, off);
			off = r.off;
			vals.push(r.str);
		}
		prop.value = vals.length === 1 ? vals[0] : vals;
		return off;
	}
	if (STR_TYPES.has(t)) {
		const r = readFString(buf, off);
		prop.value = r.str;
		return r.off;
	}
	if (t === 'BoolProperty') {
		prop.value = (prop.flag & 0x10) !== 0;
		return off + prop.size;
	}
	if (t === 'TextProperty') {
		prop.payloadRaw = buf.subarray(off, end);
		return end;
	}
	if (t === 'StructProperty') {
		const sn = prop.tnode && prop.tnode.children[0] ? prop.tnode.children[0].name : null;
		if (sn === null || RAW_STRUCTS.has(sn) || (sn && sn.endsWith('BufferWrapper'))) {
			prop.payloadRaw = buf.subarray(off, end);
			return end;
		}
		const r = parseProps(buf, off, end);
		prop.children = r.props;
		return r.off;
	}
	if (t === 'ArrayProperty' || t === 'SetProperty') {
		const cnt = buf.readInt32LE(off);
		off += 4;
		const itnode = prop.tnode.children[0];
		const it = itnode ? itnode.name : null;
		if (it === 'ByteProperty' && itnode && (!itnode.children || itnode.children.length === 0)) {
			prop.payloadRaw = buf.subarray(off - 4, end);
			prop.value = '<' + cnt + ' bytes>';
			return end;
		}
		if (
			it &&
			it.startsWith('StructProperty') &&
			structNameOfT(it) &&
			structNameOfT(it).endsWith('BufferWrapper')
		) {
			prop.payloadRaw = buf.subarray(off, end);
			return end;
		}
		const kids = [];
		for (let i = 0; i < cnt; i++) {
			if (it === 'StructProperty') {
				const r = parseProps(buf, off, end);
				off = r.off;
				kids.push({ type: 'StructProperty', name: '', children: r.props });
			} else {
				const r = readBareValue(buf, off, end, it);
				off = r.off;
				kids.push({ type: it, name: '', value: r.value });
			}
		}
		prop.children = kids;
		return off;
	}
	if (t === 'MapProperty') {
		const numRemoved = buf.readInt32LE(off);
		off += 4;
		const cnt = buf.readInt32LE(off);
		off += 4;
		prop.numRemoved = numRemoved;
		const keyT = prop.tnode.children[0] ? flat(prop.tnode.children[0]) : null;
		const valT = prop.tnode.children[1] ? flat(prop.tnode.children[1]) : null;
		const kids = [];
		for (let i = 0; i < cnt; i++) {
			const kr = readBareValue(buf, off, end, keyT);
			off = kr.off;
			const vr = readBareValue(buf, off, end, valT);
			off = vr.off;
			kids.push({
				name: String(kr.value),
				type: valT,
				value: vr.value,
				keyType: keyT,
				keyValue: kr.value
			});
		}
		prop.children = kids;
		return off;
	}
	throw new Error('未知类型 ' + t);
}

function loadSav(p) {
	const raw = fs.readFileSync(p);
	if (raw[0] === 0x47 && raw[1] === 0x56 && raw[2] === 0x41 && raw[3] === 0x53) {
		return { data: raw, meta: { raw: true } };
	}
	if (!(raw[0] === 0xde && raw[1] === 0xc0 && raw[2] === 0xde && raw[3] === 0x00))
		throw new Error(p + ': 不是 ES2 存档 (magic=' + raw.subarray(0, 4).toString('hex') + ')');
	const ver = raw.readUInt32LE(4);
	const usize = raw.readUInt32LE(8);
	const csize = raw.readUInt32LE(12);
	const body = zlib.inflateSync(raw.subarray(16));
	return { data: body, meta: { ver, usize, csize, raw: false } };
}

// ---------------------------------------------------------------- 导航
function getChild(node, name) {
	const arr = Array.isArray(node) ? node : node && node.children ? node.children : null;
	if (!arr) return null;
	for (const c of arr) if (c.name === name) return c;
	return null;
}
function childVal(node, name) {
	const c = getChild(node, name);
	return c ? c.value : null;
}

// 提取单件装备: templateId + 等级 + 附加属性(占槽词缀，已剔除核心属性与隐藏标记)
// 等级说明: level = ItemLevel(原始等级)；effectiveLevel = ItemLevel + VirtualLevelOffset
//           (虚拟等级偏移，如 Ascension 加成)，即游戏界面上显示的等级。
// opts.skipLegendaryAffix: 传奇(Legendary)装备暂不抽取附加属性（能否更换尚不确定）。
function extractItem(el, opts) {
	if (!el || !el.children) return null;
	const tpl = childVal(el, 'ItemTemplateID');
	if (!tpl || tpl === 'None' || tpl === '') return null;
	const level = childVal(el, 'ItemLevel');
	const vlo = childVal(el, 'VirtualLevelOffset') || 0;
	const rarity = childVal(el, 'Rarity') || '';
	const isLegendary = /(?:EItemRarity::)?Legendary/i.test(rarity);
	const skipAffix = !!(opts && opts.skipLegendaryAffix) && isLegendary;
	const attrsEl = getChild(el, 'AttributeStates');
	const attributes = [];
	if (!skipAffix && attrsEl && attrsEl.children) {
		for (const a of attrsEl.children) {
			const id = childVal(a, 'AttributeTemplateID');
			const pos = childVal(a, 'ValuePositionInRange');
			if (id && isAffixAttr(id)) attributes.push({ id, position: pos });
		}
	}
	return {
		templateId: tpl,
		level: level,
		// 规整到 2 位小数：VirtualLevelOffset 以 float 存储，直接相加会产生
		// 如 60 + 3.8 = 63.799999952316284 的浮点噪声
		effectiveLevel: level == null ? null : Math.round((level + vlo) * 100) / 100,
		// 传奇武器: attributes 置空（附加属性暂不抽取，能否更换待确认）
		attributes
	};
}

function extractCategory(inv, catName) {
	const cat = getChild(inv, catName);
	if (!cat || !cat.children) return [];
	// 所有类别(主/副武器、各模块、装置)的传奇(Legendary)装备均暂不抽取附加属性
	// （能否更换尚不确定），attributes 置空；其余装备照常抽取。
	const skipLegendaryAffix = true;
	const out = [];
	for (const el of cat.children) {
		const it = extractItem(el, { skipLegendaryAffix });
		if (it) out.push(it);
	}
	return out;
}

// 提取当前飞船的被动技能：从 ShipItemState.AttributeStates 读取全部属性 ID，
// 仅保留与 skillMap 任一组 value 能对得上的（即真正的被动技能 code），
// 剔除 11 条船体核心属性(shield_capacity_buff / hull_hitpoints / cruise_speed 等，
// 它们不在 skillMap 中)。返回 string[]（每个值是技能 code，与 skillMap.value 对应）。
function extractShipSkills(sisNode, skillValueSet) {
	const out = [];
	if (!sisNode) return out;
	const attrsEl = getChild(sisNode, 'AttributeStates');
	if (!attrsEl || !attrsEl.children) return out;
	for (const a of attrsEl.children) {
		const id = childVal(a, 'AttributeTemplateID');
		if (id && skillValueSet.has(id)) out.push(id);
	}
	return out;
}

const MODULE_CATS = ['EnergyCores', 'Sensors', 'Shields', 'CargoUnits', 'Platings', 'thrusters'];

// ---------------------------------------------------------------- 舰种(ship class)
// 存档里只有 ItemTemplateID(如 ship_light_rogue)，没有独立的"舰种"字段。
// 舰种 = 游戏内 Ship Class（Rogue/Gunship/Bomber/Sentinel…），与 heavy/medium/light 尺寸前缀无关。
// 已知模板硬编码映射；未知模板走 fallback(去 ship_ 前缀 + 尺寸词后首字母大写)。
const SHIP_CLASS_MAP = {
	ship_light_rogue: 'Rogue',
	ship_rogue: 'Rogue',
	ship_stinger: 'Stinger',
	ship_vindicator: 'Vindicator',
	ship_vanguard: 'Vanguard',
	ship_interceptor: 'Interceptor',
	ship_sentinel: 'Sentinel',
	ship_scout: 'Scout',
	ship_striker: 'Striker',
	ship_gunship: 'Gunship',
	ship_heavy_bomber: 'Bomber',
	ship_bomber: 'Bomber',
	ship_dreadnought: 'Dreadnought',
	ship_okkar_fighter: 'Okkar',
	ship_okkar_gunship: 'Okkar',
	ship_okkar_prime: 'Okkar',
	ship_okkar_medium_ship1: 'Okkar'
};
const SHIP_SIZE_WORDS = ['light', 'heavy', 'medium'];
function shipTypeOf(tpl) {
	if (!tpl || tpl === 'None' || tpl === '') return null;
	if (SHIP_CLASS_MAP[tpl]) return SHIP_CLASS_MAP[tpl];
	// fallback: ship_<size?>_<class> -> "Class"
	let s = tpl.startsWith('ship_') ? tpl.slice(5) : tpl;
	const parts = s.split('_').filter((p) => !SHIP_SIZE_WORDS.includes(p));
	return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

// ---------------------------------------------------------------- 附加属性表
// 属性表由同目录 attributeMap.json 维护，按装备槽位分组供下拉框取选项。
// 用 readFileSync 而非 require：Node 会缓存 JSON 模块，改表后不重启不生效。
function loadAttributeMap() {
	try {
		return JSON.parse(fs.readFileSync(path.join(__dirname, 'attributeMap.json'), 'utf8'));
	} catch (e) {
		console.warn('[es2_loadout] 读取 attributeMap.json 失败：' + e.message);
		return {};
	}
}

// ---------------------------------------------------------------- 主流程（模块导出）
module.exports = function (ctx) {
	const savePath = ctx.filePath;
	if (!savePath) throw new Error('未指定存档文件路径 (ctx.filePath)');

	const { data } = loadSav(savePath);
	const g = parseGvas(data);
	const top = {};
	for (const p of g.props) top[p.name] = p;
	if (!top.ShipsSaveState) throw new Error('存档缺少 ShipsSaveState');
	const ships = top.ShipsSaveState.children || [];

	// 选当前船：第一艘有模板的船，否则 0
	let idx = 0;
	for (let i = 0; i < ships.length; i++) {
		const sis = getChild(ships[i], 'ShipItemState');
		const tpl = sis ? childVal(sis, 'ItemTemplateID') : null;
		if (tpl && tpl !== 'None' && tpl !== '') {
			idx = i;
			break;
		}
	}
	const ship = ships[idx];
	const sis = getChild(ship, 'ShipItemState');
	const inv = getChild(ship, 'Inventory');
	const shipTpl = childVal(sis, 'ItemTemplateID') || 'None';

	// 飞船概览（仅标识，不输出基础属性）
	const shipSummary = [];
	for (let i = 0; i < ships.length; i++) {
		const s = getChild(ships[i], 'ShipItemState');
		const t = s ? childVal(s, 'ItemTemplateID') : null;
		shipSummary.push({
			index: i,
			templateId: t || 'None',
			shipType: shipTypeOf(t || 'None'),
			isCurrent: i === idx
		});
	}

	// 每种模块只能装备一件 -> 直接输出单件对象；该槽位未装备则为 null（不再用数组）
	const modules = {};
	for (const c of MODULE_CATS) {
		const arr = extractCategory(inv, c);
		modules[c] = arr.length ? arr[0] : null;
	}

	const result = {
		meta: {
			saveFile: path.basename(savePath),
			generatedAt: new Date().toISOString(),
			note: '每件装备输出 templateId + level(ItemLevel) + effectiveLevel(ItemLevel+VirtualLevelOffset，界面显示等级) + attributes。attributes 采用负向剔除：去掉各品类固有核心属性(weapon_*/secondary_*/device_*/sensor_range_*/energy_core_regen_*/shield 基础值/cargo_slots_buff/armor 等)与隐藏标记(no_random_drop/min_level/blueprintable/item_price/ascendant_rank 等)，其余全部视为占槽附加词缀，覆盖传说特效(legendary_*)、导弹专属词缀、okkar 催化剂增益、all_modules_*、*_buff 等。.position 为 0~1 归一化位置，非真实数值。modules 每种模块只装备一件，直接输出单件对象(未装备为 null)；主/副武器为数组。携带货物(cargo)固定为空数组。特别说明：所有传奇(Legendary)装备(主武器/副武器/模块/装置)的附加属性暂不抽取(attributes=[]，能否更换待确认)，其等级字段仍照常输出。'
		},
		currentShip: {
			index: idx,
			templateId: shipTpl,
			shipType: shipTypeOf(shipTpl), // 舰种(游戏内 Ship Class): Rogue/Gunship/Bomber/Sentinel…
			primaryWeapons: extractCategory(inv, 'PrimaryWeapons'),
			secondaryWeapons: extractCategory(inv, 'SecondaryWeapons'),
			modules,
			cargo: []
		},
		ships: shipSummary,
		skillMap: {
			Scout: [
				{ label: '武器射程 +30%', value: 'scout_passive_range' },
				{
					label: '暗影突袭期间推进能量回复 +100%',
					value: 'scout_shadow_strike_boost_regen'
				},
				{ label: '暗影突袭期间不会被地雷侦测', value: 'scout_shadow_strike_mine_undetect' },
				{
					label: '暗影突袭结束后获得 5 秒无敌',
					value: 'scout_shadow_strike_invincibility'
				},
				{ label: '敌人侦测范围 -25%', value: 'scout_enemy_detection_range' },
				{ label: '装置启动距离 +20%', value: 'scout_device_activation_range' },
				{ label: '隐形持续时间 +20%', value: 'scout_cloak_duration' },
				{ label: '所有主武器弹速 +50%', value: 'scout_increased_projectile_speed' },
				{ label: '所有主武器散布 -50%', value: 'scout_reduced_weapon_spread' }
			],
			Rogue: [
				{ label: '支援装置冷却 -20%', value: 'rogue_support_cooldowns' },
				{ label: '作战装置冷却 -20%', value: 'rogue_warfare_cooldowns' },
				{ label: '虚空蜂群半径 +25%', value: 'rogue_swarm_radius' },
				{ label: '护盾耗尽后隐形 5 秒（签名被动）', value: 'rogue_passive_perk' },
				{ label: '使用装置回复 15% 护盾', value: 'rogue_device_powers_shield' },
				{
					label: '使用装置回复 25% 推进能量',
					value: 'rogue_ult_reduce_energy_consumption'
				},
				{ label: '腐蚀伤害 +25%', value: 'rogue_increased_corrosion_damage' },
				{ label: 'EMP 持续时间 +25%', value: 'rogue_increased_emp_duration' }
			],
			Vanguard: [
				{
					label: '附近有敌人时也能启用巡航驱动',
					value: 'vanguard_cruise_drive_enemy_proximity'
				},
				{ label: '网/缠绕效果 -50%', value: 'vanguard_reduced_net_effect' },
				{
					label: '依过载百分比最高 -20% 支援装置冷却',
					value: 'vanguard_overcharge_reduces_cooldowns'
				},
				{
					label: '时间延长器立即回满武器与推进能量',
					value: 'vanguard_time_extender_full_energy'
				},
				{ label: '紧跟敌机后方时武器伤害 +20%', value: 'vanguard_rear_damage_bonus' },
				{ label: '200m 内主武器获得 20% 穿盾穿甲', value: 'vanguard_close_range_piercing' },
				{ label: '护盾过载时暴击伤害 +25%', value: 'vanguard_overcharge_crit_damage' },
				{ label: '过载充能速度 +25%', value: 'vanguard_overcharge_charge_speed' },
				{ label: '过载永不衰减', value: 'vanguard_overcharge_no_decay' }
			],
			Interceptor: [
				{
					label: '朝 1500m 外锁定目标飞行时速度 +15%',
					value: 'interceptor_long_range_speed'
				},
				{ label: '主武器伤害 +10%', value: 'interceptor_increased_primary_damage' },
				{
					label: '拾取能量球 6 秒内暴击率 +1%（最多 20%）',
					value: 'interceptor_energy_orb_crit_chance'
				},
				{ label: '主武器命中返还 30% 能量消耗', value: 'interceptor_hit_energy_return' },
				{
					label: '暴击有 20% 几率为武器超载充能 1%',
					value: 'interceptor_crit_charges_overdrive'
				},
				{
					label: '进入区域后 60 秒内推进与射速 +20%',
					value: 'interceptor_zone_speed_bonus'
				},
				{
					label: '持续开火每秒暴击伤害 +1%（最多 20%）',
					value: 'interceptor_sustained_fire_crit_damage'
				},
				{
					label: '武器超载期间能量球拾取范围 +100%',
					value: 'interceptor_overdrive_energy_pickup_range'
				},
				{
					label: '武器超载期间副武器 50% 几率不消耗',
					value: 'interceptor_overdrive_secondary_free'
				}
			],
			Sentinel: [
				{ label: '作战装置冷却 -20%', value: 'sentinel_warfare_cooldowns' },
				{ label: '护盾值 +15%', value: 'sentinel_increased_shield_capacity' },
				{
					label: '用静电过载击杀回复 10% 护盾',
					value: 'sentinel_static_overload_shield_restore'
				},
				{
					label: '静电过载每秒 10% 几率施加 EMP',
					value: 'sentinel_static_overload_emp_chance'
				},
				{
					label: '护盾耗尽立即重置所有支援装置冷却（每 2 分钟一次）',
					value: 'sentinel_shield_depleted_reset_support'
				},
				{
					label: '每次击杀使随机一个装置冷却 -1 秒',
					value: 'sentinel_kill_reduces_random_cooldown'
				},
				{ label: '拾取能量球生成 2 秒能量护盾', value: 'sentinel_energy_orb_shield_buff' },
				{ label: '使用消耗品立即触发护盾充能', value: 'sentinel_consumable_shield_charge' },
				{
					label: '护盾 ≥50% 时免疫腐蚀',
					value: 'sentinel_shield_threshold_corrosion_immunity'
				},
				{
					label: '护盾满充时推进与武器能耗 -20%',
					value: 'sentinel_full_shield_energy_reduction'
				}
			],
			Striker: [
				{ label: '被导弹锁定时推进速度 +30%', value: 'striker_missile_lock_boost' },
				{ label: '锁定的敌人减速 20%', value: 'striker_lock_target_slow' },
				{ label: '可抓取并投掷无人机', value: 'striker_grab_drones' },
				{
					label: '启动量子系绳瞬间修复 50% 装甲',
					value: 'striker_quantum_tether_armor_repair'
				},
				{
					label: '300m 内敌人无法回复护盾',
					value: 'striker_close_range_shield_regen_block'
				},
				{ label: '自身受到的溅射伤害 -60%', value: 'striker_reduced_splash_damage' },
				{ label: '1km 内敌人伤害 -20%', value: 'striker_nearby_enemy_damage_reduction' },
				{ label: '减益持续时间 -20%', value: 'striker_reduced_debuff_duration' },
				{ label: '舰体伤害减免 20%', value: 'striker_hull_damage_reduction' }
			],
			Okkar: [
				{ label: '量子契约（签名被动）：击杀敌人掉落残响碎片，拾取获得空灵共振层数，提升移动速度并对附近敌人造成每秒持续伤害（锁定目标双倍）', value: 'okkar_passive_perk' },
				{ label: '消耗品使用时 30% 几率不被消耗', value: 'okkar_free_consumable_chance' },
				{ label: '舰体伤害 25% 几率被完全无视', value: 'okkar_hull_damage_ignore_chance' },
				{ label: '进入幽灵形态回满武器与推进能量', value: 'okkar_restore_energy' },
				{
					label: '每层空灵共振使幽灵形态舰体衰减 -10%',
					value: 'okkar_stacks_reduce_hull_decay'
				},
				{
					label: '奥卡尔单位仅在视野内且距离 <1000m 时才会发现',
					value: 'okkar_detection_range'
				}
			],
			Gunship: [
				{ label: '炮塔也会攻击地雷', value: 'gunship_turret_attacks_mines' },
				{ label: '对无人机伤害 +30%', value: 'gunship_drone_damage' },
				{ label: '推进速度 +15%', value: 'gunship_increased_boost_speed' },
				{
					label: '10 秒未受击后每秒回复 2% 装甲（至多一半）',
					value: 'gunship_armor_regen_after_damage'
				},
				{ label: '使用消耗品回复 8% 装甲', value: 'gunship_consumable_armor_restore' },
				{
					label: '装甲耗尽立即重置所有作战装置冷却（每 2 分钟一次）',
					value: 'gunship_armor_depleted_reset_warfare'
				},
				{ label: '舰体 ≤50% 时伤害减免 40%', value: 'gunship_low_hull_damage_reduction' },
				{ label: '每次击杀装甲修复 +20%', value: 'gunship_kill_armor_repair_bonus' },
				{ label: '脉冲激光炮塔', value: 'gunship_pulse_laser_turret' },
				{ label: '线圈炮炮塔', value: 'gunship_coilgun_turret' }
			],
			Bomber: [
				{ label: '锁定所需时间 -50%', value: 'bomber_reduced_lock_duration' },
				{ label: '受到敌人爆炸伤害 -20%', value: 'bomber_reduced_explosive_damage' },
				{ label: '不加速近距飞过时转化地雷而非引爆', value: 'bomber_mine_conversion' },
				{ label: '自身 ARC-9000 爆炸伤害 -50%', value: 'bomber_arc_self_damage_reduction' },
				{ label: 'ARC-9000 发射后每秒伤害 +2%', value: 'bomber_arc_scaling_damage' },
				{ label: '目标锁定在屏幕外仍保持', value: 'bomber_offscreen_lock_hold' },
				{ label: '所有副武器能量消耗 -20%', value: 'bomber_reduced_secondary_energy' },
				{
					label: '启动 ARC-9000 回满副武器能量',
					value: 'bomber_arc_full_secondary_energy'
				},
				{
					label: '手动引爆 ARC-9000 时冲击波伤害 +40%',
					value: 'bomber_arc_manual_detonation_damage'
				}
			],
			Vindicator: [
				{ label: '无人机上限 +1', value: 'vindicator_drone_increase' },
				{ label: '方阵期间无人机无敌', value: 'vindicator_drone_debuff_immunity' },
				{ label: '无人机每秒回复 1% 舰体', value: 'vindicator_drone_regen' },
				{ label: '受到敌方无人机伤害 -50%', value: 'vindicator_enemy_drone_damage' },
				{
					label: '无人机死亡时爆炸，伤害并减速附近敌人',
					value: 'vindicator_drone_explosion'
				},
				{
					label: '无人机被摧毁后 6 秒内武器伤害 +20%',
					value: 'vindicator_drone_death_bonus'
				},
				{
					label: '收集残骸回复 10% 护盾',
					value: 'vindicator_collect_wreckage_shield_restore'
				},
				{
					label: '无人机被摧毁时 20% 几率立即重建',
					value: 'vindicator_drone_instant_revive'
				},
				{
					label: '锁定目标受到无人机伤害 +20%',
					value: 'vindicator_locked_target_drone_damage_buff'
				},
				{
					label: '2km 内敌方支援无人机被动被干扰失效',
					value: 'vindicator_enemy_drone_disable_passive'
				}
			]
		},
		attributeMap: loadAttributeMap(),
		functionTextList: [
			{
				name: 'skillFilter',
				function: `function (store, typeSkillMap) {
					return typeSkillMap[store.currentShip.shipType];
				}`
			},
			{
				// 必须是字符串：主进程返回值走 IPC 结构化克隆，函数值无法序列化
				name: 'attributeFilter_mainWeapon',
				function: `function (store) {
					const map = store.attributeMap || {};
					return [...(map.mainWeapon || [])];
				}`
			},
			{
				name: 'attributeFilter_subWeapon',
				function: `function (store) {
					const map = store.attributeMap || {};
					return [...(map.subWeapon || [])];
				}`
			},
			{
				name: 'attributeFilter_energyCore',
				function: `function (store) {
					const map = store.attributeMap || {};
					return [...(map.energyCore || []), ...(map.public || [])];
				}`
			},
			{
				name: 'attributeFilter_shield',
				function: `function (store) {
					const map = store.attributeMap || {};
					return [...(map.shield || []), ...(map.public || [])];
				}`
			},
			{
				name: 'attributeFilter_plating',
				function: `function (store) {
					const map = store.attributeMap || {};
					return [...(map.plating || []), ...(map.public || [])];
				}`
			},
			{
				name: 'attributeFilter_sensor',
				function: `function (store) {
					const map = store.attributeMap || {};
					return [...(map.sensor || []), ...(map.public || [])];
				}`
			},
			{
				name: 'attributeFilter_thruster',
				function: `function (store) {
					const map = store.attributeMap || {};
					return [...(map.thruster || []), ...(map.public || [])];
				}`
			},
			{
				name: 'attributeFilter_cargoUnit',
				function: `function (store) {
					const map = store.attributeMap || {};
					return [...(map.cargoUnit || []), ...(map.public || [])];
				}`
			}
		]
	};

	// 当前飞船被动技能：用 skillMap 的 value 集合过滤飞船 AttributeStates，
	// 仅保留能对得上的技能 code（剔除船体核心属性等非技能项）。
	const SKILL_VALUE_SET = new Set();
	for (const k of Object.keys(result.skillMap)) {
		for (const e of result.skillMap[k]) SKILL_VALUE_SET.add(e.value);
	}
	result.currentShip.skills = extractShipSkills(sis, SKILL_VALUE_SET);

	return result;
};
