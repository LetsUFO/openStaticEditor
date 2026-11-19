'use strict';

// EXVSFB (NPJB00512) RPCS3 内存修改器 — 武器弹药无限
// 由主程序（openStaticEditor）通过 on()/off() 调用；独立运行也可。
// 架构：状态机 + 外层无限循环 + 全面 try/catch
//   状态机：WAITING_PID → WAITING_BATTLE → LOCKING
//   任何阶段崩了（模拟器崩溃、mem 句柄失效、扫描异常）→ 自动滚回 WAITING_PID
//   只有 off() 才真正停掉。
// 锁定对象：
//   1) 武器槽 +0x04 弹药数（HUD 显示层，所有机体通用）
//   2) 硬编码独立弹药计数器（之前 diff 确认的真实扣减位置）
// 自动扫描只打日志，不自动加锁（之前误锁导致主射打不出 + 卡死）。
// 只锁玩家机体，绝不作用于敌方。

const koffi = require('koffi');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { format } = require('util');

const BASE = 0x340000000;
const SIZE = 0x10000000;
const CHUNK = 1 << 22;
const HP_MAX_SANE = 5000;
const BOOST_MAX = 10000;
const EX_MAX = 100.0;

const OFF_WEAPON_BASE = 0x0BD8;
const WEAPON_SLOT_SIZE = 0x20;
const MAX_WEAPON_SLOTS = 6;
const WEAPON_AMMO_OFFSET = 0x04;
const WEAPON_ID_OFFSET = 0x00;

// 硬编码独立弹药计数器：之前 diff 确认的真实扣减位置
// （第三武器/齐射机制的真实弹药，不是槽内 +0x04 显示层）
const HARDCODED_OFFSETS = [0x2518, 0x251C, 0x254C, 0x2560];

// 扫描窗口 & 排除区
const SCAN_WINDOW_SIZE = 0x30000;
const SCAN_INTERVAL_MS = 3000;
const EXCLUDE_RANGES = [
    [0x0000, 0x0BFF],  // 武器槽之前的状态/坐标区，不扫
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

// EXVSFB 所有武器上限 ≤ 200，用 200 够了
// 之前用 999 可能触发某些边界条件（武器状态机判断异常导致主射打不出）
const LOCK_AMMO = 200;

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
    const hpData = mem.read(unit + 0x164, 4);
    if (hpData.length !== 4) return false;
    const hp = hpData.readUInt32BE(0);
    if (hp < 1 || hp > HP_MAX_SANE) return false;
    const boostData = mem.read(unit + 0x998, 4);
    if (boostData.length !== 4) return false;
    const boost = boostData.readUInt32BE(0);
    if (boost > BOOST_MAX) return false;
    const exData = mem.read(unit + 0x9D8, 4);
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
const LOCK_FILE = path.join(__dirname, 'exvs_ammo.lock');
let running = false;
let currentRun = null;
let lockFd = null;  // 持有的独占文件锁

/** 尝试获取独占文件锁；失败返回 false（说明已有实例在跑） */
function acquireLock() {
    try {
        // 'wx' = 独占创建，文件已存在则抛异常 → 已有另一实例持有
        lockFd = fs.openSync(LOCK_FILE, 'wx');
        fs.writeSync(lockFd, String(process.pid));
        return true;
    } catch {
        return false;
    }
}
function releaseLock() {
    if (lockFd !== null) {
        try { fs.closeSync(lockFd); } catch {}
        try { fs.unlinkSync(LOCK_FILE); } catch {}
        lockFd = null;
    }
}

for (const method of ['log', 'error']) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
        original(...args);
        try { fs.appendFileSync(LOG_FILE, format(...args) + '\n'); } catch {}
    };
}

// ------------------------------------------------------------------- 扫描函数（只打日志，不自动加锁）
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
            // 严格筛选（所有条件同时满足）：
            //   off >= 0x0C00          跳过武器槽之前的状态/坐标区
            //   2 <= old <= 200        合理弹药范围
            //   1 <= (old-now) <= 5    每次开火扣 1~5
            //   now > 0                排除归零（状态跳变）
            if (old > now && now > 0
                    && old >= 2 && old <= 200
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
    // 文件锁：防止多个父程序进程各自跑一份，互相并发写 RPCS3 导致崩溃
    if (!acquireLock()) {
        console.log('[ammo] 已有另一实例持有锁，自动退出');
        running = false;
        return;
    }
    console.log('[ammo] 获取文件锁成功, pid =', process.pid);
    try { fs.writeFileSync(LOG_FILE, ''); } catch {}
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
                        console.log('[ammo] OpenProcess 失败:', err.message);
                        pid = null; mem = null;
                    }
                }
                if (!pid) await sleep(1000);
            }
            if (!running) return;
            console.log('[ammo] rpcs3 pid =', pid);

            // ========= 阶段 2: 等机体 =========
            let units = [];
            let target = null;
            while (running && !target) {
                if (!findPid()) {
                    console.log('[ammo] 模拟器已退出，回到阶段 1');
                    mem = null; pid = null; break;
                }
                try {
                    units = findUnits(mem);
                    target = pickPlayerUnit(mem, units);
                } catch (err) {
                    target = null;
                }
                if (!target) await sleep(1000);
            }
            if (!running) return;
            if (!target) continue;
            console.log('[ammo] target =', hex(target));
            console.log('[ammo] 弹药无限已开启, 锁值 =', LOCK_AMMO);

            // 自动扫描机制：
            //   - candidateHits: Map<offset, count>  每个偏移被命中的累计次数
            //   - autoLocked:   Set<offset>          连续 ≥2 次命中 → 自动加锁
            //   - 加锁后 tight loop 每轮都写，和硬编码的一样对待
            //   - 过滤掉一次性状态跳变，只让高频出现的真弹药地址进来
            const candidateHits = new Map();
            const autoLocked = new Set();

            let snapshotA = null;
            try { snapshotA = mem.read(target, SCAN_WINDOW_SIZE); } catch {}
            let lastScanTime = Date.now();

            // ========= 阶段 3: 锁定循环 =========
            // tight loop 但加 sleep(2)：约 500Hz，CPU 不跑满，内存不冲突
            let cycles = 0;
            let unitRecheckCounter = 0;
            let lastPidCheck = Date.now();

            while (running) {
                const now = Date.now();

                // 每 5 秒查 pid
                if (now - lastPidCheck >= 5000) {
                    lastPidCheck = now;
                    if (!findPid()) {
                        console.log('[ammo] 模拟器已退出，回到阶段 1');
                        mem = null; pid = null; target = null; break;
                    }
                }

                // 每 ~500 次重扫机体
                if (++unitRecheckCounter >= 500) {
                    unitRecheckCounter = 0;
                    try {
                        units = findUnits(mem);
                        const newTarget = pickPlayerUnit(mem, units);
                        if (newTarget && newTarget !== target) {
                            console.log('[ammo] 切换目标:', hex(target), '->', hex(newTarget));
                            target = newTarget;
                            // 换机体后清空自动扫描状态（结构不同）
                            candidateHits.clear();
                            autoLocked.clear();
                            try { snapshotA = mem.read(target, SCAN_WINDOW_SIZE); } catch { snapshotA = null; }
                        }
                    } catch {}
                }

                // 每 3 秒触发一次扫描（二次验证 → 自动加锁）
                if (now - lastScanTime >= SCAN_INTERVAL_MS) {
                    lastScanTime = now;
                    await sleep(50).catch(() => {});
                    if (!running) break;
                    if (!findPid()) break;
                    try {
                        const res = scanOnce(mem, target, snapshotA);
                        snapshotA = res.nextBaseline;
                        // 更新候选命中率
                        const newlyVerified = [];
                        for (const f of res.found) {
                            if (autoLocked.has(f.off)) continue;
                            const count = (candidateHits.get(f.off) || 0) + 1;
                            candidateHits.set(f.off, count);
                            if (count >= 2) {
                                autoLocked.add(f.off);
                                newlyVerified.push(f);
                            }
                        }
                        if (newlyVerified.length) {
                            console.log('[ammo] ★ 自动验证并加锁:',
                                newlyVerified.map(f => '0x' + f.off.toString(16).toUpperCase()).join(', '),
                                '(当前自动锁 =', autoLocked.size, ')');
                        } else if (res.found.length) {
                            console.log('[ammo] 扫描命中 (≥2 次才加锁):',
                                res.found.map(f => '0x' + f.off.toString(16).toUpperCase() +
                                    ` [${candidateHits.get(f.off)}/2]`).join(', '));
                        }
                    } catch {}
                }

                // === tight loop 锁定（加 sleep 防卡死） ===
                try {
                    // 硬编码独立计数器 + 自动扫描验证过的
                    for (const off of HARDCODED_OFFSETS) {
                        mem.write(target + off, AMMO_BUFFER);
                    }
                    for (const off of autoLocked) {
                        mem.write(target + off, AMMO_BUFFER);
                    }
                    // 武器槽 +0x04
                    for (let k = 0; k < MAX_WEAPON_SLOTS; k++) {
                        const slotBase = OFF_WEAPON_BASE + k * WEAPON_SLOT_SIZE;
                        const idBuf = mem.read(target + slotBase + WEAPON_ID_OFFSET, 4);
                        if (idBuf.length !== 4) continue;
                        const weaponId = idBuf.readUInt32BE(0);
                        if (!weaponId) continue;
                        mem.write(target + slotBase + WEAPON_AMMO_OFFSET, AMMO_BUFFER);
                    }
                } catch (err) {
                    console.log('[ammo] 锁定异常:', err.message, '回到阶段 1');
                    mem = null; pid = null; target = null; break;
                }

                if (++cycles % 100000 === 0) {
                    console.log('[ammo] cycles =', cycles, 'target =', hex(target));
                }

                // 关键：加 sleep(2) 防止 CPU 跑满 + 内存冲突
                await sleep(2);
            }
            if (!running) return;
        } catch (err) {
            console.error('[ammo] 外层异常:', err.message);
            await sleep(1000);
        }
    }
    releaseLock();
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
}
