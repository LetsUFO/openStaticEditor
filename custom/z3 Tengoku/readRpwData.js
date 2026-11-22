'use strict';
/**
 * 第3次超级机器人大战Z：天狱篇 —— RPW_DATA.CPK 读取脚本
 *
 * 由主进程 file:read 调用（config.json -> loadFiles.RPW_DATA.readScript）。
 *
 * 执行流程：
 *   1. 拿到 ctx.filePath（用户在加载页输入 / 选择的游戏目录）
 *   2. 在该目录里查找 RPW_DATA.CPK
 *   3. 恰好找到唯一一个 → 把它的绝对路径赋值给 ctx.fileSrc
 *   4. 执行加载方法 loadFile(ctx)：CRILAYLA 解压 → 解析 <mt> 容器 → 提取零件参数表
 * 没找到或找到多个都抛错，提示重新选择游戏目录。
 *
 * 返回数据（由 App.vue 写入 store）：{ fileSrc, size, partList }
 * 同时把解析出的零件参数表写入同级目录的 partData.json，便于核对。
 *
 * 注意：ctx.filePath 可能来自界面手动输入，斜杠方向不确定，统一用 path.normalize 归一。
 */

const fs = require('node:fs');
const path = require('node:path');

const TARGET_NAME = 'rpw_data.cpk';
const ERROR_MESSAGE = '请重新选择正确的游戏目录，里面因该只包含一个RPW_DATA.CPK文件';
// 零件下拉选项表，与本脚本同目录
const PART_LIST_FILE = path.join(__dirname, 'partList.json');
// 解析出的零件参数表，输出到同目录（便于核对）
const PART_DATA_FILE = path.join(__dirname, 'partData.json');

/* ------------------------------------------------------------------ */
/* 零件表定位与解析                                                    */
/* ------------------------------------------------------------------ */

// boost-p 零件表：79 条记录（0 号为占位），每条 84 字节，1..78 对应 partList
const PART_RECORD_SIZE = 84;
const PART_COUNT = 78;

/**
 * CRILAYLA 解压。算法要点：
 *   - 头部 16 字节后是 bit 流，从流尾部向前、逐字节、字节内高位优先读取
 *   - 首字节头的后 0x100 字节是预置字典，整体输出从末尾向 0x100 倒序写入
 *   - 1 bit = 匹配（13bit 距离 + 3，长度按 [2,3,5,8] 变长扩展）；0 bit = 8bit 字面量
 * @param {Buffer} file 已定位到 'CRILAYLA' 魔数的整个文件
 * @returns {Buffer} 解压后的数据
 */
function decompressCrilayla(file) {
	const magic = file.indexOf('CRILAYLA');
	if (magic < 0) throw new Error('RPW_DATA.CPK 格式不符：找不到 CRILAYLA 压缩块');

	const block = file.subarray(magic);
	const usize = block.readUInt32LE(8); // 解压后长度
	const hoff = block.readUInt32LE(12); // 字典头偏移
	if (!usize || usize > file.length * 64) throw new Error('RPW_DATA.CPK 格式不符：解压长度异常');

	const out = Buffer.alloc(usize + 0x100);
	block.copy(out, 0, hoff + 0x10, hoff + 0x10 + 0x100);

	let pos = block.length - 0x100 - 1; // 从 bit 流末尾往前读
	let pool = 0;
	let left = 0;
	const bits = (k) => {
		let v = 0;
		let got = 0;
		while (got < k) {
			if (left === 0) {
				pool = pos >= 0 ? block[pos] : 0;
				left = 8;
				pos--;
			}
			const take = Math.min(left, k - got);
			v = (v << take) | ((pool >>> (left - take)) & ((1 << take) - 1));
			left -= take;
			got += take;
		}
		return v;
	};

	const end = 0x100 + usize - 1;
	let done = 0;
	while (done < usize) {
		if (bits(1)) {
			// 匹配：距离 + 变长长度；引用位置向低位递减
			let ref = end - done + bits(13) + 3;
			let len = 3;
			let full = true;
			for (const w of [2, 3, 5, 8]) {
				const t = bits(w);
				len += t;
				if (t !== (1 << w) - 1) {
					full = false;
					break;
				}
			}
			if (full) {
				for (;;) {
					const t = bits(8);
					len += t;
					if (t !== 255) break;
				}
			}
			for (let i = 0; i < len && done < usize; i++) {
				out[end - done] = out[ref];
				ref--;
				done++;
			}
		} else {
			out[end - done] = bits(8);
			done++;
		}
	}
	return out;
}

/** 从解压数据里定位 boost-p 零件表，返回其数据区起始下标与长度 */
function locatePartTable(data) {
	const nameAt = data.indexOf('boost-p\0');
	if (nameAt < 0) throw new Error('RPW_DATA.CPK 格式不符：找不到 boost-p 零件表');
	// 布局：<chunk-head>(12) + 名称(8) + 总长 u32 + 数据长 u32，数据区在名称后 16 字节
	const length = data.readUInt32LE(nameAt + 12);
	return { start: nameAt + 16, length };
}

/** 按 partParam.json 的顺序读取一条零件记录的 33 个参数 */
function readPartParams(rec, id, name) {
	return {
		id,
		name,
		damageRate: rec.readUInt16LE(40),
		reserved: rec.readUInt16LE(42),
		attack: rec.readUInt16LE(44),
		willReq: rec.readUInt16LE(46),
		hp: rec.readUInt16LE(48),
		en: rec.readUInt16LE(50),
		armor: rec.readUInt16LE(52),
		price: rec.readUInt16LE(54),
		category: rec[56],
		move: rec[57],
		mobility: rec[58],
		accuracy: rec[59],
		afterimageRate: rec[60],
		hpRecover: rec[61],
		enRecover: rec[62],
		ammoRecover: rec[63],
		moveType: rec[64],
		terrainAdapt: rec[65],
		barrier: rec[66],
		specialAbility: rec[67],
		crit: rec[68],
		range: rec[69],
		rangeApply: rec[70],
		sizeIgnore: rec[71],
		sortieWill: rec[72],
		sortieSpFull: rec[73],
		rewardRate: rec[74],
		passive: rec[75],
		itemEffect: rec[76],
		spRecover: rec[77],
		itemSpecial: rec[78],
		procRate: rec[79],
		effectGroup: rec[80]
	};
}

/**
 * 解析全部零件参数。
 * @param {Buffer} data 解压后的 <mt> 容器数据
 * @param {{label:string,value:number}[]} partList 零件下拉表
 * @returns {object[]} 与 partList 对应的零件参数数组
 */
function parseParts(data, partList) {
	const { start, length } = locatePartTable(data);
	if (length < (PART_COUNT + 1) * PART_RECORD_SIZE) {
		throw new Error('RPW_DATA.CPK 格式不符：boost-p 零件表长度异常');
	}
	const nameById = new Map(partList.map((li) => [li.value, li.label]));
	const parts = [];
	for (let r = 1; r <= PART_COUNT; r++) {
		const off = start + r * PART_RECORD_SIZE;
		const rec = data.subarray(off, off + PART_RECORD_SIZE);
		const id = rec.readUInt32LE(36);
		if (id < 1 || id > PART_COUNT) continue;
		parts.push(readPartParams(rec, id, nameById.get(id) ?? ''));
	}
	return parts;
}

/**
 * 精简零件参数：id/name 始终保留，其余仅保留非 0 的有效字段。
 * @param {Record<string, any>} part
 */
function compactPart(part) {
	const out = { id: part.id };
	if (part.name) out.name = part.name;
	for (const [key, value] of Object.entries(part)) {
		if (key === 'id' || key === 'name') continue;
		if (value) out[key] = value;
	}
	return out;
}

/* ------------------------------------------------------------------ */
/* 目录定位                                                            */
/* ------------------------------------------------------------------ */

/**
 * 递归收集 dir 下所有 RPW_DATA.CPK 的绝对路径。
 * 目录不可读（不存在 / 无权限）时当作无匹配继续，最终由数量校验统一报错。
 */
function findTargets(dir, results) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			findTargets(full, results);
		} else if (entry.isFile() && entry.name.toLowerCase() === TARGET_NAME) {
			results.push(full);
		}
	}
}

/**
 * 在游戏目录里定位唯一的 RPW_DATA.CPK。
 * @param {string} dir 已规范化的游戏目录
 * @returns {string} RPW_DATA.CPK 的绝对路径
 */
function locateTarget(dir) {
	const found = [];
	findTargets(dir, found);
	// 0 个（没找到）或多个（目录不对 / 含多份）都视为目录选择有误
	if (found.length !== 1) throw new Error(ERROR_MESSAGE);
	return found[0];
}

/* ------------------------------------------------------------------ */
/* 加载                                                                */
/* ------------------------------------------------------------------ */

/**
 * 加载方法：用 ctx.fileSrc 读取并解析零件数据。
 * @param {{ fileSrc: string }} ctx
 */
function loadFile(ctx) {
	const buffer = fs.readFileSync(ctx.fileSrc);
	const partList = JSON.parse(fs.readFileSync(PART_LIST_FILE, 'utf8'));
	const decoded = decompressCrilayla(buffer);
	const partData = parseParts(decoded, partList).map(compactPart);
	fs.writeFileSync(PART_DATA_FILE, JSON.stringify(partData, null, '\t') + '\n', 'utf8');
	return { fileSrc: ctx.fileSrc, size: buffer.length, partList };
}

/**
 * @param {{ filePath?: string, fileSrc?: string }} ctx 主进程注入的上下文
 */
module.exports = function (ctx = {}) {
	const input =
		typeof ctx.filePath === 'string' ? ctx.filePath.trim().replace(/^"+|"+$/g, '') : '';
	if (!input) throw new Error(ERROR_MESSAGE);

	const dir = path.normalize(input);
	let stat;
	try {
		stat = fs.statSync(dir);
	} catch {
		throw new Error(ERROR_MESSAGE);
	}

	// filePath 首次加载时是游戏目录；重新加载时 fileSrc 已被回写成 CPK 文件本身
	let target;
	if (stat.isDirectory()) {
		// 1) 拿到 filePath 后在目录里找文件，确保只有唯一一个
		target = locateTarget(dir);
	} else if (stat.isFile() && path.basename(dir).toLowerCase() === TARGET_NAME) {
		target = dir;
	} else {
		throw new Error(ERROR_MESSAGE);
	}
	// 2) 把找到的文件地址赋值给 fileSrc
	ctx.fileSrc = target;
	// 3) 执行加载方法，传入 fileSrc 读取文件
	return loadFile(ctx);
};
