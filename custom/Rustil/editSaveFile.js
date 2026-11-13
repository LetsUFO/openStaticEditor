#!/usr/bin/env node
'use strict';
/**
 * Rustil: Eternal Labyrinth Castle —— 配置驱动的存档回写脚本（Node.js，零依赖）
 *
 * 配置文件结构（示例见 Desktop/data.json）：
 *   {
 *     "MainWeapon": { "Enhancement": 999, "MaxEnhancement": 999, "Insured": true },
 *     "Armor":      { "Enhancement": 143, "MaxEnhancement": 999, "Insured": true },
 *     "Otomo1":     { "EnemyID": 86, "Str": 9999, "Int": 9999, "Vit": 16, "Men": 166 },
 *     ...
 *     "Sub1":       { "EnemyID": 111, "Str": 9999, "Int": 9999, "Vit": 9999, "Men": 9999 }
 *   }
 *
 * 映射规则：
 *   装备槽  MainWeapon=0, SubWeapon0..4=1..5, Shield=6, Armor=7, Accessory0/1=8/9
 *           通过 Equipment.EquipGuids[n] 的 GUID 去 references.RefIds 找实例
 *   伙伴槽  Otomo1/2 = Familiar.Otomos[0/1]，Sub1..5 = Familiar.Subs[0..4]
 *           通过 GUID 去 Familiar.Familiars 找对象，写 IndividualDiferenceParam
 *   EnemyID 默认只作校验键，防止编成变动后把数值写到错误的伙伴身上
 *
 * 用法：
 *   node write_save.js                                  # 预演（默认，不写任何文件）
 *   node write_save.js --config D:\data.json            # 指定配置
 *   node write_save.js --apply                         # 真正写回主档（自动备份）
 *   node write_save.js --emit out.svd                   # 只导出加密产物，不动主档
 *   node write_save.js --ignore-enemy-id               # 忽略 EnemyID 校验（仍不改 EnemyID）
 *   node write_save.js --set-enemy-id                  # 连 EnemyID 一起写（换物种有配套数据风险）
 *   node write_save.js --dump-plain out.json            # 导出修改后的明文，便于人工检查
 *   node write_save.js --save <path> --force           # 指定存档 / 跳过安全检查
 *
 * 前置条件：游戏完全退出、4 个中断档为空，否则退出游戏时会把改动覆盖掉。
 * 加密：AES-128-CBC / PKCS7，Key = IV = ASCII "rustil20210401kd"。
 * 修改方式：保留原始单行程文本，只替换目标字段的值片段 —— rid 顺序、字段顺序、格式完全不动。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const KEY = Buffer.from('rustil20210401kd', 'ascii');
const WORK_DIR = __dirname;
const DEFAULT_SAVE = path.join(os.homedir(), 'AppData', 'LocalLow', 'KTMG_LLC', 'Rustil_ELC', 'rstl_stm.svd');
const DEFAULT_CONFIG = path.join(os.homedir(), 'Desktop', 'data.json');
const INTERRUPT_FILES = ['rstl_isd', 'rstl_isdBU', 'rstl_isdtemp', 'rstl_isdtempBU'];

const EQUIP_SLOTS = {
  MainWeapon: 0,
  SubWeapon0: 1, SubWeapon1: 2, SubWeapon2: 3, SubWeapon3: 4, SubWeapon4: 5,
  Shield: 6, Armor: 7, Accessory0: 8, Accessory1: 9
};
const EQUIP_FIELDS = ['Enhancement', 'MaxEnhancement', 'Insured'];
const FAMILIAR_SLOTS = {
  Otomo1: ['Otomos', 0], Otomo2: ['Otomos', 1],
  Sub1: ['Subs', 0], Sub2: ['Subs', 1], Sub3: ['Subs', 2], Sub4: ['Subs', 3], Sub5: ['Subs', 4]
};
const FAMILIAR_FIELDS = ['Str', 'Int', 'Vit', 'Men'];

// ---------------------------------------------------------------- CLI
function parseArgs(argv) {
  const flags = new Set(['apply', 'ignore-enemy-id', 'set-enemy-id', 'force', 'help']);
  const opts = {
    config: DEFAULT_CONFIG, save: DEFAULT_SAVE, apply: false, emit: null,
    dumpPlain: null, ignoreEnemyId: false, setEnemyId: false, force: false, help: false
  };
  const keyOf = {
    '--config': 'config', '--save': 'save', '--emit': 'emit', '--dump-plain': 'dumpPlain'
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (keyOf[a]) {
      if (i + 1 >= argv.length) fail(`参数 ${a} 缺少取值`);
      opts[keyOf[a]] = argv[++i];
      continue;
    }
    if (a === '--apply') { opts.apply = true; continue; }
    if (a === '--ignore-enemy-id') { opts.ignoreEnemyId = true; continue; }
    if (a === '--set-enemy-id') { opts.setEnemyId = true; continue; }
    if (a === '--force') { opts.force = true; continue; }
    fail(`未知参数: ${a}`);
  }
  if (opts.setEnemyId && opts.ignoreEnemyId) fail('--set-enemy-id 与 --ignore-enemy-id 不能同时使用');
  if (opts.apply && opts.emit) fail('--apply 与 --emit 不能同时使用');
  return opts;
}
function fail(msg) { throw new Error(msg); }

// ---------------------------------------------------------------- 加解密
function decrypt(buf) {
  const d = crypto.createDecipheriv('aes-128-cbc', KEY, KEY);
  return Buffer.concat([d.update(buf), d.final()]).toString('utf8');
}
function encrypt(text) {
  const c = crypto.createCipheriv('aes-128-cbc', KEY, KEY);
  return Buffer.concat([c.update(Buffer.from(text, 'utf8')), c.final()]);
}

// ---------------------------------------------------------------- 带位置的 JSON 解析
/** 解析紧凑 JSON，同时保留每个值节点在原文中的 [start, end)，用于做最小文本替换。 */
function parseWithSpans(src) {
  let i = 0;
  const n = src.length;
  const ws = () => { while (i < n && /[\s]/.test(src[i])) i++; };

  function scanString() {
    const start = i++;
    let out = '';
    while (i < n) {
      const c = src[i++];
      if (c === '\\') {
        const e = src[i++];
        if (e === 'u') { out += String.fromCharCode(parseInt(src.slice(i, i + 4), 16)); i += 4; }
        else out += ({ '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' })[e] || e;
      } else if (c === '"') break;
      else out += c;
    }
    return { type: 'string', start, end: i, value: out };
  }

  function scanNode() {
    ws();
    const start = i;
    const c = src[i];
    if (c === '{') {
      i++; ws();
      const props = new Map(), value = {};
      if (src[i] === '}') { i++; return { type: 'object', start, end: i, value, props }; }
      for (;;) {
        ws();
        if (src[i] !== '"') throw new Error(`对象键缺失，偏移 ${i}`);
        const k = scanString().value;
        ws();
        if (src[i++] !== ':') throw new Error(`冒号缺失，偏移 ${i - 1}`);
        const v = scanNode();
        props.set(k, v); value[k] = v.value;
        ws();
        if (src[i] === ',') { i++; continue; }
        if (src[i] === '}') { i++; break; }
        throw new Error(`对象分隔符错误，偏移 ${i}`);
      }
      return { type: 'object', start, end: i, value, props };
    }
    if (c === '[') {
      i++; ws();
      const items = [];
      if (src[i] === ']') { i++; return { type: 'array', start, end: i, value: [], items }; }
      for (;;) {
        items.push(scanNode());
        ws();
        if (src[i] === ',') { i++; continue; }
        if (src[i] === ']') { i++; break; }
        throw new Error(`数组分隔符错误，偏移 ${i}`);
      }
      return { type: 'array', start, end: i, value: items.map(x => x.value), items };
    }
    if (c === '"') return scanString();
    let j = i;
    while (j < n && !',]} \t\r\n'.includes(src[j])) j++;
    const raw = src.slice(i, j); i = j;
    let value;
    if (raw === 'true') value = true;
    else if (raw === 'false') value = false;
    else if (raw === 'null') value = null;
    else if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(raw)) value = Number(raw);
    else throw new Error(`无法解析的字面量 ${JSON.stringify(raw)}，偏移 ${start}`);
    return { type: 'primitive', start, end: i, value, raw };
  }

  const root = scanNode();
  ws();
  if (i !== n) throw new Error(`JSON 末尾有多余内容，偏移 ${i}`);
  return root;
}

/** 按路径取节点，例如 at(root, ['Equipment', 'EquipGuids', 0]) */
function at(root, p) {
  let cur = root;
  for (const k of p) {
    if (typeof k === 'number') {
      if (cur.type !== 'array' || !cur.items[k]) fail(`路径 ${p.join('.')} 越界`);
      cur = cur.items[k];
    } else {
      if (cur.type !== 'object' || !cur.props.has(k)) fail(`路径 ${p.join('.')} 不存在`);
      cur = cur.props.get(k);
    }
  }
  return cur;
}
function guidHex(node) {
  if (!node || node.type !== 'object') fail('GUID 节点结构异常');
  const g = node.props.get('_serializedGuid');
  if (!g || g.type !== 'array' || g.items.length !== 16) fail('GUID 字节数组异常');
  return g.items.map(x => ((x.value & 0xff) + 0x100).toString(16).slice(-2).toUpperCase()).join('');
}

// ---------------------------------------------------------------- 目标定位
function findEquipData(root, slotIndex, fields) {
  const guid = guidHex(at(root, ['Equipment', 'EquipGuids', slotIndex]));
  const refs = at(root, ['references', 'RefIds']);
  let hit = null, hitIdx = -1;
  refs.items.forEach((e, idx) => {
    if (e.type !== 'object') return;
    const data = e.props.get('data');
    if (!data || data.type !== 'object' || !data.props.has('Guid')) return;
    if (guidHex(data.props.get('Guid')) !== guid) return;
    if (!fields.every(f => data.props.has(f))) return;
    if (hit) fail(`装备槽 ${slotIndex} 的 GUID ${guid} 匹配到多个实例`);
    hit = data; hitIdx = idx;
  });
  if (!hit) fail(`装备槽 ${slotIndex}（GUID ${guid}）在 RefIds 里找不到对应实例`);
  return { node: hit, guid, idx: hitIdx, path: `references.RefIds.${hitIdx}.data` };
}

function findFamiliar(root, listName, slotIndex) {
  const guid = guidHex(at(root, ['Familiar', listName, slotIndex]));
  const arr = at(root, ['Familiar', 'Familiars']);
  let hit = null, hitIdx = -1;
  arr.items.forEach((e, idx) => {
    if (e.type !== 'object' || !e.props.has('Guid')) return;
    if (guidHex(e.props.get('Guid')) !== guid) return;
    if (hit) fail(`伙伴 GUID ${guid} 重复`);
    hit = e; hitIdx = idx;
  });
  if (!hit) fail(`${listName}[${slotIndex}]（GUID ${guid}）在 Familiars 里找不到对象`);
  const idp = hit.props.get('IndividualDiferenceParam');
  if (!idp || idp.type !== 'object') fail(`${listName}[${slotIndex}] 缺少 IndividualDiferenceParam`);
  return {
    node: hit, idp, guid, idx: hitIdx,
    enemyId: hit.props.get('EnemyID')?.value,
    path: `Familiar.Familiars.${hitIdx}`
  };
}

// ---------------------------------------------------------------- 配置校验
function validateConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) fail('配置根节点必须是对象');
  const isInt = v => Number.isInteger(v);
  for (const [key, spec] of Object.entries(cfg)) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) fail(`${key} 必须是对象`);
    const equip = key in EQUIP_SLOTS;
    const fam = key in FAMILIAR_SLOTS;
    if (!equip && !fam) fail(`未知配置键 ${key}；可用键：${[...Object.keys(EQUIP_SLOTS), ...Object.keys(FAMILIAR_SLOTS)].join(', ')}`);
    const allowed = equip ? EQUIP_FIELDS : [...FAMILIAR_FIELDS, 'EnemyID'];
    for (const [f, v] of Object.entries(spec)) {
      if (!allowed.includes(f)) fail(`${key}.${f} 不是可写字段（允许：${allowed.join(', ')}）`);
      if (f === 'Insured') { if (typeof v !== 'boolean') fail(`${key}.Insured 必须是 true/false`); }
      else if (!isInt(v)) fail(`${key}.${f} 必须是整数，收到 ${JSON.stringify(v)}`);
    }
  }
}

// ---------------------------------------------------------------- 生成替换计划
function buildPlan(src, root, cfg, opts) {
  const reps = [], rows = [], expectPaths = new Set();

  function push(node, field, value, ctx) {
    const v = node.props.get(field);
    if (!v) fail(`${ctx.path} 缺少字段 ${field}`);
    if (typeof v.value !== typeof value) fail(`${ctx.path}.${field} 类型不符：存档 ${typeof v.value} / 配置 ${typeof value}`);
    const oldRaw = src.slice(v.start, v.end);
    const newRaw = JSON.stringify(value);
    if (oldRaw === newRaw) return;
    reps.push({ start: v.start, end: v.end, text: newRaw });
    rows.push({ ...ctx, field, old: v.value, now: value });
    expectPaths.add(`${ctx.path}.${field}`);
  }

  const mismatch = [];
  for (const [key, spec] of Object.entries(cfg)) {
    if (key in EQUIP_SLOTS) {
      const fields = Object.keys(spec);
      const t = findEquipData(root, EQUIP_SLOTS[key], fields);
      const ctx = { target: key, where: `槽${EQUIP_SLOTS[key]} rid${root.value.references.RefIds[t.idx].rid}`, guid: t.guid.slice(0, 12), path: t.path };
      for (const f of fields) push(t.node, f, spec[f], ctx);
    } else {
      const [list, idx] = FAMILIAR_SLOTS[key];
      const t = findFamiliar(root, list, idx);
      const ctx = { target: key, where: `${list}[${idx}]`, guid: t.guid.slice(0, 12), path: `${t.path}.IndividualDiferenceParam` };
      // EnemyID 默认只作校验：编成变动时避免把数值写错对象
      if (spec.EnemyID !== undefined && t.enemyId !== spec.EnemyID) {
        mismatch.push({ key, cfg: spec.EnemyID, save: t.enemyId, guid: t.guid.slice(0, 12) });
      }
      if (opts.setEnemyId && spec.EnemyID !== undefined) {
        const enemyNode = t.node.props.get('EnemyID');
        const oldRaw = src.slice(enemyNode.start, enemyNode.end);
        const newRaw = JSON.stringify(spec.EnemyID);
        if (oldRaw !== newRaw) {
          reps.push({ start: enemyNode.start, end: enemyNode.end, text: newRaw });
          rows.push({ ...ctx, field: 'EnemyID', old: t.enemyId, now: spec.EnemyID });
          expectPaths.add(`${t.path}.EnemyID`);
        }
      }
      for (const f of FAMILIAR_FIELDS) {
        if (spec[f] !== undefined) push(t.idp, f, spec[f], ctx);
      }
    }
  }
  return { reps, rows, expectPaths, mismatch };
}

/** 递归列出两份 JSON 的所有值差异路径，用来确认"只改了该改的字段"。 */
function diffPaths(a, b, prefix = '', out = []) {
  const ta = a === null ? 'null' : typeof a, tb = b === null ? 'null' : typeof b;
  if (ta !== tb || ta !== 'object') {
    if (a !== b) out.push({ path: prefix, from: a, to: b });
    return out;
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    diffPaths(a[k], b[k], prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

// ---------------------------------------------------------------- 安全检查
function gameRunning() {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return /Rustil_ELC\.exe/i.test(out);
    }
    const out = execFileSync('ps', ['-A', '-o', 'comm='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return /Rustil_ELC/i.test(out);
  } catch { return null; } // 无法判断
}
function interruptFiles(save) {
  const dir = path.dirname(save);
  return INTERRUPT_FILES
    .map(f => ({ name: f, size: fs.existsSync(path.join(dir, f)) ? fs.statSync(path.join(dir, f)).size : 0 }))
    .filter(x => x.size > 0);
}
function stamp() {
  const d = new Date(), p = x => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ---------------------------------------------------------------- 写回流程（CLI / 应用内共用）
function runWriteback(cfg, savePath, opts = {}) {
  if (!fs.existsSync(savePath)) fail(`存档不存在：${savePath}`);
  validateConfig(cfg);

  const src = decrypt(fs.readFileSync(savePath));
  const root = parseWithSpans(src);
  const { reps, rows, expectPaths, mismatch } = buildPlan(src, root, cfg, opts);

  console.log(`存档  : ${savePath}  (${fs.statSync(savePath).size} B)`);
  if (opts.config) console.log(`配置  : ${opts.config}`);
  console.log(`模式  : ${opts.apply ? '写回主档' : opts.emit ? '仅导出加密产物' : '预演（不写盘）'}`);
  console.log('');
  if (rows.length) {
    console.log('改动计划：');
    for (const r of rows) {
      console.log(`  ${r.target.padEnd(12)} ${r.where.padEnd(22)} ${r.guid}  ${r.field.padEnd(15)} ${JSON.stringify(r.old)} -> ${JSON.stringify(r.now)}`);
    }
  } else {
    console.log('改动计划：无（存档已与配置一致）');
  }
  console.log(`\n共 ${rows.length} 个字段变更，涉及 ${new Set(rows.map(r => r.path)).size} 个对象。`);

  if (mismatch.length) {
    console.log('\n[EnemyID 不一致] 配置与当前存档编成不符：');
    for (const m of mismatch) console.log(`  ${m.key.padEnd(8)} ${m.guid}  配置 ${m.cfg} / 存档 ${m.save}`);
    if (!opts.ignoreEnemyId && !opts.setEnemyId) {
      console.log('\n  默认拒绝写入，避免把数值写错伙伴。可用：');
      console.log('    --ignore-enemy-id  仍只写四维数值，不改物种');
      console.log('    --set-enemy-id     连 EnemyID 一并写入（换物种需自行处理配套数据）');
      fail('EnemyID 不一致，已拒绝写入');
    }
    console.log(`  → 已按 ${opts.setEnemyId ? '--set-enemy-id' : '--ignore-enemy-id'} 放行`);
  }

  // 按偏移倒序替换，保证前面的下标不失效
  reps.sort((a, b) => b.start - a.start);
  for (let k = 1; k < reps.length; k++) {
    if (reps[k].end > reps[k - 1].start) fail('替换区间重叠，已中止');
  }
  let dst = src;
  for (const r of reps) dst = dst.slice(0, r.start) + r.text + dst.slice(r.end);

  // 结构化 diff：除计划内字段外，全档必须完全一致
  const after = parseWithSpans(dst).value;
  const diffs = diffPaths(root.value, after);
  const unexpected = diffs.filter(d => !expectPaths.has(d.path));
  const missing = [...expectPaths].filter(p => !diffs.some(d => d.path === p));
  console.log(`\n全量差分：实际 ${diffs.length} 处 / 计划 ${expectPaths.size} 处，越界 ${unexpected.length} 处，漏改 ${missing.length} 处`);
  if (unexpected.length || missing.length) {
    for (const d of unexpected) console.log(`  越界 ${d.path}: ${JSON.stringify(d.from)} -> ${JSON.stringify(d.to)}`);
    for (const p of missing) console.log(`  漏改 ${p}`);
    fail('差分校验失败，未写盘');
  }

  // 加解密内存回环自检（与 PowerShell 版 crypto 等价性）
  const enc = encrypt(dst);
  if (decrypt(enc) !== dst) fail('AES 回环自检失败');
  console.log(`AES 回环自检：OK（密文 ${enc.length} B）`);

  if (opts.dumpPlain) {
    fs.writeFileSync(opts.dumpPlain, Buffer.from(dst, 'utf8'));
    console.log(`明文已导出：${opts.dumpPlain}`);
  }

  const result = {
    savePath,
    bytes: enc.length,
    changes: rows,
    changeCount: rows.length,
    objectCount: new Set(rows.map(r => r.path)).size
  };
  if (!opts.apply && !opts.emit) {
    console.log('\n预演结束，未修改任何存档文件。要落盘请加 --apply（先退出游戏）。');
    return { ...result, write: false };
  }

  // ---- 落盘前置检查（仅写回主档时需要；--emit 只是导出文件） ----
  if (opts.apply) {
    if (!opts.force) {
      const running = gameRunning();
      if (running === true) fail('检测到 Rustil_ELC.exe 正在运行；请先完全退出游戏再写档，否则退出时会被内存回写覆盖');
      if (running === null) console.log('[警告] 无法查询进程列表，请自行确认游戏已退出');
      const isd = interruptFiles(savePath);
      if (isd.length) {
        console.log('[错误] 存在非空的中断档，游戏里有未结算的迷宫进度：');
        for (const f of isd) console.log(`  ${f.name}  ${f.size} B`);
        fail('请先在游戏内结算/清空中断档，或用 --force 强行写入');
      }
    } else {
      console.log('[警告] --force 已跳过进程与中断档检查');
    }
  }

  if (opts.emit) {
    fs.writeFileSync(opts.emit, enc);
    if (decrypt(fs.readFileSync(opts.emit)) !== dst) fail('导出产物回读失败');
    console.log(`\n加密产物已导出并回读验证：${opts.emit}（主档未动）`);
    return { ...result, write: true, emitPath: opts.emit };
  }

  const bakDir = path.join(WORK_DIR, '_backup');
  fs.mkdirSync(bakDir, { recursive: true });
  const bak = path.join(bakDir, `rstl_stm_before_write_${stamp()}.svd`);
  fs.copyFileSync(savePath, bak);

  const tmp = path.join(WORK_DIR, `rstl_stm_write_${stamp()}.svd`);
  fs.writeFileSync(tmp, enc);
  if (decrypt(fs.readFileSync(tmp)) !== dst) fail('临时加密产物回读失败，主档未动');
  fs.copyFileSync(tmp, savePath);
  if (decrypt(fs.readFileSync(savePath)) !== dst) fail('磁盘回读失败，请从备份恢复');
  fs.unlinkSync(tmp);

  console.log(`\n写回完成：${savePath}  (${fs.statSync(savePath).size} B)`);
  console.log(`备份    ：${bak}`);
  console.log('验证    ：临时产物回读 + 磁盘回读，两次与修改后明文逐字节一致');
  return { ...result, write: true, backupPath: bak };
}

// ---------------------------------------------------------------- CLI
function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    const m = fs.readFileSync(__filename, 'utf8').match(/\/\*\*([\s\S]*?)\*\//);
    console.log(m[1].split('\n').map(l => l.replace(/^ \* ?/, '')).join('\n').trim());
    return;
  }
  if (!fs.existsSync(opts.config)) fail(`配置不存在：${opts.config}`);
  const cfg = JSON.parse(fs.readFileSync(opts.config, 'utf8'));
  runWriteback(cfg, opts.save, opts);
}

// ---------------------------------------------------------------- 应用内入口
/** 只提取界面允许编辑的字段，忽略 enemyIdMap、_passiveEffectList 等只读数据。 */
function pickWritableConfig(data) {
  const cfg = {};
  for (const key of [...Object.keys(EQUIP_SLOTS), ...Object.keys(FAMILIAR_SLOTS)]) {
    const spec = data[key];
    if (spec == null) continue; // 空装备/伙伴槽不写入
    if (typeof spec !== 'object' || Array.isArray(spec)) fail(`${key} 必须是对象`);
    const fields = key in EQUIP_SLOTS ? EQUIP_FIELDS : [...FAMILIAR_FIELDS, 'EnemyID'];
    const picked = {};
    for (const field of fields) {
      if (Object.hasOwn(spec, field)) picked[field] = spec[field];
    }
    if (Object.keys(picked).length) cfg[key] = picked;
  }
  return cfg;
}

/**
 * 主进程 script:run 调用入口。
 * ctx = { data, filePath, dataKey, customDir, downloadsPath, documentsPath }
 * data 来自当前 store.fileData[dataKey]，filePath 是已解析的存档绝对路径。
 */
function saveFromData(ctx = {}) {
  if (!ctx.data || typeof ctx.data !== 'object' || Array.isArray(ctx.data)) {
    fail('缺少有效的 ctx.data（请先加载存档）');
  }
  if (!ctx.filePath || typeof ctx.filePath !== 'string') {
    fail('缺少 ctx.filePath（请先加载要写回的存档）');
  }
  const cfg = pickWritableConfig(ctx.data);
  if (!Object.keys(cfg).length) fail('ctx.data 中没有可保存的字段');
  const result = runWriteback(cfg, ctx.filePath, { apply: true });
  return {
    ok: true,
    savePath: result.savePath,
    bytes: result.bytes,
    backupPath: result.backupPath,
    changeCount: result.changeCount,
    objectCount: result.objectCount,
    changes: result.changes
  };
}

module.exports = saveFromData;

if (require.main === module) {
  try { main(); } catch (e) {
    console.error(`[失败] ${e.message}`);
    process.exitCode = 1;
  }
}
