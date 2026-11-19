'use strict';

// EXVSFB (NPJB00512) RPCS3 内存修改器 — 武器弹药无限
// 由主程序（openStaticEditor）通过 on()/off() 调用；独立运行也可。
// 架构：状态机 + 外层无限循环 + 全面 try/catch
//   状态机：WAITING_PID → WAITING_BATTLE → LOCKING
//   任何阶段崩了（模拟器崩溃、mem 句柄失效、扫描异常）→ 自动滚回 WAITING_PID
//   只有 off() 才真正停掉。
// 锁定对象：
//   1) 武器槽 +0x04 弹药数（HUD 显示层，所有机体通用）
//   2) 自动扫描的「独立弹药计数器」—— 开火时真正扣减的地址
// 只锁玩家机体，绝不作用于敌方。

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
const HP_MAX_SANE = 5000;
const BOOST_MAX = 10000;
const EX_MAX = 100.0;

const OFF_WEAPON_BASE = 0x0BD8;
const WEAPON_SLOT_SIZE = 0x20;
const MAX_WEAPON_SLOTS = 6;
const WEAPON_AMMO_OFFSET = 0x04;
const WEAPON_ID_OFFSET = 0x00;

// 独立弹药计数器：硬编码种子 + 自动扫描追加
const HARDCODED_OFFSETS = [0x2518, 0x251C, 0x254C, 0x2560];
const independentOffsets = new Set(HARDCODED_OFFSETS);

const SCAN_WINDOW_SIZE = 0x30000;
const SCAN_INTERVAL_MS = 2000;
const EXCLUDE_RANGES = [
    [0x0BD8, 0x0BD8 + MAX_WEAPON_SLOTS * WEAPON_SLOT_SIZE - 1],
    [0x164, 0x164 + 3],
    [0x998, 0x998 + 3],
    [0x9D8, 0x9D8 + 3],
];
function inExcludedRange(off) {
    for (const [lo, hi] of EXCLUDE_RANGES) {
        if (off >= lo && off <= hi) return true;
    }
    return false;
}

const LOCK_AMMO = 999;

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
const hex = value => '0x' + value.toString(16).toUpperCase();
const u32be = value => {
    const b = Buffer.allocUnsafe(4);
    b.writeUInt32BE(value >>> 0, 0);
    return b;
};
const AMMO_BUFFER = u32be(LOCK_AMMO);

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
        return Boolean(WriteProcessMemory(
            this.handle, address, data, data.length, written));
    }
}

function findUnits(mem) {
    const found = [];
    const prefix = Buffer.from([0x40, 0x06]);
    for (let off = 0; off < SIZE; off += CHUNK) {
        const data = mem.read(BASE + off, CHUNK);
        if (!data.length) continue;
        let i = 0;
        while (true) {
            i = data.indexOf(prefix, i);
            if (i < 0) break;
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
    const boost = boostData.readUInt32BE(0);
    if (boost > BOOST_MAX) return false;
    const exData = mem.read(unit + OFF_EX, 4);
    if (exData.length !== 4) return false;
    const ex = exData.readFloatBE(0);
    if (!Number.isFinite(ex) || ex < 0 || ex > EX_MAX) return false;
    return true;
}

function pickPlayerUnit(mem, units) {
    const candidates = units.filter(unit => slotOneCandidate(mem, unit));
    if (!candidates.length) return null;
    return candidates[0];
}

// ------------------------------------------------------------------- 日志 & 开关
const LOG_FILE = path.join(__dirname, 'exvs_ammo.log');
let running = false;
let currentRun = null;

for (const method of ['log', 'error']) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
        original(...args);
        try { fs.appendFileSync(LOG_FILE, format(...args) + '\n'); } catch {}
    };
}

// ------------------------------------------------------------------- 扫描函数
function scanOnce(mem, target, snapshotA) {
    try {
        const snapshotB = mem.read(target, SCAN_WINDOW_SIZE);
        if (!snapshotA || !snapshotB || snapshotA.length < 4 || snapshotB.length < 4) {
            return { found: [], nextBaseline: snapshotB };
        }
        const found = [];
        for (let off = 0; off + 4 <= Math.min(SCAN_WINDOW_SIZE, snapshotA.length, snapshotB.length); off += 4) {
            if (inExcludedRange(off)) continue;
            const old = snapshotA.readUInt32BE(off);
            const now = snapshotB.readUInt32BE(off);
            if (old > now && now > 0
                    && old >= 1 && old <= 300
                    && (old - now) >= 1 && (old - now) <= 5
                    && off >= 0x0C00) {
                found.push({ off, old, now });
            }
        }
        return { found, nextBaseline: snapshotB };
    } catch {
        return { found: [], nextBaseline: null };
    }
}

// ------------------------------------------------------------------- 主状态机
async function run() {
    try { fs.writeFileSync(LOG_FILE, ''); } catch {}
    initNative();

    // 外层无限循环：任何异常/崩溃/模拟器退出都回到这里重新走一遍
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
                        console.log('[ammo] OpenProcess 失败:', err.message, '继续等待...');
                        pid = null; mem = null;
                    }
                }
                if (!pid) await sleep(1000);
            }
            if (!running) return;
            console.log('[ammo] rpcs3 pid =', pid);

            // ========= 阶段 2: 等机体（进入战斗） =========
            let units = [];
            let target = null;
            while (running && !target) {
                if (!findPid()) {
                    console.log('[ammo] 模拟器已退出，回到阶段 1 重新等 pid');
                    mem = null; pid = null; break;
                }
                try {
                    units = findUnits(mem);
                    target = pickPlayerUnit(mem, units);
                } catch (err) {
                    console.log('[ammo] 找机体异常:', err.message);
                    target = null;
                }
                if (!target) await sleep(1000);
            }
            if (!running) return;
            if (!target) continue;  // pid 丢了，回阶段 1
            console.log('[ammo] target =', hex(target));
            console.log('[ammo] 弹药无限已开启, 锁值 =', LOCK_AMMO);

            // 每次新 target 清空独立计数器（新机体结构不同）
            independentOffsets.clear();
            HARDCODED_OFFSETS.forEach(o => independentOffsets.add(o));
            let snapshotA = null;
            try { snapshotA = mem.read(target, SCAN_WINDOW_SIZE); } catch {}
            let lastScanTime = Date.now();

            // ========= 阶段 3: 锁定循环（tight loop + 后台扫描） =========
            let cycles = 0;
            let unitRecheckCounter = 0;
            let lastPidCheck = Date.now();

            while (running) {
                // 每 5 秒检查一次 pid，模拟器崩了就回阶段 1
                const now = Date.now();
                if (now - lastPidCheck >= 5000) {
                    lastPidCheck = now;
                    if (!findPid()) {
                        console.log('[ammo] 模拟器已退出，回到阶段 1');
                        mem = null; pid = null; target = null; units = [];
                        break;  // 跳出阶段 3，回外层 while
                    }
                }

                // 每 ~500 次重扫一次机体结构
                if (++unitRecheckCounter >= 500) {
                    unitRecheckCounter = 0;
                    try {
                        units = findUnits(mem);
                        const newTarget = pickPlayerUnit(mem, units);
                        if (newTarget && newTarget !== target) {
                            console.log('[ammo] 切换目标:', hex(target), '->', hex(newTarget),
                                '独立计数器清空重扫');
                            target = newTarget;
                            independentOffsets.clear();
                            HARDCODED_OFFSETS.forEach(o => independentOffsets.add(o));
                            try { snapshotA = mem.read(target, SCAN_WINDOW_SIZE); } catch { snapshotA = null; }
                        }
                    } catch (err) {
                        console.log('[ammo] 重扫异常:', err.message);
                    }
                }

                // 每 2 秒触发一次独立计数器扫描
                if (now - lastScanTime >= SCAN_INTERVAL_MS) {
                    lastScanTime = now;
                    // 等 50ms 让玩家开火后再拍 B
                    await sleep(50).catch(() => {});
                    if (!running) break;
                    if (!findPid()) {
                        console.log('[ammo] 扫描期间模拟器已退出，回到阶段 1');
                        mem = null; pid = null; target = null;
                        break;
                    }
                    try {
                        const res = scanOnce(mem, target, snapshotA);
                        snapshotA = res.nextBaseline;
                        if (res.found.length) {
                            let added = 0;
                            const details = [];
                            for (const f of res.found) {
                                if (!independentOffsets.has(f.off)) {
                                    independentOffsets.add(f.off);
                                    added++;
                                    details.push('0x' + f.off.toString(16).toUpperCase() +
                                        ` ${f.old}→${f.now}`);
                                    try { mem.write(target + f.off, AMMO_BUFFER); } catch {}
                                }
                            }
                            if (added) {
                                console.log(`[ammo] 自动扫描命中 ${added} 个（总 ${independentOffsets.size}）:`,
                                    details.join(', '));
                            }
                        }
                    } catch (err) {
                        console.log('[ammo] 扫描异常:', err.message);
                    }
                }

                // === tight loop 锁定 ===
                try {
                    for (const off of independentOffsets) {
                        mem.write(target + off, AMMO_BUFFER);
                    }
                    for (let k = 0; k < MAX_WEAPON_SLOTS; k++) {
                        const slotBase = OFF_WEAPON_BASE + k * WEAPON_SLOT_SIZE;
                        const idBuf = mem.read(target + slotBase + WEAPON_ID_OFFSET, 4);
                        if (idBuf.length !== 4) continue;
                        const weaponId = idBuf.readUInt32BE(0);
                        if (!weaponId) continue;
                        mem.write(target + slotBase + WEAPON_AMMO_OFFSET, AMMO_BUFFER);
                    }
                } catch (err) {
                    // 锁定期间异常：句柄可能坏了，直接回阶段 1
                    console.log('[ammo] 锁定循环异常:', err.message, '回到阶段 1');
                    mem = null; pid = null; target = null;
                    break;
                }

                if (++cycles % 10000 === 0) {
                    console.log('[ammo] cycles =', cycles, 'target =', hex(target),
                        '独立计数器 =', independentOffsets.size);
                }
            }
            if (!running) return;
        } catch (err) {
            console.error('[ammo] 外层循环异常（忽略，继续等）:', err.message);
        }
    }
    console.log('[ammo] run() 退出');
}

// ------------------------------------------------------------------- on/off
function on() {
    if (process.platform !== 'win32') {
        return Promise.reject(new Error('该修改器仅支持 Windows'));
    }
    console.log('[ammo] 收到开启请求, running =', running);
    if (running) return Promise.resolve({ status: 'already_running' });

    running = true;
    currentRun = run().catch(err => {
        console.error('[ammo] run() 异常终止:', err.message || err);
        running = false;
    });
    console.log('[ammo] 已启动后台 run()');
    return Promise.resolve({ status: 'started' });
}

async function off() {
    console.log('[ammo] 收到关闭请求, running =', running);
    running = false;
    if (currentRun) {
        console.log('[ammo] 等待 run() 退出...');
        await currentRun;
        console.log('[ammo] run() 已退出');
    }
    console.log('[ammo] 完成');
}

module.exports = { on, off };

if (require.main === module) {
    on();
    process.on('SIGINT', async () => { await off(); process.exit(0); });
    process.on('SIGTERM', async () => { await off(); process.exit(0); });
}
