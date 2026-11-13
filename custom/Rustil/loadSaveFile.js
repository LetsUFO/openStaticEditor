#!/usr/bin/env node
'use strict';
/**
 * Rustil: Eternal Labyrinth Castle —— 存档解析脚本
 *
 * 存档格式：AES-128-CBC，Key = IV = ASCII "rustil20210401kd"，PKCS7 填充，
 *           明文是 Newtonsoft.Json 的 JSON（含 references.RefIds 引用表）。
 * 输出格式：与桌面 data.json 一致（扁平 9 键 / 纯英文字段名 / 词条精简）。
 *
 * 模块用法（由主进程 file:read 调用，数据写入 store）：
 *   module.exports = function (ctx) {
 *     // ctx.fileSrc       —— config.json 里配置的原始文件路径
 *     // ctx.filePath      —— 主进程解析后的存档绝对路径
 *     // ctx.customDir     —— custom 目录绝对路径
 *     // ctx.downloadsPath —— 系统下载目录绝对路径
 *     // ctx.documentsPath —— 系统文档目录绝对路径
 *     // return 解析后的数据对象
 *   }
 *
 * 命令行用法（独立调试，不走 store）：
 *   node loadSaveFile.js <存档路径>              # 解析指定存档，JSON 打印到 stdout
 *   node loadSaveFile.js <存档路径> -o <输出路径> # 写入文件（已存在则先留一份 .bak）
 *   node loadSaveFile.js --help
 *
 * 零依赖，仅使用 Node 内置模块。只读取存档，不会修改游戏文件。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const KEY = Buffer.from('rustil20210401kd', 'ascii');

// EquipGuids 的槽位下标：0 = 主武器，7 = 铠甲
const EQUIP_SLOTS = [
	['MainWeapon', 0],
	['Armor', 7]
];
const STAT_FIELDS = ['Str', 'Int', 'Vit', 'Men'];

// 少数效果类不走 { _value } 容器，直接存标量（如 Buff_RegeneHP）
const PLAIN_VALUE_FIELDS = new Set(['_recoveryValue', '_recoveryPer', '_interval']);

// JS 不区分 int / float，JSON.stringify(1.0) 会写成 1。
// 这些字段在参考 data.json 里是浮点字面量（_interval: 1.0），用 rawJSON 保真。
const FLOAT_LITERAL_FIELDS = new Set(['_interval']);

const USAGE = `用法:
  node loadSaveFile.js <存档路径> [-o 输出路径]

不指定 -o 时把结果 JSON 打印到 stdout；指定 -o 时写入文件，若目标已存在
且同名 .bak 不存在，会先把原文件复制为 <输出路径>.bak。`;

/* ------------------------------------------------------------------ */
/* 解密                                                                */
/* ------------------------------------------------------------------ */

function decrypt(buffer) {
	if (!buffer.length || buffer.length % 16 !== 0) {
		throw new Error(`密文长度 ${buffer.length} 不是 16 的倍数，可能不是有效的 .svd 存档`);
	}
	let plain;
	try {
		const decipher = crypto.createDecipheriv('aes-128-cbc', KEY, KEY);
		plain = Buffer.concat([decipher.update(buffer), decipher.final()]).toString('utf8');
	} catch (err) {
		throw new Error(`AES 解密失败（密钥/文件不匹配或文件损坏）：${err.message}`);
	}
	return plain.replace(/^\uFEFF/, ''); // 去掉可能的 UTF-8 BOM
}

/* ------------------------------------------------------------------ */
/* 存档引用表                                                          */
/* ------------------------------------------------------------------ */

// GUID 在存档里是 { _serializedGuid: [16 个字节] }，统一转成 hex 字符串做键
function guidKey(guid) {
	if (!guid) return '';
	const bytes = Array.isArray(guid) ? guid : guid._serializedGuid;
	if (Array.isArray(bytes)) {
		return bytes.map((b) => (b & 0xff).toString(16).padStart(2, '0')).join('');
	}
	if (typeof bytes === 'string') return bytes.replace(/-/g, '').toLowerCase();
	return '';
}

class SaveIndex {
	constructor(save) {
		const refs = save.references?.RefIds;
		if (!Array.isArray(refs)) throw new Error('存档缺少 references.RefIds，结构不符');

		this.byRid = new Map(refs.map((e) => [Number(e.rid), e]));
		this.byGuid = new Map();
		for (const e of refs) {
			const key = guidKey(e.data?.Guid);
			if (!key) continue;
			if (!this.byGuid.has(key)) this.byGuid.set(key, []);
			this.byGuid.get(key).push(e);
		}

		this.famByGuid = new Map((save.Familiar?.Familiars ?? []).map((f) => [guidKey(f.Guid), f]));
	}

	// 兼容 { rid: N } / { $ref: N } / 已内嵌对象
	resolve(ref) {
		if (!ref) return null;
		const rid = ref.rid ?? ref.$ref;
		if (rid == null) return ref;
		return this.byRid.get(Number(rid)) ?? null;
	}

	// 同一 GUID 可能对应多个条目，优先取带 Enhancement 的装备实例
	findItem(guid) {
		const hits = this.byGuid.get(guidKey(guid)) ?? [];
		return hits.find((e) => e.data && Object.hasOwn(e.data, 'Enhancement')) ?? hits[0] ?? null;
	}

	findFamiliar(guid) {
		return this.famByGuid.get(guidKey(guid)) ?? null;
	}
}

/* ------------------------------------------------------------------ */
/* 字段提取                                                            */
/* ------------------------------------------------------------------ */

const stripTags = (s) => s.replace(/<[^>]*>/g, '').trim();

// 词条：只保留原生文案（去富文本标签、改单数字段）与真正生效的数值
function trimAffix(entry) {
	const src = entry?.data ?? {};
	const data = {};

	const desc = src.EffectDescriptionStringList;
	const raw = Array.isArray(desc)
		? desc.find((s) => typeof s === 'string' && s.trim())
		: typeof desc === 'string' && desc.trim()
			? desc
			: null;
	if (raw) data.EffectDescriptionString = stripTags(raw);

	for (const [key, value] of Object.entries(src)) {
		if (key === 'EffectDescriptionStringList') continue;
		if (
			value &&
			typeof value === 'object' &&
			!Array.isArray(value) &&
			Object.hasOwn(value, '_value')
		) {
			data[key] = { _value: value._value }; // FloatEx / IntEx 包装值
		} else if (PLAIN_VALUE_FIELDS.has(key)) {
			data[key] = value; // 无容器的标量参数
		}
		// 其余为元数据：_uniqueID / _disableVFX / _duration / Guid / 抽值范围等，一律丢弃
	}

	return { class: entry?.type?.class ?? null, data };
}

function readEquip(save, index, slot) {
	const guid = save.Equipment?.EquipGuids?.[slot];
	const entry = index.findItem(guid);
	if (!entry) {
		console.error(`警告：EquipGuids[${slot}] 未找到对应装备实例，输出 null`);
		return null;
	}
	const item = entry.data;

	let mgr = index.resolve(item.BuffMgr) ?? item.BuffMgr;
	mgr = mgr?.data ?? mgr;
	const affixes = (mgr?._passiveEffectList ?? [])
		.map((ref) => index.resolve(ref))
		.filter(Boolean)
		.map(trimAffix);

	return {
		Enhancement: item.Enhancement,
		MaxEnhancement: item.MaxEnhancement,
		_passiveEffectList: affixes,
		Insured: item.Insured
	};
}

function readFamiliar(index, guid) {
	const f = index.findFamiliar(guid);
	if (!f) {
		console.error('警告：编成中的使魔 GUID 在 Familiars 里找不到，输出 null');
		return null;
	}
	const p = f.IndividualDiferenceParam ?? {};
	const out = { EnemyID: f.EnemyID };
	for (const key of STAT_FIELDS) out[key] = p[key];
	return out;
}

function parseSave(save) {
	const index = new SaveIndex(save);
	const result = {};

	for (const [name, slot] of EQUIP_SLOTS) result[name] = readEquip(save, index, slot);

	(save.Familiar?.Otomos ?? []).forEach((g, i) => {
		result[`Otomo${i + 1}`] = readFamiliar(index, g);
	});
	(save.Familiar?.Subs ?? []).forEach((g, i) => {
		result[`Sub${i + 1}`] = readFamiliar(index, g);
	});

	return result;
}

/* ------------------------------------------------------------------ */
/* 加载与解析                                                          */
/* ------------------------------------------------------------------ */

/**
 * 读取并解析存档，返回扁平数据对象。
 * 模块导出与 CLI 共用此函数。
 * @param {string} savePath 存档文件绝对路径
 * @returns {object} 解析后的数据
 */
function loadSave(savePath) {
	if (!savePath) throw new Error('未指定存档文件路径 (ctx.filePath)');
	if (!fs.existsSync(savePath)) {
		throw new Error(`找不到存档：${savePath}`);
	}
	const buffer = fs.readFileSync(savePath);
	const text = decrypt(buffer);
	const save = JSON.parse(text);
	return parseSave(save);
}

const replacer = (key, value) => {
	if (FLOAT_LITERAL_FIELDS.has(key) && typeof value === 'number' && Number.isInteger(value)) {
		return typeof JSON.rawJSON === 'function' ? JSON.rawJSON(`${value}.0`) : value;
	}
	return value;
};

const ENEMY_JSON = 'enemy.json';

/**
 * 读取 custom 目录下的 enemy.json，返回 { enemyIdMap: {...} }。
 * 文件缺失时不报错（只是没有映射表）。
 */
function loadEnemyMap(customDir) {
	if (!customDir) return null;
	const p = path.join(customDir, ENEMY_JSON);
	if (!fs.existsSync(p)) return null;
	try {
		const raw = fs.readFileSync(p, 'utf-8');
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

/**
 * 应用内调用入口（主进程 file:read 把本模块当函数调用）。
 * ctx.filePath —— 渲染进程解析 %download% / %user% 等简写后的存档绝对路径
 * ctx.customDir —— custom/Rustil/ 目录绝对路径（用来读 enemy.json 等辅助数据）
 * 返回解析后的数据对象，由主进程回传给渲染进程写入 store。
 */
function run(ctx = {}) {
	const result = loadSave(ctx.filePath);
	const enemyMap = loadEnemyMap(ctx.customDir);
	if (enemyMap) result.enemyIdMap = enemyMap;
	return result;
}

/* ------------------------------------------------------------------ */
/* CLI（独立调试用）                                                    */
/* ------------------------------------------------------------------ */

function main(argv) {
	const args = argv.slice(2);
	if (args.includes('-h') || args.includes('--help')) {
		console.log(USAGE);
		return;
	}

	let savePath = null;
	let outPath = null;
	const positional = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '-o' || args[i] === '--out') {
			outPath = args[++i];
			if (!outPath) throw new Error('-o 后面缺少输出路径');
		} else {
			positional.push(args[i]);
		}
	}
	savePath = positional[0];
	if (positional[1] && !outPath) outPath = positional[1];

	const result = loadSave(savePath);
	const json = JSON.stringify(result, replacer, '\t') + '\n';

	console.error(`存档：${savePath}`);

	if (outPath) {
		const target = path.resolve(outPath);
		if (fs.existsSync(target) && !fs.existsSync(`${target}.bak`)) {
			fs.copyFileSync(target, `${target}.bak`);
			console.error(`原输出文件已备份为 ${target}.bak`);
		}
		fs.writeFileSync(target, json, 'utf8');
		console.error(`已写入 ${target}`);
	} else {
		process.stdout.write(json);
	}
}

if (require.main === module) {
	try {
		main(process.argv);
	} catch (err) {
		console.error(`错误：${err.message}`);
		process.exitCode = 1;
	}
}

module.exports = run;
