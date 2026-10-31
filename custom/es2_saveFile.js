#!/usr/bin/env node
/*
 * es2_writeback.js — EVERSPACE 2 存档「读 JSON → 写回 .sav」
 * ===============================================================
 * 纯 Node（仅内置 zlib / fs / path，无需 npm 安装）。
 *
 * 功能：读取 es2_loadout.json（es2_loadout.js 的导出产物），
 *       把 currentShip 里的改动（每件装备的 等级 / 附加属性 / 飞船被动技能）
 *       回写到对应存档。
 *
 * 配套：es2_loadout.js（读存档 → JSON）。本脚本是它的逆操作。
 *
 * ⚠️ 避开的历史教训（见项目 memory / 修改存档的血泪步骤）：
 *   1) 深改必须整链置 dirty，否则 wr_prop 见 not dirty + raw 会吐回旧字节，
 *      改动被吞。→ 改写后把 ShipsSaveState 整棵标记 dirty 重建。
 *   2) 传奇(Legendary)装备的附加属性从未被抽取(attributes=[])，绝不拿空数组覆盖原属性。
 *      → JSON 里传奇 attributes 为空时保留存档原属性；只有非传奇、或 JSON 显式给了 attributes 才重建。
 *   3) 同名属性 ID 在同一件上只生效一条(规则6)。→ 写回时按 ID 去重，仅保留首条。
 *   4) 默认演练(dry-run)不写盘；真正写盘前生成带时间戳的 .bak；写后重新解析自检顶层属性数。
 *   5) 按「槽位 + 模板ID」双重匹配；存档槽位当前模板与 JSON 不一致说明装备已换，跳过避免误改。
 *   6) 不动 PlayerLevel / 船体(ItemTemplateID) 等绑定字段。
 *
 * 用法：
 *   node es2_writeback.js                 # 演练：打印将要应用的改动，不写盘
 *   node es2_writeback.js --write         # 真正写回存档（写前自动备份）
 *   node es2_writeback.js -j my.json      # 指定 JSON 文件（默认同目录 es2_loadout.json）
 *   node es2_writeback.js --save xxx.sav  # 指定存档（默认用 JSON.meta.saveFile 定位）
 *   node es2_writeback.js --any-level     # 顺带把所有被改装备的 CanBeUsedWithAnyLevel 设为 true
 *                                         （超等级装备给低等级玩家用，解除 UI 红标；默认不动）
 *   node es2_writeback.js --keep-pos       # 词缀 pos 保留 JSON 原值（默认：修改的词缀 pos 强制置 1.0 最大）
 */

'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ===================================================================
//  GVAS 解析器（移植自 es2_loadout.js / gvas.py，保持一致）
// ===================================================================
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

// -------------------------------------------------------------------
//  附加属性判定（与 es2_loadout.js 导出脚本保持一致）
//  AttributeStates 里混了：核心属性(模板固有,不占槽) + 隐藏标记 + 占槽词缀。
//  导出时负向剔除核心/隐藏，只留占槽词缀；写回时【必须保留核心/隐藏条目】，
//  只替换词缀那部分 —— 否则会误删武器/模块的固有战斗属性（射程/射速/伤害等）。
// -------------------------------------------------------------------
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
	'item_stack_amount'
]);
function isCoreAttr(id) {
	if (!id) return true;
	if (/^weapon_/.test(id) && !/_buff$/.test(id)) return true;
	if (/^secondary_/.test(id)) return true;
	if (/^device_/.test(id)) return true;
	if (/^sensor_range_/.test(id)) return true;
	if (/^energy_core_regen_/.test(id)) return true;
	if (/^consumable_/.test(id)) return true;
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
	if (id === 'cargo_slots_buff') return true;
	if (id === 'armor') return true;
	if (id === 'no_interception') return true;
	if (id === 'xr_wish_effect') return true;
	return false;
}
function isAffixAttr(id) {
	if (!id) return false;
	if (HIDDEN_ATTR.has(id)) return false;
	if (isCoreAttr(id)) return false;
	return true;
}

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
	off += 20 * n;
	const cl = readFString(data, off);
	const cls = cl.str;
	off = cl.off;
	if (off < data.length && data[off] === 0x00) off += 1;
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
	if (!(size >= 0 && size <= buf.length)) throw new Error(name + '(' + tname + '): Size=' + size + ' 不合理');
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
		raw: buf.subarray(start, pend),
		dirty: false
	};
	try {
		const o2 = parsePayload(buf, pstart, pend, prop);
		if (o2 !== pend) throw new Error('payload 消耗 ' + (o2 - pstart) + ' != Size ' + size);
	} catch (e) {
		prop.unparsed = true;
		prop.error = String((e && e.message) || e);
		prop.payloadRaw = buf.subarray(pstart, pend);
	}
	return { prop, off: pend };
}

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
		return { data: raw, meta: { raw: true, ver: null } };
	}
	if (!(raw[0] === 0xde && raw[1] === 0xc0 && raw[2] === 0xde && raw[3] === 0x00))
		throw new Error(p + ': 不是 ES2 存档 (magic=' + raw.subarray(0, 4).toString('hex') + ')');
	const ver = raw.readUInt32LE(4);
	const usize = raw.readUInt32LE(8);
	const csize = raw.readUInt32LE(12);
	const body = zlib.inflateSync(raw.subarray(16));
	return { data: body, meta: { ver, usize, csize, raw: false } };
}

function saveSav(p, gvasBytes, version) {
	if (version === null || version === undefined) {
		fs.writeFileSync(p, gvasBytes);
		return gvasBytes.length;
	}
	const comp = zlib.deflateSync(gvasBytes, { level: 9 });
	const head = Buffer.from([0xde, 0xc0, 0xde, 0x00]);
	const meta4 = Buffer.alloc(12);
	meta4.writeUInt32LE(version >>> 0, 0);
	meta4.writeUInt32LE(gvasBytes.length >>> 0, 4);
	meta4.writeUInt32LE(comp.length >>> 0, 8);
	fs.writeFileSync(p, Buffer.concat([head, meta4, comp]));
	return Buffer.concat([head, meta4, comp]).length;
}

// ===================================================================
//  GVAS 写入器（移植自 gvas.py 的 wr_*）
// ===================================================================
function int32Buf(x) {
	const b = Buffer.alloc(4);
	b.writeInt32LE(x | 0, 0);
	return b;
}

function wrFString(s) {
	if (s === null || s === undefined) s = '';
	if (s === '') return Buffer.from([0, 0, 0, 0]);
	const raw = Buffer.from(s, 'utf8');
	const out = Buffer.alloc(4 + raw.length + 1);
	out.writeInt32LE(raw.length + 1, 0);
	raw.copy(out, 4);
	out[4 + raw.length] = 0x00;
	return out;
}

function wrTNode(n) {
	const out = [wrFString(n.name)];
	out.push(int32Buf(n.children ? n.children.length : 0));
	if (n.children) for (const c of n.children) out.push(wrTNode(c));
	return Buffer.concat(out);
}

function structPackFixed(t, v) {
	switch (t) {
		case 'Int8Property': {
			const b = Buffer.alloc(1);
			b.writeInt8(v | 0, 0);
			return b;
		}
		case 'Int16Property': {
			const b = Buffer.alloc(2);
			b.writeInt16LE(v | 0, 0);
			return b;
		}
		case 'IntProperty': {
			const b = Buffer.alloc(4);
			b.writeInt32LE(v | 0, 0);
			return b;
		}
		case 'Int64Property': {
			const b = Buffer.alloc(8);
			b.writeBigInt64LE(BigInt(v), 0);
			return b;
		}
		case 'UInt16Property': {
			const b = Buffer.alloc(2);
			b.writeUInt16LE(v | 0, 0);
			return b;
		}
		case 'UInt32Property': {
			const b = Buffer.alloc(4);
			b.writeUInt32LE(v >>> 0, 0);
			return b;
		}
		case 'UInt64Property': {
			const b = Buffer.alloc(8);
			b.writeBigUInt64LE(BigInt(v), 0);
			return b;
		}
		case 'FloatProperty': {
			const b = Buffer.alloc(4);
			b.writeFloatLE(v, 0);
			return b;
		}
		case 'DoubleProperty': {
			const b = Buffer.alloc(8);
			b.writeDoubleLE(v, 0);
			return b;
		}
	}
	throw new Error('未知定长类型 ' + t);
}

const WR_NONE_TERM = wrFString('None');

function structKids(c) {
	if (c.children) return c.children;
	if (Array.isArray(c.value)) return c.value;
	return [];
}

function wrValue(c) {
	const t = c.type;
	const base = t ? t.split('<')[0] : '';
	if (FIXED.has(t)) return structPackFixed(t, c.value);
	if (FIXED.has(base)) return structPackFixed(base, c.value);
	if (STR_TYPES.has(t) || STR_TYPES.has(base)) return wrFString(c.value);
	if (base === 'BoolProperty') return Buffer.from([c.value ? 1 : 0]);
	if (base === 'StructProperty') {
		const out = [];
		for (const g of structKids(c)) out.push(wrProp(g));
		out.push(WR_NONE_TERM);
		return Buffer.concat(out);
	}
	throw new Error('无法写出裸值类型 ' + t);
}

function wrInline(c) {
	const t = c.type;
	const base = t ? t.split('<')[0] : '';
	if (FIXED.has(t)) return structPackFixed(t, c.value);
	if (FIXED.has(base)) return structPackFixed(base, c.value);
	if (STR_TYPES.has(t) || STR_TYPES.has(base)) return wrFString(c.value);
	if (base === 'BoolProperty') return Buffer.from([c.value ? 1 : 0]);
	if (base === 'StructProperty') {
		const out = [];
		for (const g of structKids(c)) out.push(wrProp(g));
		out.push(WR_NONE_TERM);
		return Buffer.concat(out);
	}
	throw new Error('无法写出裸值类型 ' + t);
}

function wrMapKey(c) {
	const kt = c.keyType;
	const kv = c.keyValue;
	if (kt == null) return Buffer.alloc(0);
	if (Array.isArray(kv)) return wrInline({ type: 'StructProperty', children: kv });
	return wrInline({ type: kt, value: kv });
}

function wrPayload(p) {
	const t = p.type;
	if (p.unparsed || p.payloadRaw != null) return p.payloadRaw || Buffer.alloc(0);
	if (FIXED.has(t)) return structPackFixed(t, p.value);
	if (SOFT_TYPES.has(t)) {
		const vs = Array.isArray(p.value) ? p.value : [p.value];
		return Buffer.concat(vs.map((v) => wrFString(v)));
	}
	if (STR_TYPES.has(t)) return wrFString(p.value);
	if (t === 'BoolProperty') return Buffer.alloc(0);
	if (t === 'StructProperty') {
		const out = [];
		for (const c of p.children || []) out.push(wrProp(c));
		out.push(WR_NONE_TERM);
		return Buffer.concat(out);
	}
	if (t === 'ArrayProperty' || t === 'SetProperty') {
		const out = [int32Buf((p.children || []).length)];
		for (const c of p.children || []) out.push(wrValue(c));
		return Buffer.concat(out);
	}
	if (t === 'MapProperty') {
		const out = [int32Buf(p.numRemoved || 0), int32Buf((p.children || []).length)];
		for (const c of p.children || []) {
			out.push(wrMapKey(c));
			out.push(wrInline(c));
		}
		return Buffer.concat(out);
	}
	throw new Error('无法写出类型 ' + t);
}

function wrProp(p) {
	if (!p.dirty && p.raw) return p.raw;
	let payload = wrPayload(p);
	let flag = p.flag || 0;
	if (p.type === 'BoolProperty') flag = p.value ? 0x10 : 0x00;
	const out = [];
	out.push(wrFString(p.name));
	out.push(wrTNode(p.tnode));
	out.push(int32Buf(payload.length));
	out.push(Buffer.from([flag & 0xff]));
	if (p.flag === 1 && p.guid) out.push(p.guid);
	out.push(payload);
	return Buffer.concat(out);
}

function buildGvas(header, props, footer) {
	const out = [header];
	for (const p of props) out.push(wrProp(p));
	out.push(WR_NONE_TERM);
	out.push(footer || Buffer.alloc(0));
	return Buffer.concat(out);
}

// ===================================================================
//  导航辅助
// ===================================================================
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
function setPropValue(p, v) {
	if (!p) return;
	p.value = v;
	p.children = null;
	p.payloadRaw = null;
	p.unparsed = false;
	p.dirty = true;
}
function cloneTNode(t) {
	if (!t) return null;
	return { name: t.name, children: t.children ? t.children.map(cloneTNode) : [] };
}
// 递归清除子树中“有 children 的中间节点”的 raw 并置脏，强制从 children 重建。
// 叶子节点(无 children)保留 raw：未改的走 raw 不变，已改的靠 setPropValue 置脏。
// unparsed 节点整体跳过，保留 raw 避免丢数据。
function markSubtreeDirty(node) {
	if (!node || node.unparsed) return;
	if (node.children && node.children.length) {
		node.raw = null;
		if ('payloadRaw' in node) node.payloadRaw = null;
		node.dirty = true;
		for (const c of node.children) markSubtreeDirty(c);
	}
	if (node.tnode && node.tnode.children && node.tnode.children.length) {
		for (const c of node.tnode.children) markSubtreeDirty(c);
	}
}
function cloneNode(n) {
	return {
		name: n.name,
		type: n.type,
		tnode: n.tnode ? cloneTNode(n.tnode) : null,
		size: n.size,
		flag: n.flag,
		guid: n.guid,
		children: n.children ? n.children.map(cloneNode) : null,
		value: n.value,
		raw: null,
		dirty: true,
		unparsed: false,
		payloadRaw: null
	};
}
// 以 proto 元素为骨架，构造一条 AttributeStates 元素（AttributeTemplateID + ValuePositionInRange）
function makeAttrElement(proto, id, pos) {
	const el = cloneNode(proto);
	const idc = getChild(el, 'AttributeTemplateID');
	const posc = getChild(el, 'ValuePositionInRange');
	if (idc) setPropValue(idc, id);
	if (posc) setPropValue(posc, pos);
	return el;
}

// ===================================================================
//  应用逻辑
// ===================================================================
const MAX_POS = 1.0; // 修改的属性(占槽词缀)始终置为最大值
const MODULE_CATS = ['EnergyCores', 'Sensors', 'Shields', 'CargoUnits', 'Platings', 'thrusters'];
const SAVDIR = process.env.ES2_SAVDIR || 'C:/Users/Azrael/AppData/Local/ES2/Saved/SaveGames';

function findProto(ship) {
	const inv = getChild(ship, 'Inventory');
	if (inv && inv.children) {
		for (const cat of inv.children) {
			if (cat.children) {
				for (const el of cat.children) {
					const a = getChild(el, 'AttributeStates');
					if (a && a.children && a.children.length) return a.children[0];
				}
			}
		}
	}
	const sis = getChild(ship, 'ShipItemState');
	const sa = sis && getChild(sis, 'AttributeStates');
	if (sa && sa.children && sa.children.length) return sa.children[0];
	return null;
}

function applyItem(item, jw, changes, opts) {
	const tpl = childVal(item, 'ItemTemplateID');
	// 等级
	const lvNode = getChild(item, 'ItemLevel');
	const curLv = lvNode ? lvNode.value : null;
	if (jw.level != null && jw.level !== curLv) {
		setPropValue(lvNode, jw.level);
		changes.push(`    ${tpl}: ItemLevel ${curLv} -> ${jw.level}`);
	}
	const vloNode = getChild(item, 'VirtualLevelOffset');
	if (jw.effectiveLevel != null && jw.level != null) {
		const vo = Math.round((jw.effectiveLevel - jw.level) * 100) / 100;
		const curVo = vloNode ? vloNode.value : null;
		if (vo !== curVo) {
			setPropValue(vloNode, vo);
			changes.push(
				`    ${tpl}: VirtualLevelOffset ${curVo} -> ${vo}  (有效等级 -> ${jw.effectiveLevel})`
			);
		}
	}
	// 附加属性
	// 关键：AttributeStates 里混了【核心属性(武器射程/射速/伤害…) + 隐藏标记 + 占槽词缀】。
	// JSON 的 attributes 只含"占槽词缀"(isAffixAttr=true)。写回时务必保留核心/隐藏条目，
	// 只用 JSON 里的词缀【替换】原来的词缀部分，绝不能整段覆盖（否则误删武器固有属性）。
	const saveRarity = (childVal(item, 'Rarity') || '').replace(/^EItemRarity::/, '');
	const isLegendary = /legendary/i.test(saveRarity);
	const attrs = getChild(item, 'AttributeStates');
	const want = jw.attributes || [];
	const origCount = attrs && attrs.children ? attrs.children.length : 0;
	if (want.length === 0 && isLegendary) {
		changes.push(`    ${tpl}: 传奇装备 attributes 为空 -> 保留原附加属性(不覆盖)`);
	} else if (!attrs) {
		// 极端情况：物品完全没有 AttributeStates，用 JSON 词缀新建
		const proto = findProtoFrom(opts.proto);
		const newKids = [];
		const seen = new Set();
		for (const a of want) {
			if (seen.has(a.id)) {
				changes.push(`    [去重] ${tpl}: ${a.id} 同名重复，仅保留首条(规则6)`);
				continue;
			}
			seen.add(a.id);
			const pos = opts.keepPos ? a.position : MAX_POS;
			newKids.push(makeAttrElement(proto, a.id, pos));
		}
		item.children.push({
			name: 'AttributeStates',
			type: 'ArrayProperty',
			tnode: { name: 'ArrayProperty', children: [proto ? proto.tnode : { name: 'StructProperty', children: [] }] },
			children: newKids,
			dirty: true,
			raw: null
		});
		changes.push(`    ${tpl}: 新建 AttributeStates，写入 ${newKids.length} 条词缀 [${opts.keepPos ? 'pos=保留原值' : 'pos=1.0(最大)'}]`);
	} else {
		// 拆分：keep = 非词缀(核心/隐藏) 原样保留；affixOld = 原词缀(将被 JSON 词缀替换)
		const keep = [];
		for (const e of attrs.children || []) {
			const id = childVal(e, 'AttributeTemplateID');
			if (isAffixAttr(id)) {
				// 原词缀：被替换，不保留
			} else {
				keep.push(e); // 核心/隐藏：保留原始节点(写回时走 raw，字节级不变)
			}
		}
		const proto = attrs.children[0];
		const newAffix = [];
		const seen = new Set();
		for (const a of want) {
			if (seen.has(a.id)) {
				changes.push(`    [去重] ${tpl}: ${a.id} 同名重复，仅保留首条(规则6)`);
				continue;
			}
			seen.add(a.id);
			const pos = opts.keepPos ? a.position : MAX_POS;
			newAffix.push(makeAttrElement(proto, a.id, pos));
		}
		attrs.children = keep.concat(newAffix);
		attrs.dirty = true;
		attrs.payloadRaw = null;
		const posNote = opts.keepPos ? 'pos=保留原值' : 'pos=1.0(最大)';
		changes.push(`    ${tpl}: AttributeStates ${origCount} -> 保留核心/隐藏 ${keep.length} + 词缀 ${newAffix.length} = ${attrs.children.length} 条 [${posNote}]`);
	}
	// 解除等级限制（可选）
	if (opts.anyLevel) {
		const anyl = getChild(item, 'CanBeUsedWithAnyLevel');
		if (anyl && !anyl.value) {
			setPropValue(anyl, true);
			changes.push(`    ${tpl}: CanBeUsedWithAnyLevel -> true`);
		}
	}
}
function findProtoFrom(proto) {
	return proto;
}

function applyList(inv, catName, list, changes, opts) {
	if (!list) return;
	const cat = getChild(inv, catName);
	if (!cat || !cat.children) return;
	for (let i = 0; i < list.length; i++) {
		const jw = list[i];
		const item = cat.children[i];
		if (!item) {
			changes.push(`  [跳过] ${catName}[${i}] 存档中无此槽位`);
			continue;
		}
		const saveTpl = childVal(item, 'ItemTemplateID');
		if (saveTpl !== jw.templateId) {
			changes.push(
				`  [跳过] ${catName}[${i}] 模板不一致：存档=${saveTpl} / JSON=${jw.templateId}（装备可能已更换，避免误改）`
			);
			continue;
		}
		changes.push(`  ▶ ${catName}[${i}] ${jw.templateId}`);
		applyItem(item, jw, changes, opts);
	}
}

function applyModule(inv, catName, obj, changes, opts) {
	if (!obj) return;
	const cat = getChild(inv, catName);
	if (!cat || !cat.children || !cat.children.length) {
		changes.push(`  [跳过] ${catName} 存档中无此模块`);
		return;
	}
	const item = cat.children[0];
	const saveTpl = childVal(item, 'ItemTemplateID');
	if (saveTpl !== obj.templateId) {
		changes.push(
			`  [跳过] ${catName} 模板不一致：存档=${saveTpl} / JSON=${obj.templateId}（避免误改）`
		);
		return;
	}
	changes.push(`  ▶ ${catName} ${obj.templateId}`);
	applyItem(item, obj, changes, opts);
}

function applySkills(sis, skills, skillValueSet, changes, proto) {
	if (!sis) return;
	const attrs = getChild(sis, 'AttributeStates');
	if (!attrs) return;
	const kids = attrs.children || [];
	const core = [];
	const skillEntries = {};
	for (const e of kids) {
		const id = childVal(e, 'AttributeTemplateID');
		if (id && skillValueSet.has(id)) skillEntries[id] = e;
		else core.push(e);
	}
	const want = skills || [];
	const newSkillEls = [];
	const seen = new Set();
	for (const code of want) {
		if (seen.has(code)) {
			changes.push(`  [去重] 技能 ${code} 重复`);
			continue;
		}
		seen.add(code);
		if (skillEntries[code]) {
			newSkillEls.push(cloneNode(skillEntries[code])); // 保留原 pos
			changes.push(`    保留技能 ${code} (pos 保留)`);
		} else {
			const p = proto || core[0];
			if (!p) {
				changes.push(`  [跳过] 新增技能 ${code}：找不到可复用的属性骨架`);
				continue;
			}
			newSkillEls.push(makeAttrElement(p, code, 1.0));
			changes.push(`    新增技能 ${code} (pos 默认 1.0) ⚠️ 载入存档确认是否生效`);
		}
	}
	const before = Object.keys(skillEntries).length;
	attrs.children = core.concat(newSkillEls);
	attrs.dirty = true;
	attrs.payloadRaw = null;
	changes.push(`    飞船被动技能：${before} -> ${newSkillEls.length} 条（核心属性保留 ${core.length} 条）`);
}

// ===================================================================
//  参数解析
// ===================================================================
function parseArgs(argv) {
	const o = { write: false, anyLevel: false, keepPos: false, json: null, save: null };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--write' || a === '-w') o.write = true;
		else if (a === '--any-level') o.anyLevel = true;
		else if (a === '--keep-pos') o.keepPos = true;
		else if (a === '-j' || a === '--json') o.json = argv[++i];
		else if (a === '--save' || a === '-s') o.save = argv[++i];
		else if (a === '-h' || a === '--help') {
			console.log('用法: node es2_writeback.js [--write] [-j json] [--save sav] [--any-level] [--keep-pos]');
			process.exit(0);
		} else {
			console.warn('忽略未知参数: ' + a);
		}
	}
	return o;
}

function ts() {
	const d = new Date();
	const p = (n) => String(n).padStart(2, '0');
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ===================================================================
//  主流程（应用内调用 / CLI 共用）
// ===================================================================
/**
 * 把数据应用到存档并（可选）写盘。
 * @param data     与 es2_loadout.js 输出同构的对象（meta / currentShip / skillMap …）
 * @param savePath 存档绝对路径
 * @param opts     { write, anyLevel, keepPos, jsonPath }
 */
function runWriteback(data, savePath, opts) {
	const cs = data.currentShip;
	if (!cs) throw new Error('数据缺少 currentShip');

	const { data: body, meta } = loadSav(savePath);
	const g = parseGvas(body);
	const top = {};
	for (const p of g.props) top[p.name] = p;
	const sss = top.ShipsSaveState;
	if (!sss) throw new Error('存档缺少 ShipsSaveState');
	const ships = sss.children || [];
	const idx = cs.index != null ? cs.index : 0;
	const ship = ships[idx];
	if (!ship) throw new Error('存档中找不到第 ' + idx + ' 艘船');
	const inv = getChild(ship, 'Inventory');
	const sis = getChild(ship, 'ShipItemState');

	// 技能 value 集合（用于区分「核心属性」与「技能条目」）
	const skillValueSet = new Set();
	if (data.skillMap) {
		for (const k of Object.keys(data.skillMap)) {
			for (const e of data.skillMap[k]) skillValueSet.add(e.value);
		}
	}

	const o = {
		anyLevel: !!opts.anyLevel,
		keepPos: !!opts.keepPos,
		proto: findProto(ship)
	};
	const changes = [];

	changes.push(`存档: ${savePath}`);
	if (opts.jsonPath) changes.push(`JSON: ${opts.jsonPath}`);
	changes.push(`当前船索引: ${idx} (templateId=${childVal(sis, 'ItemTemplateID')})`);
	changes.push('');

	applyList(inv, 'PrimaryWeapons', cs.primaryWeapons, changes, o);
	applyList(inv, 'SecondaryWeapons', cs.secondaryWeapons, changes, o);
	for (const c of MODULE_CATS) applyModule(inv, c, cs.modules && cs.modules[c], changes, o);
	if (cs.skills) applySkills(sis, cs.skills, skillValueSet, changes, o.proto);

	// ⚠️ 关键：整棵 ShipsSaveState 子树递归置脏+清 raw，强制从内存树重建
	//    （否则中间结构体 ShipItemState/Inventory/物品 仍带旧 raw，wrProp 回吐旧字节吞掉深改）
	markSubtreeDirty(sss);

	const out = buildGvas(g.header, g.props, g.footer);

	// 自检：重新解析一遍，结构必须还能读通且顶层属性数不变
	const g2 = parseGvas(out);
	if (g2.props.length !== g.props.length) {
		throw new Error(`自检失败：顶层属性数 ${g.props.length} -> ${g2.props.length}`);
	}

	if (!opts.write) {
		return { write: false, savePath, changes, bytes: out.length, props: g2.props.length };
	}

	// 真正写盘：先备份
	const bak = savePath + '.' + ts() + '.bak';
	fs.copyFileSync(savePath, bak);
	const bytes = saveSav(savePath, out, meta.raw ? null : meta.ver);
	return { write: true, savePath, backup: bak, bytes, changes, props: g2.props.length };
}

/**
 * 应用内调用入口（主进程 script:run 把本模块当函数调用）。
 * ctx = { data, filePath, dataKey, customDir, downloadsPath, documentsPath }
 *   data     —— 渲染进程 store.fileData[dataKey]（已去掉函数等不可序列化字段）
 *   filePath —— 要写回的存档绝对路径（渲染进程按 loadFiles[dataKey].fileSrc 解析后传入）
 */
function saveFromData(ctx = {}) {
	const data = ctx.data;
	if (!data || typeof data !== 'object' || !data.currentShip) {
		throw new Error('缺少 ctx.data.currentShip（请先加载存档）');
	}

	let savePath = ctx.filePath;
	if (!savePath) {
		const name = (data.meta && data.meta.saveFile) || 'ufo.sav';
		savePath = path.join(ctx.downloadsPath || SAVDIR, name);
	}
	if (!fs.existsSync(savePath)) throw new Error('找不到存档文件: ' + savePath);

	const res = runWriteback(data, savePath, { write: true });
	return {
		ok: true,
		savePath: res.savePath,
		backup: res.backup,
		bytes: res.bytes,
		changes: res.changes
	};
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const jsonPath = args.json || path.join(__dirname, 'es2_loadout.json');
	if (!fs.existsSync(jsonPath)) throw new Error('找不到 JSON 文件: ' + jsonPath);
	const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
	if (!data.currentShip) throw new Error('JSON 缺少 currentShip');

	const savName = (data.meta && data.meta.saveFile) || 'ufo.sav';
	const savePath = args.save || path.join(SAVDIR, savName);
	if (!fs.existsSync(savePath)) throw new Error('找不到存档文件: ' + savePath);

	const res = runWriteback(data, savePath, {
		write: args.write,
		anyLevel: args.anyLevel,
		keepPos: args.keepPos,
		jsonPath
	});

	if (!res.write) {
		console.log('==================== 演练模式（未写盘） ====================');
		console.log(res.changes.join('\n'));
		console.log(
			`\n演练完成：重建 ${res.bytes.toLocaleString()} 字节，重新解析 ${res.props} 个顶层属性 OK。`
		);
		console.log('确认无误后加 --write 真正写回（写前会自动备份）。');
		return;
	}

	console.log('==================== 已写回 ====================');
	console.log(res.changes.join('\n'));
	console.log(`\n已写回 -> ${res.savePath} (${res.bytes.toLocaleString()} 字节)`);
	console.log(`备份   -> ${res.backup}`);
	console.log('\n⚠️ 务必在游戏里【载入该存档】后再保存，否则游戏会用内存里的旧值覆盖你的修改。');
	console.log('   载入 -> 保存 -> 再读盘，确认改动生效。');
}

// 主进程 script:run 以函数形式调用本模块；同时保留内部函数便于单独测试序列化正确性
module.exports = saveFromData;
module.exports.parseGvas = parseGvas;
module.exports.buildGvas = buildGvas;
module.exports.loadSav = loadSav;
module.exports.saveSav = saveSav;
module.exports.wrProp = wrProp;
module.exports.getChild = getChild;
module.exports.childVal = childVal;

if (require.main === module) {
	try {
		main();
	} catch (e) {
		console.error('错误: ' + (e && e.stack ? e.stack : e));
		process.exit(1);
	}
}
