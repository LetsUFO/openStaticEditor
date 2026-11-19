'use strict';

// EXVSFB (NPJB00512) RPCS3 内存修改器 — HP / Boost / EX 锁定
// 由主程序（openStaticEditor）通过 on()/off() 调用；独立运行也可。
// 架构：状态机 + 外层无限循环 + 全面 try/catch
//   状态机：WAITING_PID → WAITING_BATTLE → LOCKING
//   任何阶段崩了（模拟器崩溃、mem 句柄失效、扫描异常）→ 自动滚回 WAITING_PID
//   只有 off() 才真正停掉。
// 觉醒/大招期间暂停 EX 强写（避免打断状态机导致大招只能放一次）；Boost 和 HP 全程锁。

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
const OFF_EX_STATE = 0x9DC;   // 觉醒/大招状态：0=普通，非0=觉醒进行中
const BOOST_MAX = 10000;
const EX_MAX = 100.0;
const HP_MAX_SANE = 5000;
const EX_HP_FLOOR = 1;
const EX_HP_CEIL = HP_MAX_SANE;
const EX_BOOST_CEIL = 10000;
const EX_EX_CEIL = 101;

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
const BOOST_BUFFER = u32be(BOOST_MAX);
const EX_BUFFER = f32be(EX_MAX);

function monotonic() { return process.hrtime()[1] / 1e9 + process.hrtime()[0]; }

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
    if (hp < EX_HP_FLOOR || hp > EX_HP_CEIL) return false;
    const boostData = mem.read(unit + OFF_BOOST, 4);
    if (boostData.length !== 4) return false;
    const boost = boostData.readUInt32BE(0);
    if (boost > EX_BOOST_CEIL) return false;
    const exData = mem.read(unit + OFF_EX, 4);
    if (exData.length !== 4) return false;
    const ex = exData.readFloatBE(0);
    if (!Number.isFinite(ex) || ex < 0 || ex > EX_EX_CEIL) return false;
    return true;
}

function pickPlayerUnit(mem, units) {
    const candidates = units.filter(unit => slotOneCandidate(mem, unit));

    // 只接受索引 0 的单位（玩家自己），避免把敌方也锁成无限 Boost
    for (const unit of candidates) {
        const idxData = mem.read(unit + OFF_UNIT_INDEX, 4);
        if (idxData.length === 4 && idxData.readUInt32BE(0) === 0) return unit;
    }
    return null;
}

// ---------------------------------------------------------------- 参数解析
function parseArgs(argv) {
    const args = { boost: false, hp: false, ex: false,
        all: false, list: false, target: 1, help: false };
    if (argv.length === 0) {
        args.boost = true;
        args.hp = true;
        args.ex = true;
    }
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--target') args.target = Number(argv[++i]);
        else if (arg === '--help' || arg === '-h') args.help = true;
        else if (['--boost', '--hp', '--ex', '--all', '--list'].includes(arg))
            args[arg.slice(2)] = true;
    }
    return args;
}

// ---------------------------------------------------------------- 日志 & 开关
const LOG_FILE = path.join(__dirname, 'exvs_trainer.log');
const LOCK_FILE = path.join(__dirname, 'exvs_trainer.lock');
let running = false;
let currentRun = null;

function acquireLock() {
    // 清理历史版本可能残留的锁文件，然后始终允许运行
    try { if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE); } catch {}
    return true;
}
function releaseLock() {
    try { if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE); } catch {}
}

for (const method of ['log', 'error']) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
        original(...args);
        try { fs.appendFileSync(LOG_FILE, format(...args) + '\n'); } catch {}
    };
}

// ---------------------------------------------------------------- 主状态机
async function run(args) {
    // 文件锁：防止多个父程序进程各自跑一份，互相并发写 RPCS3 导致崩溃
    if (!acquireLock()) {
        console.log('[+] 已有另一实例持有锁，自动退出');
        running = false;
        return;
    }
    console.log('[+] 获取文件锁成功, pid =', process.pid);
    try { fs.writeFileSync(LOG_FILE, ''); } catch {}
    console.log('[+] 版本 = body v2 (pid ' + process.pid + ')');
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
                        console.log('[+] OpenProcess 失败:', err.message, '继续等待...');
                        pid = null; mem = null;
                    }
                }
                if (!pid) await sleep(1000);
            }
            if (!running) return;
            console.log('[+] rpcs3 pid =', pid);

            // ========= 阶段 2: 等机体（进入战斗） =========
            let units = [];
            let target = null;
            let hpMax = 0;
            while (running && !target) {
                if (!findPid()) {
                    console.log('[+] 模拟器已退出，回到阶段 1 重新等 pid');
                    mem = null; pid = null; break;
                }
                try {
                    units = findUnits(mem);
                    target = pickPlayerUnit(mem, units);
                    if (target) {
                        const d = mem.read(target + OFF_HP, 4);
                        hpMax = d.length === 4 ? d.readUInt32BE(0) : 0;
                    }
                } catch (err) {
                    console.log('[+] 找机体异常:', err.message);
                    target = null;
                }
                if (!target) await sleep(1000);
            }
            if (!running) return;
            if (!target) continue;  // pid 丢了，回阶段 1
            console.log('[+] target =', hex(target), 'HP =', hpMax);
            const idxData = mem.read(target + OFF_UNIT_INDEX, 4);
            console.log('[+] 单位索引 =', idxData.length === 4 ? idxData.readUInt32BE(0) : '?');
            const mode = [];
            if (args.boost) mode.push('气槽');
            if (args.hp) mode.push('血量');
            if (args.ex) mode.push('EX');
            console.log('[+] 已开启:', mode.join(', '), '(Ctrl+C 停止)');

            // ========= 阶段 3: 锁定循环 =========
            let lastPidCheck = Date.now();
            let lastRecheck = Date.now();

            while (running) {
                const now = Date.now();

                // 每 5 秒检查一次 pid
                if (now - lastPidCheck >= 5000) {
                    lastPidCheck = now;
                    if (!findPid()) {
                        console.log('[+] 模拟器已退出，回到阶段 1');
                        mem = null; pid = null; target = null;
                        break;
                    }
                }

                // 结构变化检查：轻量校验每轮做，全量扫描（256MB，很重）30 秒一次
                try {
                    const stale = !target || !unitValid(mem, target);
                    if (stale || now - lastRecheck >= 30000) {
                        lastRecheck = now;
                        const newUnits = findUnits(mem);
                        const newTarget = pickPlayerUnit(mem, newUnits);
                        if (newTarget && newTarget !== target) {
                            console.log('[+] 目标变化:', hex(target), '->', hex(newTarget));
                            target = newTarget;
                            const d = mem.read(target + OFF_HP, 4);
                            hpMax = d.length === 4 ? d.readUInt32BE(0) : 0;
                        } else if (newTarget) {
                            // 同 target，更新 hpMax（可能阵亡复活）
                            const d = mem.read(target + OFF_HP, 4);
                            const curHp = d.length === 4 ? d.readUInt32BE(0) : 0;
                            if (curHp > hpMax) hpMax = curHp;
                        } else {
                            // 玩家阵亡/重生中
                            target = null;
                        }
                    }
                } catch (err) {
                    console.log('[+] 重扫异常:', err.message);
                }

                // 没有玩家机体时不写任何内存
                if (!target) {
                    await sleep(200);
                    continue;
                }

                // === 锁定 ===
                try {
                    if (args.boost) mem.write(target + OFF_BOOST, BOOST_BUFFER);
                    if (args.hp && hpMax > 0) mem.write(target + OFF_HP, u32be(hpMax));
                    // 觉醒期间跳过 EX 强写（避免打断状态机导致大招只能放一次）
                    if (args.ex) {
                        const st = mem.read(target + OFF_EX_STATE, 4);
                        const inBurst = st.length === 4 && st.readUInt32BE(0) !== 0;
                        if (!inBurst) mem.write(target + OFF_EX, EX_BUFFER);
                    }
                } catch (err) {
                    console.log('[+] 锁定循环异常:', err.message, '回到阶段 1');
                    mem = null; pid = null; target = null;
                    break;
                }

                await sleep(20);
            }
            if (!running) return;
        } catch (err) {
            console.error('[+] 外层循环异常（忽略，继续等）:', err.message);
            await sleep(1000);
        }
    }
    releaseLock();
    console.log('[+] run() 退出');
}

// ---------------------------------------------------------------- on/off
function on() {
    if (process.platform !== 'win32') {
        return Promise.reject(new Error('该修改器仅支持 Windows'));
    }
    console.log('[on] 收到开启请求, running =', running);
    if (running) return Promise.resolve({ status: 'already_running' });

    running = true;
    currentRun = run(parseArgs([])).catch(err => {
        console.error('[x] run() 异常终止:', err.message || err);
        running = false;
    });
    console.log('[on] 已启动后台 run()');
    return Promise.resolve({ status: 'started' });
}

async function off() {
    console.log('[off] 收到关闭请求, running =', running);
    running = false;
    if (currentRun) {
        console.log('[off] 等待 run() 退出...');
        await currentRun;
        console.log('[off] run() 已退出');
    }
    console.log('[off] 完成');
}

module.exports = { on, off };

if (require.main === module) {
    process.once('SIGINT', () => { running = false; });
    const args = parseArgs(process.argv.slice(2));
    run(args).catch(error => {
        console.error('[x]', error.message || error);
        process.exitCode = 1;
    });
}
