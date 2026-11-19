'use strict';

// EXVSFB (NPJB00512) 战斗倒计时锁定 — 独立脚本
// 主程序约定：require 本模块后，开/关分别调用 on()/off()
// 倒计时结构：u32 大端“剩余帧数”(60fps)，后一字段为 0x2A30 = 10800 = 180s*60
// 该结构位于 PPU 栈区，每局地址会漂移，因此每局按签名自动重扫。
// 日志写 lockTime.log

const koffi = require('koffi');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { format } = require('util');

const BASE = 0x340000000;
const SIZE = 0x10000000;
const CHUNK = 1 << 22;
const TIME_LIMIT_FRAMES = 10800;                       // 180 秒 * 60fps
const LIMIT_PATTERN = Buffer.from([0x00, 0x00, 0x2A, 0x30]);
const MIN_DECREASE = 10;                               // 400ms 内至少减少的帧数
const MAX_DECREASE = 60;                               // 400ms 内最多减少的帧数

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

// 扫描 [剩余帧][10800] 结构，并用 400ms 递减确认是正在运行的倒计时
async function scanTimer(mem) {
    const cands = [];
    for (let off = 0; off < SIZE; off += CHUNK) {
        const data = mem.read(BASE + off, CHUNK);
        if (!data.length) continue;
        let i = 0;
        while (true) {
            i = data.indexOf(LIMIT_PATTERN, i);
            if (i < 0) break;
            if (i % 4 !== 0) {
                i += 1;
                continue;
            }
            const valueAddr = BASE + off + i - 4;
            // 结构校验：剩余帧、上限、1.0f、2
            const st = mem.read(valueAddr, 16);
            if (st.length === 16 &&
                    st.readUInt32BE(0) > 0 &&
                    st.readUInt32BE(0) <= TIME_LIMIT_FRAMES &&
                    st.readUInt32BE(4) === TIME_LIMIT_FRAMES &&
                    Math.abs(st.readFloatBE(8) - 1.0) < 1e-4 &&
                    st.readUInt32BE(12) === 2) {
                cands.push({ valueAddr, value: st.readUInt32BE(0) });
            }
            i += 4;
        }
    }
    if (!cands.length) return null;

    await sleep(400);
    for (const cand of cands) {
        const raw = mem.read(cand.valueAddr, 4);
        if (raw.length !== 4) continue;
        const value = raw.readUInt32BE(0);
        const decrease = cand.value - value;
        if (value > 0 && decrease >= MIN_DECREASE && decrease <= MAX_DECREASE) {
            return { valueAddr: cand.valueAddr, value };
        }
    }
    return null;
}

// ---------------------------------------------------------------- 主状态机
async function run() {
    initNative();
    try { fs.writeFileSync(LOG_FILE, ''); } catch { /* ignore */ }

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
                        pid = null;
                        mem = null;
                    }
                }
                if (!pid) await sleep(1000);
            }
            if (!running) return;
            console.log('[+] rpcs3 pid =', pid);

            // ========= 阶段 2: 等战斗倒计时出现 =========
            let timer = null;
            while (running && !timer) {
                if (!findPid()) {
                    console.log('[+] 模拟器已退出，回到阶段 1');
                    mem = null;
                    pid = null;
                    break;
                }
                try {
                    timer = await scanTimer(mem);
                } catch (err) {
                    console.log('[+] 扫描异常:', err.message);
                    timer = null;
                }
                if (!timer) {
                    console.log('[+] 等待进入战斗 / 倒计时出现...');
                    await sleep(1000);
                }
            }
            if (!running) return;
            if (!timer) continue;

            console.log(`[+] 倒计时地址 ${hex(timer.valueAddr)}  剩余 ${timer.value} 帧 (${(timer.value / 60).toFixed(2)}s)`);
            console.log('[+] 时间锁定已开启 (Ctrl+C 停止)');
            const freeze = u32be(timer.value);

            // ========= 阶段 3: 锁定循环 =========
            let lastPidCheck = Date.now();
            while (running) {
                const now = Date.now();
                if (now - lastPidCheck >= 1000) {
                    lastPidCheck = now;
                    if (!findPid()) {
                        console.log('[+] 模拟器已退出，回到阶段 1');
                        mem = null;
                        pid = null;
                        timer = null;
                        break;
                    }
                }

                // 结构校验，避免写入已被复用的栈空间
                const st = mem.read(timer.valueAddr, 8);
                if (st.length === 8 && st.readUInt32BE(4) === TIME_LIMIT_FRAMES) {
                    mem.write(timer.valueAddr, freeze);
                } else {
                    console.log('[+] 倒计时结构失效，重新定位');
                    timer = null;
                    break;
                }

                await sleep(1);
            }
            if (!running) return;
        } catch (err) {
            console.error('[+] 外层循环异常（忽略，继续等）:', err.message);
            await sleep(1000);
        }
    }
    console.log('[+] run() 退出');
}

// ---------------------------------------------------------------- 日志 & 开关
const LOG_FILE = path.join(__dirname, 'lockTime.log');
let running = false;
let currentRun = null;

for (const method of ['log', 'error']) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
        original(...args);
        try { fs.appendFileSync(LOG_FILE, format(...args) + '\n'); } catch { /* ignore */ }
    };
}

/** 主程序「开」 */
function on() {
    if (process.platform !== 'win32') {
        return Promise.reject(new Error('该修改器仅支持 Windows'));
    }
    console.log('[on] 收到开启请求, running =', running);
    if (running) return Promise.resolve({ status: 'already_running' });

    running = true;
    currentRun = run().catch(err => {
        console.error('[x] run() 异常终止:', err.message || err);
        running = false;
    });
    console.log('[on] 已启动后台 run()');
    return Promise.resolve({ status: 'started' });
}

/** 主程序「关」 */
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

// 独立命令行运行: node lockTime.js
if (require.main === module) {
    process.once('SIGINT', () => { running = false; });
    on().catch(error => {
        console.error('[x]', error.message || error);
        process.exitCode = 1;
    });
}
