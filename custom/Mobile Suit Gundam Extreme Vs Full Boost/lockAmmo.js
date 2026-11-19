'use strict';

// EXVSFB (NPJB00512) RPCS3 内存修改器 — 武器弹药无限
// 由主程序（openStaticEditor）通过 on()/off() 调用；独立运行也可。
// 锁定对象：
//   1) 武器槽 +0x04 弹药数（通用，每个槽）
//   2) 独立弹药计数器 +0x2518 / +0x251C / +0x254C / +0x2560（第三武器/齐射机制真实扣减位置）
// 只锁玩家机体（slotOneCandidate 过滤 HP 1~5000 + EX 0~100 的正常机体），绝不作用于敌方。
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

// 武器槽起点：从机体基址 +0x0BD8 起，每槽 0x20 字节
const OFF_WEAPON_BASE = 0x0BD8;
const WEAPON_SLOT_SIZE = 0x20;
const MAX_WEAPON_SLOTS = 6;
const WEAPON_AMMO_OFFSET = 0x04;  // 槽内弹药计数
const WEAPON_ID_OFFSET = 0x00;    // 槽内武器 ID，非 0 视为已装备

// 独立弹药计数器（之前 diff 确认：第三武器/齐射机制真实扣减位置）
const INDEPENDENT_AMMO_OFFSETS = [0x2518, 0x251C, 0x254C, 0x2560];

// 锁定值：999 足够（EXVSFB 所有武器实际上限 ≤ 200）
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

function u32be(value) {
    const b = Buffer.allocUnsafe(4);
    b.writeUInt32BE(value >>> 0, 0);
    return b;
}

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
        if (!this.handle) {
            throw new Error('OpenProcess 失败');
        }
    }

    read(address, size) {
        const buffer = Buffer.allocUnsafe(size);
        const read = [0];
        const ok = ReadProcessMemory(this.handle, address, buffer, size, read);
        return ok ? buffer.subarray(0, Number(read[0])) : Buffer.alloc(0);
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

function pickPlayerUnit(mem, units, target, previous = null) {
    const candidates = units.filter(unit => slotOneCandidate(mem, unit));
    if (!candidates.length) {
        return units.length ? units[Math.min(target, units.length) - 1] : null;
    }
    if (previous && candidates.includes(previous)) return previous;
    return candidates[Math.min(target, candidates.length) - 1];
}

// ---------------------------------------------------------------- 主程序调用（on/off）
const LOG_FILE = path.join(__dirname, 'exvs_ammo.log');
let running = false;
let currentRun = null;

for (const method of ['log', 'error']) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
        original(...args);
        try { fs.appendFileSync(LOG_FILE, format(...args) + '\n'); } catch { /* noop */ }
    };
}

async function run() {
    try { fs.writeFileSync(LOG_FILE, ''); } catch { /* noop */ }
    initNative();

    let mem = null;
    let units = [];
    let target = null;
    let lastTarget = null;

    // ---- 阶段 A: 等模拟器启动 ----
    while (running) {
        const pid = findPid();
        if (pid) {
            try {
                mem = new Mem(pid);
                console.log('[ammo] rpcs3 pid =', pid);
                break;
            } catch { /* 继续等 */ }
        }
        await sleep(1000);
    }
    if (!running) return;

    // ---- 阶段 B: 等进入战斗 ----
    while (running) {
        units = findUnits(mem);
        if (units.length > 0) break;
        if (!findPid()) {
            console.log('[ammo] 模拟器连接断开，重新等待...');
            mem = null;
            while (running) {
                const pid = findPid();
                if (pid) { try { mem = new Mem(pid); break; } catch {} }
                await sleep(1000);
            }
            if (!running) return;
        }
        await sleep(1000);
    }
    if (!running) return;

    // ---- 阶段 C: 找到玩家机体 ----
    target = pickPlayerUnit(mem, units, 1);
    if (!target) { console.log('[ammo] 没找到玩家机体'); return; }
    console.log('[ammo] target =', hex(target));
    console.log('[ammo] 弹药无限已开启, 锁值 =', LOCK_AMMO);

    // ---- 阶段 D: tight loop 锁定 ----
    // 不放 sleep，让循环尽可能快；单次 read/write 约 1~5us，实测 800~1000Hz
    // 武器槽 6 个 + 独立计数器 4 个 = 每个机体最多 10 次 write/轮
    let cycles = 0;
    let unitRecheckCounter = 0;

    while (running) {
        // 每 ~500 次循环重新检测一次机体结构
        // （换局/阵亡后自动重新定位，频率够低不影响锁定性能）
        if (++unitRecheckCounter >= 500) {
            unitRecheckCounter = 0;
            units = findUnits(mem);
            if (units.length > 0) {
                const newTarget = pickPlayerUnit(mem, units, 1, target);
                if (newTarget && newTarget !== target) {
                    console.log('[ammo] 切换目标:', hex(target), '->', hex(newTarget));
                    target = newTarget;
                } else if (newTarget) {
                    target = newTarget;  // 保持同基址（可能 findUnits 每次地址不同但 pick 命中同一个）
                }
            }
            if (!target || !unitValid(mem, target)) {
                // 等待新的机体出现
                let waited = 0;
                while (running) {
                    await sleep(200);
                    waited += 200;
                    units = findUnits(mem);
                    target = pickPlayerUnit(mem, units, 1);
                    if (target && unitValid(mem, target)) {
                        console.log('[ammo] 重新锁定:', hex(target));
                        break;
                    }
                    if (waited >= 5000) {
                        // 模拟器可能崩了
                        if (!findPid()) {
                            console.log('[ammo] 模拟器已退出');
                            return;
                        }
                        waited = 0;
                    }
                }
                if (!running) return;
                continue;
            }
        }

        // 写独立弹药计数器（第三武器/齐射机制真实扣减位置）
        for (const off of INDEPENDENT_AMMO_OFFSETS) {
            mem.write(target + off, AMMO_BUFFER);
        }

        // 写武器槽弹药（槽内 +0x04）
        for (let k = 0; k < MAX_WEAPON_SLOTS; k++) {
            const slotBase = OFF_WEAPON_BASE + k * WEAPON_SLOT_SIZE;
            const idBuf = mem.read(target + slotBase + WEAPON_ID_OFFSET, 4);
            if (idBuf.length !== 4) continue;
            const weaponId = idBuf.readUInt32BE(0);
            if (!weaponId) continue;  // 空槽，跳过
            mem.write(target + slotBase + WEAPON_AMMO_OFFSET, AMMO_BUFFER);
        }

        // 偶尔打个日志让父程序知道还活着
        if (++cycles % 5000 === 0) {
            console.log('[ammo] locked cycles =', cycles, 'target =', hex(target));
        }
    }
    console.log('[ammo] 已停止, 共运行', cycles, '次写入');
}

function on() {
    if (process.platform !== 'win32') {
        return Promise.reject(new Error('该修改器仅支持 Windows'));
    }
    console.log('[ammo] 收到开启请求, running =', running);
    if (running) return Promise.resolve({ status: 'already_running' });

    running = true;
    currentRun = run().catch(err => {
        console.error('[ammo] run 异常:', err.message || err);
        running = false;
    });
    console.log('[ammo] 已启动后台 run()');
    return Promise.resolve({ status: 'started' });
}

async function off() {
    console.log('[ammo] 收到关闭请求, running =', running);
    running = false;
    if (currentRun) {
        await currentRun;
        console.log('[ammo] run 已退出');
    }
    console.log('[ammo] 完成');
}

module.exports = { on, off };

// 独立运行入口：node lockAmmo.js
if (require.main === module) {
    on();
    process.on('SIGINT', async () => { await off(); process.exit(0); });
    process.on('SIGTERM', async () => { await off(); process.exit(0); });
}
