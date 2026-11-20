'use strict';

// EXVSFB (NPJB00512) RPCS3 修改器 — 强袭自由弹药锁（12 / 1 / 16）
//
// 实测数据（2026-11-19 现场内存确认，玩家机体基址 0x1DA0000）：
//   武器槽在 机体 +0x0BD8，每槽 0x20
//       槽 +0x00 武器ID   槽 +0x04 弹药（HUD 显示值）
//   每把武器另有一个真实状态块：
//       +0x00 武器ID  +0x04 弹药  +0x08 0  +0x0C 标记  +0x10 float 1.0
//       158 -> +0x3400C（弹药 +0x34010 = 12）
//       159 -> +0x34FA0（弹药 +0x34FA4 = 1）
//       160 -> +0x35F34（弹药 +0x35F38 = 16）
//
// 为什么不再「学习上限」：
//   v5/v6 靠观察满弹来学习，中途开过火就只能学到 8/6，随后把上限锁死，
//   真正的 12/16 永远学不到。这里直接按实测满弹值写死。
//
// 为什么不再写 0x10DB0 / 0x10E60 / 0x10F10：
//   这三个地址是「当前选中武器」的镜像，会随切枪指向不同武器；
//   v5 把它们统一写成主射上限，切枪后数值错乱。本版完全不碰它们。
//
// 写入频率 500Hz：低于 ~10Hz 时游戏会在空隙里把弹药扣到 0 进入装填。

const koffi = require('koffi');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { format } = require('util');

const BASE = 0x340000000;
const SIZE = 0x10000000;
const CHUNK = 1 << 22;

const OFF_HP = 0x164;
const OFF_BOOST = 0x998;
const OFF_EX = 0x9D8;
const OFF_UNIT_INDEX = 0x08;   // 单位索引：0 = 玩家，1+ = 队友/敌方
const HP_MAX_SANE = 5000;
const BOOST_MAX = 10000;
const EX_MAX = 100.0;

const OFF_WEAPON_BASE = 0x0BD8;
const WEAPON_SLOT_SIZE = 0x20;
const MAX_WEAPON_SLOTS = 6;
const SLOT_ID_OFFSET = 0x00;
const SLOT_AMMO_OFFSET = 0x04;

// 武器状态条目结构（经实机 hex dump 验证）：
//   +0x00: u32 BE 武器 ID
//   +0x04: u32 BE 当前弹药（游戏每发递减，且 2~3 份同步扣）
//   +0x08: u32 BE 可变标志位
//   +0x0C: u32 BE 每武器专属标记（从玩家 HUD 槽实时提取）
//          158→0xDEC8DE  159→0xFF91FF  160→0xFE6CFE 等
//   +0x10: float BE 装填进度（1.0 = 装填完成）
//
// 关键：游戏扣弹药时同时写 2~3 份（机体副本 + 全局状态），
// 必须把所有副本都补上满弹值才能顶住扣减。

// 强袭自由/海牛实测满弹值
const FULL_AMMO = new Map([
    [158, 12],
    [159, 1],
    [160, 16],
    [303, 12],   // 海牛（Hi-Nu）2 号武器 - 浮游炮，满弹 12
]);

const RELOAD_PROGRESS_OFFSET = 0x10;
const RELOAD_READY = 1.0;

const LOCK_INTERVAL_MS = 2;   // 500Hz
const RELOCATE_MS = 3000;    // 3 秒全扫一次（单次 ~2s）
const PID_CHECK_MS = 5000;

const PROCESS_VM_OPERATION = 0x0008;
const PROCESS_VM_WRITE = 0x0020;
const PROCESS_VM_READ = 0x0010;
const PROCESS_QUERY_INFORMATION = 0x0400;

let OpenProcess, ReadProcessMemory, WriteProcessMemory;
function initNative() {
    if (OpenProcess) return;
    const kernel32 = koffi.load('kernel32.dll');
    OpenProcess = kernel32.func(
        'void* __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)');
    ReadProcessMemory = kernel32.func(
        'int __stdcall ReadProcessMemory(void* process, uint64_t address, _Out_ void* buffer, size_t size, _Out_ size_t* read)');
    WriteProcessMemory = kernel32.func(
        'int __stdcall WriteProcessMemory(void* process, uint64_t address, const void* buffer, size_t size, _Out_ size_t* written)');
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hex = value => (value === null || value === undefined)
    ? 'null'
    : '0x' + value.toString(16).toUpperCase();
const u32be = value => {
    const b = Buffer.allocUnsafe(4);
    b.writeUInt32BE(value >>> 0, 0);
    return b;
};
const f32be = value => {
    const b = Buffer.allocUnsafe(4);
    b.writeFloatBE(value, 0);
    return b;
};

// ------------------------------------------------------------------ 日志
const LOG_FILE = path.join(__dirname, 'exvs_ammo.log');
function emit(line) { try { process.stdout.write(line + '\n'); } catch {} }
function log(...args) {
    const line = format(...args);
    emit(line);
    try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}
function logErr(...args) {
    const line = format(...args);
    emit(line);
    try { fs.appendFileSync(LOG_FILE, '[ERROR] ' + line + '\n'); } catch {}
}

// ------------------------------------------------------------------ 进程/内存
function findPid() {
    let out;
    try {
        out = execFileSync('tasklist', [
            '/FI', 'IMAGENAME eq rpcs3.exe', '/FO', 'CSV', '/NH'
        ], { encoding: 'utf8', windowsHide: true });
    } catch {
        return null;
    }
    for (const line of out.split(/\r?\n/)) {
        const parts = line.split('","').map(part => part.replace(/"/g, ''));
        if (parts.length >= 2 && parts[0].toLowerCase() === 'rpcs3.exe') {
            const pid = Number(parts[1]);
            if (Number.isInteger(pid)) return pid;
        }
    }
    return null;
}

class Mem {
    constructor(pid) {
        this.handle = OpenProcess(
            PROCESS_VM_OPERATION | PROCESS_VM_WRITE | PROCESS_VM_READ | PROCESS_QUERY_INFORMATION,
            0, pid);
        if (!this.handle) throw new Error('OpenProcess 失败, pid=' + pid);
    }
    read(address, size) {
        const buffer = Buffer.allocUnsafe(size);
        const read = [0];
        const ok = ReadProcessMemory(this.handle, address, buffer, size, read);
        if (!ok) return Buffer.alloc(0);
        return buffer.subarray(0, Number(read[0]));
    }
    write(address, data) {
        const written = [0];
        return Boolean(WriteProcessMemory(this.handle, address, data, data.length, written));
    }
}

// ------------------------------------------------------------------ 机体识别
function findUnits(mem) {
    const found = [];
    const prefix = Buffer.from([0x40, 0x06]);
    for (let off = 0; off < SIZE; off += CHUNK) {
        const data = mem.read(BASE + off, CHUNK);
        if (!data.length) continue;
        let i = 0;
        while ((i = data.indexOf(prefix, i)) >= 0) {
            if (i + 24 <= data.length &&
                    data.readUInt32BE(i + 4) === 1 &&
                    data.readUInt32BE(i + 8) === 1 &&
                    data.readUInt16BE(i + 20) === 0x4FFF) {
                found.push(BASE + off + i - 0x14);
            }
            i += 1;
        }
    }
    return found;
}

function unitValid(mem, unit) {
    const d = mem.read(unit + 0x14, 24);
    return d.length === 24 &&
        d.readUInt16BE(0) === 0x4006 &&
        d.readUInt32BE(4) === 1 &&
        d.readUInt32BE(8) === 1 &&
        d.readUInt16BE(20) === 0x4FFF;
}

function slotOneCandidate(mem, unit) {
    if (!unitValid(mem, unit)) return false;
    const hpData = mem.read(unit + OFF_HP, 4);
    if (hpData.length !== 4) return false;
    const hp = hpData.readUInt32BE(0);
    if (hp < 1 || hp > HP_MAX_SANE) return false;
    const boostData = mem.read(unit + OFF_BOOST, 4);
    if (boostData.length !== 4) return false;
    if (boostData.readUInt32BE(0) > BOOST_MAX) return false;
    const exData = mem.read(unit + OFF_EX, 4);
    if (exData.length !== 4) return false;
    const ex = exData.readFloatBE(0);
    if (!Number.isFinite(ex) || ex < 0 || ex > EX_MAX) return false;
    return true;
}

function pickPlayerUnit(mem, units) {
    for (const unit of units) {
        if (!slotOneCandidate(mem, unit)) continue;

        // 只接受索引 0 的单位（玩家自己），避免玩家换机体时把敌方同型机锁成无限弹药
        const idxData = mem.read(unit + OFF_UNIT_INDEX, 4);
        if (idxData.length !== 4) continue;
        if (idxData.readUInt32BE(0) === 0) return unit;
    }
    return null;
}

// 从玩家 HUD 槽提取每把武器的专属 +0x0C 标记
function extractIdToMark(mem, unit) {
    const map = new Map();
    for (let k = 0; k < MAX_WEAPON_SLOTS; k++) {
        const d = mem.read(unit + OFF_WEAPON_BASE + k * WEAPON_SLOT_SIZE, 0x20);
        if (d.length < 0x10) continue;
        const id = d.readUInt32BE(0);
        if (id === 0 || !FULL_AMMO.has(id)) continue;
        const mark = d.readUInt32BE(0x0C);
        if (mark !== 0) map.set(id, mark);
    }
    return map;
}

// 全内存扫描：对每把目标武器，用其专属 +0x0C 标记匹配所有副本
// 返回 Map<weaponId, [absAddr, absAddr, ...]>
function findAllWeaponEntries(mem, idToMark) {
    const entries = new Map();  // id -> [absAddr, ...]
    for (let gOff = 0; gOff < SIZE; gOff += CHUNK) {
        const data = mem.read(BASE + gOff, CHUNK);
        if (!data.length) continue;
        for (let i = 0; i + 0x14 <= data.length; i += 4) {
            const id = data.readUInt32BE(i);
            const expectedMark = idToMark.get(id);
            if (expectedMark === undefined) continue;
            if (data.readUInt32BE(i + 0x0C) !== expectedMark) continue;
            const ammo = data.readUInt32BE(i + 4);
            const full = FULL_AMMO.get(id);
            // 放宽 ammo 过滤：装填中=0 到满弹值的 3 倍
            if (ammo > full * 3) continue;
            const absAddr = BASE + gOff + i;
            if (!entries.has(id)) entries.set(id, []);
            const arr = entries.get(id);
            if (!arr.includes(absAddr)) arr.push(absAddr);
        }
    }
    return entries;
}

// ------------------------------------------------------------------ 主状态机
let running = false;
let currentRun = null;

async function run() {
    try { fs.appendFileSync(LOG_FILE, '\n===== 启动 ' + new Date().toLocaleTimeString() + ' =====\n'); } catch {}
    log('[ammo] 版本 = v9 专属标记多副本 (pid ' + process.pid + ')');
    log('[ammo] FULL_AMMO keys:', [...FULL_AMMO.keys()].join(','),
        'get(303)=', FULL_AMMO.get(303), 'has(303)=', FULL_AMMO.has(303));
    log('[ammo] FULL_AMMO full:',
        [...FULL_AMMO.entries()].map(([k,v]) => k + '→' + v).join(' '));
    initNative();

    while (running) {
        try {
            // ========= 阶段 1: 等 PID =========
            let pid = null;
            let mem = null;
            while (running && !pid) {
                pid = findPid();
                if (pid) {
                    try { mem = new Mem(pid); }
                    catch (err) {
                        log('[ammo] OpenProcess 失败:', err.message);
                        pid = null; mem = null;
                    }
                }
                if (!pid) await sleep(1000);
            }
            if (!running) return;
            log('[ammo] rpcs3 pid =', pid);

            // ========= 阶段 2: 等机体 =========
            let target = null;
            while (running && !target) {
                if (!findPid()) {
                    log('[ammo] 模拟器已退出，回到阶段 1');
                    mem = null; pid = null;
                    break;
                }
                try {
                    target = pickPlayerUnit(mem, findUnits(mem));
                } catch {
                    target = null;
                }
                if (!target) await sleep(1000);
            }
            if (!running) return;
            if (!target) continue;
            log('[ammo] target =', hex(target));
            const idxData = mem.read(target + OFF_UNIT_INDEX, 4);
            log('[ammo] 单位索引 =', idxData.length === 4 ? idxData.readUInt32BE(0) : '?');

            // ========= 阶段 3: 全内存定位所有武器状态条目 =========
            // findAllWeaponEntries 全内存扫，返回 Map<id, [{absAddr}]>
            // 游戏会同时修改 2~3 份副本，必须全部同步补上
            let entries = new Map();
            let entriesLogged = false;
            let lastRelocate = 0;
            let lastPidCheck = 0;
            let cycles = 0;
            let lastStatus = '';

            while (running) {
                const now = Date.now();

                if (now - lastPidCheck >= PID_CHECK_MS) {
                    lastPidCheck = now;
                    if (!findPid()) {
                        log('[ammo] 模拟器已退出，回到阶段 1');
                        mem = null; pid = null; target = null;
                        break;
                    }
                }

                if (now - lastRelocate >= RELOCATE_MS) {
                    lastRelocate = now;
                    try {
                        if (!target || !unitValid(mem, target)) {
                            const nt = pickPlayerUnit(mem, findUnits(mem));
                            if (nt) {
                                if (nt !== target) {
                                    log('[ammo] 目标失效，重新定位:', hex(target), '->', hex(nt));
                                    target = nt;
                                }
                                entries = findAllWeaponEntries(mem, extractIdToMark(mem, target));
                                entriesLogged = false;
                            } else {
                                target = null;
                                entries = new Map();
                                entriesLogged = false;
                            }
                        } else {
                            entries = findAllWeaponEntries(mem, extractIdToMark(mem, target));
                        }
                    } catch {}
                    if (!entriesLogged) {
                        entriesLogged = true;
                        const lines = [];
                        for (const id of [...FULL_AMMO.keys()].sort((a,b)=>a-b)) {
                            const arr = entries.get(id);
                            const full = FULL_AMMO.get(id);
                            if (arr && arr.length) {
                                lines.push(id + '(满' + full + '×' + arr.length + ')');
                            } else {
                                lines.push(id + '(满' + full + ' 未找到)');
                            }
                        }
                        log('[ammo] 条目:', lines.join(' '));
                    }
                }

                // 玩家阵亡/重生中：不写任何内存，等下一轮重新定位
                if (!target) {
                    await sleep(200);
                    continue;
                }

                try {
                    const parts = [];

                    // 1. 先写全内存里所有带专属标记的武器条目（这是权威层）
                    // entries 结构: Map<id, [absAddr, absAddr, ...]>
                    for (const [id, addrs] of entries) {
                        const full = FULL_AMMO.get(id);
                        let ammoWrites = 0, reloadWrites = 0;
                        for (const abs of addrs) {
                            const cur = mem.read(abs + 4, 4);
                            if (cur.length === 4 && cur.readUInt32BE(0) !== full) {
                                if (mem.write(abs + 4, u32be(full))) ammoWrites++;
                            }
                            const prog = mem.read(abs + RELOAD_PROGRESS_OFFSET, 4);
                            if (prog.length === 4 && prog.readFloatBE(0) < RELOAD_READY) {
                                if (mem.write(abs + RELOAD_PROGRESS_OFFSET, f32be(RELOAD_READY))) reloadWrites++;
                            }
                        }
                        const sample = addrs[0];
                        const curAmmo = mem.read(sample + 4, 4);
                        const curProg = mem.read(sample + RELOAD_PROGRESS_OFFSET, 4);
                        parts.push('id' + id + '(' + curAmmo.readUInt32BE(0) + '/' + full + '×' + addrs.length +
                            (ammoWrites ? '补' + ammoWrites : '') +
                            (reloadWrites ? '拉满' + reloadWrites : '') + ')');
                    }

                    // 2. HUD 槽（显示层）也一并补，防止 HUD 显示扣弹
                    for (let k = 0; k < MAX_WEAPON_SLOTS; k++) {
                        const slotBase = target + OFF_WEAPON_BASE + k * WEAPON_SLOT_SIZE;
                        const head = mem.read(slotBase, 8);
                        if (head.length < 8) continue;
                        const id = head.readUInt32BE(SLOT_ID_OFFSET);
                        if (id === 0) continue;
                        const full = FULL_AMMO.get(id);
                        if (!full) continue;
                        const slotAmmo = head.readUInt32BE(SLOT_AMMO_OFFSET);
                        if (slotAmmo !== full) {
                            mem.write(slotBase + SLOT_AMMO_OFFSET, u32be(full));
                        }
                        // HUD 槽的装填进度也拉满
                        const slotProg = mem.read(slotBase + RELOAD_PROGRESS_OFFSET, 4);
                        if (slotProg.length === 4 && slotProg.readFloatBE(0) < RELOAD_READY) {
                            mem.write(slotBase + RELOAD_PROGRESS_OFFSET, f32be(RELOAD_READY));
                        }
                    }

                    lastStatus = parts.join(' ');
                } catch (err) {
                    logErr('[ammo] 锁定异常:', err.message, '→ 回到阶段 1');
                    mem = null; pid = null; target = null;
                    break;
                }

                if (++cycles % 500 === 0) {
                    log('[ammo] ' + lastStatus);
                }

                await sleep(LOCK_INTERVAL_MS);
            }
            if (!running) return;
        } catch (err) {
            logErr('[ammo] 外层异常:', err.message);
            await sleep(1000);
        }
    }
    log('[ammo] run() 退出');
}

// ------------------------------------------------------------------ on/off
function on() {
    if (process.platform !== 'win32') {
        return Promise.reject(new Error('该修改器仅支持 Windows'));
    }
    log('[ammo] 收到开启请求, running =', running);
    if (running) return Promise.resolve({ status: 'already_running' });

    running = true;
    currentRun = run().catch(err => {
        logErr('[ammo] run() 异常终止:', err.message || err);
        running = false;
    });
    log('[ammo] 已启动后台 run()');
    return Promise.resolve({ status: 'started' });
}

async function off() {
    log('[ammo] 收到关闭请求, running =', running);
    running = false;
    if (currentRun) {
        log('[ammo] 等待 run() 退出...');
        await currentRun;
        log('[ammo] run() 已退出');
    }
    log('[ammo] 完成');
}

module.exports = { on, off };

if (require.main === module) {
    on();
    process.on('SIGINT', async () => { await off(); process.exit(0); });
}
