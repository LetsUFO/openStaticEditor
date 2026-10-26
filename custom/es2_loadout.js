#!/usr/bin/env node
/*
 * es2_loadout.js — EVERSPACE 2 存档读取
 * ---------------------------------------------------------------
 * 纯 Node（仅用内置 zlib / fs，无需 npm 安装），读取 ES2 的 GVAS 存档，
 * 提取【当前驾驶飞船】的装备附加属性。
 *
 * 输出口径（按需求精简）:
 *   - 主武器 / 副武器 / 模块 / 装置: 每件仅输出
 *       templateId  (物品模板，用于辨识是哪件装备)
 *       attributes  (附加属性/占槽词缀: 属性ID + 0~1 归一化位置)
 *     —— 不再输出等级(ItemLevel) / 品质(Rarity) / 品级(Grade) 等基础属性。
 *     —— attributes 只保留「附加词缀」: 采用负向剔除（去掉各品类固有核心属性 +
 *        隐藏/元数据标记），其余全部视为附加词缀，故能覆盖传说特效、导弹专属词缀、
 *        okkar 催化剂增益、all_modules_* 等全部真实属性（手动注入的可超过 4 条）。
 *   - 携带货物(cargo): 固定输出空数组 []。
 *
 * 用法:
 *   node es2_loadout.js                自动选最新存档 -> 桌面
 *   node es2_loadout.js --save <路径>  指定存档
 *   node es2_loadout.js --out  <路径>  指定输出文件
 *   node es2_loadout.js --ship <索引>  指定飞船（默认第一艘有模板的船）
 *
 * 注意: 存档里只存 ValuePositionInRange（0~1 归一化位置），真实数值由游戏
 *       运行时按品质/等级计算，此处不还原真实数值。
 */

'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const FIXED = new Set([
  'Int8Property', 'Int16Property', 'IntProperty', 'Int64Property',
  'UInt16Property', 'UInt32Property', 'UInt64Property',
  'FloatProperty', 'DoubleProperty',
]);
const STR_TYPES = new Set([
  'StrProperty', 'NameProperty', 'ObjectProperty', 'InterfaceProperty',
  'EnumProperty', 'ByteProperty', 'FieldPathProperty', 'ClassProperty',
  'DelegateProperty', 'MulticastInlineDelegateProperty',
]);
const SOFT_TYPES = new Set(['SoftObjectProperty', 'SoftClassProperty']);
const RAW_STRUCTS = new Set([
  'Guid', 'DateTime', 'Timespan', 'Vector', 'Rotator', 'Quat', 'LinearColor',
  'Color', 'IntPoint', 'Vector2D', 'Vector4', 'Transform', 'FrameNumber',
  'SmartName', 'MovieSceneSegmentIdentifier', 'MovieSceneSequenceID',
  'MovieSceneTrackIdentifier', 'MovieSceneEvaluationKey', 'MovieSceneFloatChannel',
  'Vector_NetQuantize', 'ESVariant', 'FSVariant',
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
  'no_random_drop', 'content_group', 'min_level', 'blueprintable', 'system_drop',
  'item_price', 'ascendant_rank', 'level_dependence', 'no_damage', 'full_auto',
  'item_stack_amount', // 消耗品/货物固有堆叠数
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
  if ([
    'shield_capacity', 'shield_recharge_speed', 'shield_recharge_delay',
    'shield_shutdown_duration', 'shield_absorption', 'shield_bleed_through',
    'shield_damage_reduction', 'shield_hardness',
  ].includes(id)) return true;
  // 推进器(thruster/booster)基础属性：boost_* 固有基础数值，不占附加槽
  // （注意：boost_after_kill 等是附加词缀，用精确名单而非前缀以避免误删）
  if ([
    'boost_speed', 'boost_acceleration', 'boost_recharge_speed',
    'boost_energy_capacity', 'boost_energy_consumption', 'boost_recharge_delay',
    'boost_charge', 'boost_regeneration', 'boost_duration',
  ].includes(id)) return true;
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
  let n = buf.readInt32LE(off); off += 4;
  if (n === 0) return { str: '', off };
  if (n > 0) {
    const raw = buf.subarray(off, off + n); off += n;
    let s = raw.toString('utf8');
    if (s.endsWith('\u0000')) s = s.slice(0, -1);
    return { str: s, off };
  }
  n = -n;
  const raw = buf.subarray(off, off + 2 * n); off += 2 * n;
  let s = raw.toString('utf16le').replace(/\u0000+$/, '');
  return { str: s, off };
}

function readFixed(buf, off, type) {
  switch (type) {
    case 'Int8Property':   return buf.readInt8(off);
    case 'Int16Property':  return buf.readInt16LE(off);
    case 'IntProperty':    return buf.readInt32LE(off);
    case 'Int64Property':  return Number(buf.readBigInt64LE(off));
    case 'UInt16Property': return buf.readUInt16LE(off);
    case 'UInt32Property': return buf.readUInt32LE(off);
    case 'UInt64Property': return Number(buf.readBigUInt64LE(off));
    case 'FloatProperty':  return buf.readFloatLE(off);
    case 'DoubleProperty':  return buf.readDoubleLE(off);
  }
  throw new Error('未知定长类型 ' + type);
}

function readTNode(buf, off, depth) {
  const r = readFString(buf, off); off = r.off;
  const name = r.str;
  let n = buf.readInt32LE(off); off += 4;
  if (!(n >= 0 && n <= 8) || depth > 8) throw new Error('类型树 nchild 异常 @' + (off - 4));
  const kids = [];
  for (let i = 0; i < n; i++) {
    const k = readTNode(buf, off, depth + 1); off = k.off;
    kids.push(k.node);
  }
  return { node: { name, children: kids }, off };
}

function readTypeTree(buf, off, tname) {
  let n = buf.readInt32LE(off); off += 4;
  if (!(n >= 0 && n <= 8)) throw new Error('类型树 nchild 异常 @' + (off - 4));
  const kids = [];
  for (let i = 0; i < n; i++) {
    const k = readTNode(buf, off, 0); off = k.off;
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
  const saveVer = data.readInt32LE(off); off += 4;
  const pkgUe4 = data.readInt32LE(off); off += 4;
  const pkgUe5 = data.readInt32LE(off); off += 4;
  const major = data.readUInt16LE(off); off += 2;
  const minor = data.readUInt16LE(off); off += 2;
  const patch = data.readUInt16LE(off); off += 2;
  const build = data.readUInt32LE(off); off += 4;
  const br = readFString(data, off); const branch = br.str; off = br.off;
  const cvfmt = data.readInt32LE(off); off += 4;
  const n = data.readInt32LE(off); off += 4;
  off += 20 * n; // CustomVersions
  const cl = readFString(data, off); const cls = cl.str; off = cl.off;
  if (off < data.length && data[off] === 0x00) off += 1; // 类名后填充
  const header = data.subarray(0, off);
  const res = parseProps(data, off, data.length, true);
  const footer = data.subarray(res.off);
  return {
    header, props: res.props, footer,
    info: { saveVer, pkgUe4, pkgUe5, engine: [major, minor, patch, build], branch, cvfmt, cls },
  };
}

// 读一条裸值（数组/Map 元素），t 可能带尖括号
function readBareValue(buf, off, end, t) {
  const base = t ? t.split('<')[0] : '';
  if (FIXED.has(t)) return { value: readFixed(buf, off, t), off: off + typeSize(t) };
  if (FIXED.has(base)) return { value: readFixed(buf, off, base), off: off + typeSize(base) };
  if (STR_TYPES.has(t) || STR_TYPES.has(base)) { const r = readFString(buf, off); return { value: r.str, off: r.off }; }
  if (base === 'BoolProperty') return { value: buf[off] !== 0, off: off + 1 };
  if (base === 'StructProperty') {
    const sn = structNameOfT(t);
    if (sn && sn.endsWith('BufferWrapper')) {
      const len = buf.readInt32LE(off); off += 4;
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
    Int8Property: 1, Int16Property: 2, IntProperty: 4, Int64Property: 8,
    UInt16Property: 2, UInt32Property: 4, UInt64Property: 8,
    FloatProperty: 4, DoubleProperty: 8,
  };
  return map[t] || 0;
}

function parseProps(buf, off, end, allowTail) {
  const props = [];
  while (off < end) {
    let p, noff;
    try {
      const r = parseOne(buf, off, end);
      p = r.prop; noff = r.off;
    } catch (e) {
      if (allowTail) break;
      throw e;
    }
    if (p === null) { off = noff; break; }
    props.push(p);
    off = noff;
  }
  return { props, off };
}

function parseOne(buf, off, end) {
  const start = off;
  const rn = readFString(buf, off); off = rn.off;
  const name = rn.str;
  if (name === 'None') return { prop: null, off };
  const rt = readFString(buf, off); off = rt.off;
  const tname = rt.str;
  const tt = readTypeTree(buf, off, tname); off = tt.off;
  const tnode = tt.node;
  const size = buf.readInt32LE(off); off += 4;
  if (!(size >= 0 && size <= buf.length)) throw new Error(name + '(' + tname + '): Size=' + size + ' 不合理');
  const flag = buf[off]; off += 1;
  let guid = null;
  if (flag === 1) { guid = buf.subarray(off, off + 16); off += 16; }
  const pstart = off;
  const pend = pstart + size;
  const prop = { name, type: tname, tnode, size, flag, guid, children: null, value: null, raw: buf.subarray(start, pend) };
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
  if (FIXED.has(t)) { prop.value = readFixed(buf, off, t); return off + typeSize(t); }
  if (SOFT_TYPES.has(t)) {
    const vals = [];
    while (off < end && vals.length < 4) { const r = readFString(buf, off); off = r.off; vals.push(r.str); }
    prop.value = vals.length === 1 ? vals[0] : vals;
    return off;
  }
  if (STR_TYPES.has(t)) { const r = readFString(buf, off); prop.value = r.str; return r.off; }
  if (t === 'BoolProperty') { prop.value = (prop.flag & 0x10) !== 0; return off + prop.size; }
  if (t === 'TextProperty') { prop.payloadRaw = buf.subarray(off, end); return end; }
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
    const cnt = buf.readInt32LE(off); off += 4;
    const itnode = prop.tnode.children[0];
    const it = itnode ? itnode.name : null;
    if (it === 'ByteProperty' && itnode && (!itnode.children || itnode.children.length === 0)) {
      prop.payloadRaw = buf.subarray(off - 4, end);
      prop.value = '<' + cnt + ' bytes>';
      return end;
    }
    if (it && it.startsWith('StructProperty') && structNameOfT(it) && structNameOfT(it).endsWith('BufferWrapper')) {
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
    const numRemoved = buf.readInt32LE(off); off += 4;
    const cnt = buf.readInt32LE(off); off += 4;
    prop.numRemoved = numRemoved;
    const keyT = prop.tnode.children[0] ? flat(prop.tnode.children[0]) : null;
    const valT = prop.tnode.children[1] ? flat(prop.tnode.children[1]) : null;
    const kids = [];
    for (let i = 0; i < cnt; i++) {
      const kr = readBareValue(buf, off, end, keyT); off = kr.off;
      const vr = readBareValue(buf, off, end, valT); off = vr.off;
      kids.push({ name: String(kr.value), type: valT, value: vr.value, keyType: keyT, keyValue: kr.value });
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
  if (!(raw[0] === 0xDE && raw[1] === 0xC0 && raw[2] === 0xDE && raw[3] === 0x00))
    throw new Error(p + ': 不是 ES2 存档 (magic=' + raw.subarray(0, 4).toString('hex') + ')');
  const ver = raw.readUInt32LE(4);
  const usize = raw.readUInt32LE(8);
  const csize = raw.readUInt32LE(12);
  const body = zlib.inflateSync(raw.subarray(16));
  return { data: body, meta: { ver, usize, csize, raw: false } };
}

// ---------------------------------------------------------------- 导航
function getChild(node, name) {
  const arr = Array.isArray(node) ? node : (node && node.children ? node.children : null);
  if (!arr) return null;
  for (const c of arr) if (c.name === name) return c;
  return null;
}
function childVal(node, name) {
  const c = getChild(node, name);
  return c ? c.value : null;
}

// 仅提取「附加属性(占槽词缀)」: templateId + attributes[]（已剔除核心属性与隐藏标记）
function extractItem(el) {
  if (!el || !el.children) return null;
  const tpl = childVal(el, 'ItemTemplateID');
  if (!tpl || tpl === 'None' || tpl === '') return null;
  const attrsEl = getChild(el, 'AttributeStates');
  const attributes = [];
  if (attrsEl && attrsEl.children) {
    for (const a of attrsEl.children) {
      const id = childVal(a, 'AttributeTemplateID');
      const pos = childVal(a, 'ValuePositionInRange');
      if (id && isAffixAttr(id)) attributes.push({ id, position: pos });
    }
  }
  return { templateId: tpl, attributes };
}

function extractCategory(inv, catName) {
  const cat = getChild(inv, catName);
  if (!cat || !cat.children) return [];
  const out = [];
  for (const el of cat.children) {
    const it = extractItem(el);
    if (it) out.push(it);
  }
  return out;
}

const MODULE_CATS = ['EnergyCores', 'Sensors', 'Shields', 'CargoUnits', 'Platings', 'thrusters'];

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
    if (tpl && tpl !== 'None' && tpl !== '') { idx = i; break; }
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
      isCurrent: i === idx,
    });
  }

  const selPrimary = childVal(ship, 'SelectedPrimaryIndex');
  const selSecondary = childVal(ship, 'SelectedSecondaryIndex');
  const selConsumable = childVal(ship, 'SelectedConsumableIndex');

  const modules = {};
  for (const c of MODULE_CATS) modules[c] = extractCategory(inv, c);

  const result = {
    _meta: {
      saveFile: path.basename(savePath),
      engine: 'UE ' + g.info.engine.slice(0, 3).join('.'),
      generatedAt: new Date().toISOString(),
      note: '每件装备仅输出 templateId + 附加属性(attributes)。attributes 采用负向剔除：去掉各品类固有核心属性(weapon_*/secondary_*/device_*/sensor_range_*/energy_core_regen_*/shield 基础值/cargo_slots_buff/armor 等)与隐藏标记(no_random_drop/min_level/blueprintable/item_price/ascendant_rank 等)，其余全部视为占槽附加词缀，覆盖传说特效(legendary_*)、导弹专属词缀、okkar 催化剂增益、all_modules_*、*_buff 等。.position 为 0~1 归一化位置，非真实数值。携带货物(cargo)固定为空数组。',
    },
    currentShip: {
      index: idx,
      templateId: shipTpl,
      selected: { primaryWeapon: selPrimary, secondaryWeapon: selSecondary, consumable: selConsumable },
      loadout: {
        primaryWeapons: extractCategory(inv, 'PrimaryWeapons'),
        secondaryWeapons: extractCategory(inv, 'SecondaryWeapons'),
        modules,
        devices: extractCategory(inv, 'Devices'),
        cargo: [],
      },
    },
    ships: shipSummary,
  };

  return result;
}

