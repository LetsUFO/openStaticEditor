'use strict';

// EXVSFB (NPJB00512) RPCS3 内存修改器 Node.js 版。
// 需要 Node.js 18+，独立运行前执行 npm install；由主程序调用时无需（主程序注册全局 NODE_PATH）。
// 主程序约定：require 本模块后，开/关分别调用导出的 on()/off()（config.json 的 script/on/off），
// 模块常驻、on/off 共享 running 标志；日志写 exvs_trainer.log。独立命令行运行见文件末尾。
const koffi = require('koffi');
const { execFileSync } = require('child_process');
const { performance } = require('perf_hooks');
const fs = require('fs');
const path = require('path');
const { format } = require('util');

const BASE = 0x340000000;
const SIZE = 0x10000000;
const CHUNK = 1 << 22;
const OFF_HP = 0x164;
const OFF_BOOST = 0x998;
const OFF_EX = 0x9D8;
const AMMO_FIELDS = [[0x0BDC, 12], [0x0BFC, 1], [0x0C1C, 16]];
const AMMO_NAMES = ['主射', '齐射', '浮游炮'];
const WEAPON_IDS = [158, 159, 160];
const SCAN_BASE = 0x341000000;
const SCAN_SIZE = 0x1200000;
const BOOST_MAX = 10000;
const EX_MAX = 100.0;
const HP_MAX_SANE = 5000;

const PROCESS_VM_OPERATION = 0x0008;
const PROCESS_VM_WRITE = 0x0020;
const PROCESS_VM_READ = 0x0010;
const PROCESS_QUERY_INFORMATION = 0x0400;

// 原生接口延迟到真正开启时加载：主进程 require 本模块不触碰平台库，
// 非 Windows 环境（如开发机）也能安全加载模块，只有 on() 时才会报平台错误。
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
const monotonic = () => performance.now() / 1000;
const hex = value => '0x' + value.toString(16).toUpperCase();

function u32be(value) {
    const b = Buffer.allocUnsafe(4);
    b.writeUInt32BE(value >>> 0, 0);
    return b;
}

function f32be(value) {
    const b = Buffer.allocUnsafe(4);
    b.writeFloatBE(value, 0);
    return b;
}

const BOOST_BUFFER = u32be(BOOST_MAX);
const EX_BUFFER = f32be(EX_MAX);
const GAUGE_FULL_BUFFER = f32be(1.0);
const AMMO_BUFFERS = AMMO_FIELDS.map(([, maximum]) => u32be(maximum));

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
            throw new Error('OpenProcess 失败，请检查 RPCS3 是否运行以及权限是否足够');
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

function readWeaponIds(mem, unit) {
    const first = AMMO_FIELDS[0][0];
    const base = first - 4;
    const size = AMMO_FIELDS[AMMO_FIELDS.length - 1][0] - first + 4;
    const data = mem.read(unit + base, size);
    if (data.length !== size) return AMMO_FIELDS.map(() => null);
    return AMMO_FIELDS.map(([off]) => data.readUInt32BE(off - first));
}

function weaponIdsMatch(ids) {
    return ids.every((id, index) => id === WEAPON_IDS[index]);
}

function formatWeaponIds(ids) {
    return ids.map(id => id === null ? '?' : id).join('/');
}

// 检查一个候选机体结构是否像“正常可操控机体”:
// 结构特征完整, HP 在 1..5000, 气槽不超过 10000, EX 是 0..100 的有限浮点。
// 用于过滤扫描误命中的垃圾结构(例如 HP=0xFFFFFFFF)。
function slotOneCandidate(mem, unit) {
    if (!unitValid(mem, unit)) return false;
    const hpData = mem.read(unit + OFF_HP, 4);
    if (hpData.length !== 4) return false;
    const hp = hpData.readUInt32BE(0);
    if (hp < 1 || hp > HP_MAX_SANE) return false;
    const boostData = mem.read(unit + OFF_BOOST, 4);
    if (boostData.length !== 4) return false;
    const boost = boostData.readUInt32BE(0);
    // 普通机体气槽上限固定 10000; 超过的是 BOSS 类单位, 不能当作 1 号位。
    if (boost > BOOST_MAX) return false;
    const exData = mem.read(unit + OFF_EX, 4);
    if (exData.length !== 4) return false;
    const ex = exData.readFloatBE(0);
    if (!Number.isFinite(ex) || ex < 0 || ex > EX_MAX) return false;
    return true;
}

// 1 号位判定: 过滤不合理结构后按地址顺序取第 target 台。
// 已经锁定且仍合格时保持不变, 避免中途把 boost 改写到敌方。
function pickPlayerUnit(mem, units, target, previous = null) {
    const candidates = units.filter(unit => slotOneCandidate(mem, unit));
    if (!candidates.length) {
        return units.length ? units[Math.min(target, units.length) - 1] : null;
    }
    if (previous && candidates.includes(previous)) return previous;
    return candidates[Math.min(target, candidates.length) - 1];
}

function pairEquals(a, b) {
    return Boolean(a && b && a.ammo.equals(b.ammo) && a.gauge.equals(b.gauge));
}

async function findSyncCopies(mem, primary, maximum) {
    const pair = address => {
        const d = mem.read(address, 0x10);
        return d.length === 0x10 ? {
            ammo: d.subarray(0, 4),
            gauge: d.subarray(0x0C, 0x10)
        } : null;
    };

    const initial = pair(primary);
    if (!initial) return [];
    const ammo = initial.ammo.readUInt32BE(0);
    const gauge = initial.gauge.readFloatBE(0);
    // 等装填条走到独特的非零小数，避开大量静态 0/1。
    if (ammo > maximum || !(gauge > 0.001 && gauge < 0.995)) return [];

    const data = mem.read(SCAN_BASE, SCAN_SIZE);
    if (data.length !== SCAN_SIZE || !pairEquals(pair(primary), initial)) return [];

    let found = [];
    let i = data.indexOf(initial.gauge);
    while (i >= 0) {
        const address = SCAN_BASE + i - 0x0C;
        if (i >= 0x0C && address % 4 === 0 &&
                data.subarray(i - 0x0C, i - 0x08).equals(initial.ammo)) {
            found.push(address);
        }
        i = data.indexOf(initial.gauge, i + 1);
    }
    if (!found.includes(primary) || found.length < 3) return [];

    // 连续同步三次，排除偶然相同的无关地址。
    for (let n = 0; n < 3; n++) {
        await sleep(20);
        const current = pair(primary);
        if (!current) return [];
        found = found.filter(address => pairEquals(pair(address), current));
        if (found.length < 3) return [];
    }
    return found.sort((a, b) => a - b);
}

function printHelp() {
    console.log(`用法: node exvs_trainer.js [选项]
  不带参数时自动启用 HP / Boost / EX / 弹药，并在内部判断是否可用
  主程序通过导出方法 on()/off() 启停；日志见 exvs_trainer.log
  --boost          气槽锁定为满 (10000)
  --hp             血量锁定为进入战斗时的值
  --ex             EX 槽锁定为满 (100)
  --ammo           强袭自由主射/齐射/浮游炮弹药锁定
  --all            对所有机体生效（不能用于 --ammo）
  --target N       第几台机体（默认 1，--ammo 只支持 1）
  --list           只列出机体，不修改`);
}

function parseArgs(argv) {
    const args = { boost: false, hp: false, ex: false, ammo: false,
        all: false, list: false, target: 1, help: false };
    if (argv.length === 0) {
        args.boost = true;
        args.hp = true;
        args.ex = true;
        args.ammo = true;
    }
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--target') {
            args.target = Number(argv[++i]);
        } else if (arg === '--help' || arg === '-h') {
            args.help = true;
        } else if (['--boost', '--hp', '--ex', '--ammo', '--all', '--list'].includes(arg)) {
            args[arg.slice(2)] = true;
        } else {
            throw new Error('未知参数: ' + arg);
        }
    }
    if (!Number.isInteger(args.target) || args.target < 1) {
        throw new Error('--target 必须是大于等于 1 的整数');
    }
    return args;
}

// ---------------------------------------------------------------- 主程序调用（on/off）
// 主程序 require 本模块后，开/关分别调用导出的 on()/off()，模块实例常驻：
// - on()：启动锁定循环（已在运行则忽略），日志写 exvs_trainer.log（每次开启清空）；
// - off()：仅置 running=false，循环下一轮自行退出，主程序不干预常驻细节。
const LOG_FILE = path.join(__dirname, 'exvs_trainer.log');
let running = false;
// 当前常驻循环的收尾 Promise：off() 等它完成后才返回，保证调用方拿到「已停止」
let currentRun = null;

for (const method of ['log', 'error']) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
        original(...args);
        try { fs.appendFileSync(LOG_FILE, format(...args) + '\n'); } catch { /* 日志失败不影响主流程 */ }
    };
}

async function run(args, onStarted) {
    if (args.ammo && (args.all || args.target !== 1)) {
        throw new Error('--ammo 目前只支持默认的第 1 台强袭自由，不能配合 --all/--target');
    }

    try { fs.writeFileSync(LOG_FILE, ''); } catch { /* 忽略 */ }
    initNative();
    const pid = findPid();
    if (!pid) {
        throw new Error('没找到 rpcs3.exe，请先启动游戏');
    }
    const mem = new Mem(pid);
    console.log('[+] rpcs3 pid =', pid);

    let units = findUnits(mem);
    if (!units.length) {
        throw new Error('没找到机体结构，请确认已经进入战斗且游戏未暂停');
    }
    console.log(`[+] 找到 ${units.length} 台机体:`);
    let hpMax = new Map();
    units.forEach((unit, index) => {
        const hpData = mem.read(unit + OFF_HP, 4);
        const boostData = mem.read(unit + OFF_BOOST, 4);
        const exData = mem.read(unit + OFF_EX, 4);
        const hp = hpData.length === 4 ? hpData.readUInt32BE(0) : -1;
        const boost = boostData.length === 4 ? boostData.readUInt32BE(0) : -1;
        const ex = exData.length === 4 ? exData.readFloatBE(0) : -1;
        const ammo = AMMO_FIELDS.map(([off]) => {
            const d = mem.read(unit + off, 4);
            return d.length === 4 ? d.readUInt32BE(0) : -1;
        });
        const ids = readWeaponIds(mem, unit);
        const matchLabel = weaponIdsMatch(ids) ? ' [强袭自由配置匹配]' : '';
        hpMax.set(unit, hp);
        console.log(`    #${index + 1}  ${hex(unit)}  HP=${hp}  气槽=${boost}  EX=${ex.toFixed(1)}  主射=${ammo[0]}  齐射=${ammo[1]}  浮游炮=${ammo[2]}  武器ID=${formatWeaponIds(ids)}${matchLabel}`);
    });
    if (args.list) return;

    let targets = args.all ? units :
        (() => {
            const unit = pickPlayerUnit(mem, units, args.target);
            return unit ? [unit] : [];
        })();
    const mode = [];
    if (args.boost) mode.push('气槽');
    if (args.hp) mode.push('血量');
    if (args.ex) mode.push('EX');
    if (args.ammo) mode.push('强袭自由主射/齐射/浮游炮');
    console.log(`[+] 已开启: ${mode.join(', ')}  (换局自动重扫, Ctrl+C 停止)`);
    if (!args.all && targets.length) {
        console.log(`[+] 目标机体: ${hex(targets[0])}`);
    }

    const ammoGroups = new Map();
    const ammoRetry = Array(AMMO_FIELDS.length).fill(0);
    let ammoAllowed = false;
    let weaponKey = '';
    let lastWeaponCheck = 0;
    if (args.ammo) console.log('[+] 弹药写入前校验武器ID，首次装填时自动定位同步副本');

    running = true;
    onStarted?.();
    let lastCheck = 0;
    while (running) {
        const now = monotonic();
        if (now - lastCheck >= 1.0) {
            if (!targets.length || targets.some(unit => !unitValid(mem, unit))) {
                units = findUnits(mem);
                const prevTarget = targets[0];
                targets = args.all ? units :
                    (() => {
                        const unit = pickPlayerUnit(mem, units, args.target, prevTarget);
                        return unit ? [unit] : [];
                    })();
                ammoGroups.clear();
                ammoRetry.fill(0);
                ammoAllowed = false;
                weaponKey = '';
                lastWeaponCheck = 0;
                hpMax = new Map();
                for (const unit of units) {
                    const d = mem.read(unit + OFF_HP, 4);
                    hpMax.set(unit, d.length === 4 ? d.readUInt32BE(0) : 0);
                }
                if (targets.length) console.log('[+] 检测到结构变化，已自动重新定位');
            }
            // 只有结构本身消失(被回收/换局)才重新判定; HP=0 只是阵亡, 不能因此改锁到敌方。
            if (!args.all && targets.length && !unitValid(mem, targets[0])) {
                const best = pickPlayerUnit(mem, units, args.target, targets[0]);
                if (best && best !== targets[0]) {
                    targets = [best];
                    hpMax = new Map([[best, 0]]);
                    ammoGroups.clear();
                    ammoRetry.fill(0);
                    ammoAllowed = false;
                    weaponKey = '';
                    lastWeaponCheck = 0;
                    console.log('[+] 1 号位判定变化，切换为 ' + hex(best));
                }
            }
            for (const unit of targets) {
                if (args.hp && (hpMax.get(unit) || 0) <= 0) {
                    const d = mem.read(unit + OFF_HP, 4);
                    if (d.length === 4 && d.readUInt32BE(0) > 0) {
                        hpMax.set(unit, d.readUInt32BE(0));
                    }
                }
            }
            lastCheck = now;
        }

        for (const unit of targets) {
            // 结构已被回收时不写入, 防止把数值写到后续占用该地址的其它机体上。
            if (!unitValid(mem, unit)) continue;
            if (args.boost) mem.write(unit + OFF_BOOST, BOOST_BUFFER);
            if (args.hp && (hpMax.get(unit) || 0) > 0) {
                mem.write(unit + OFF_HP, u32be(hpMax.get(unit)));
            }
            if (args.ex) mem.write(unit + OFF_EX, EX_BUFFER);
        }

        if (args.ammo && targets.length) {
            const unit = targets[0];
            if (now - lastWeaponCheck >= 0.5) {
                const ids = readWeaponIds(mem, unit);
                const matched = weaponIdsMatch(ids);
                const key = formatWeaponIds(ids);
                if (key !== weaponKey) {
                    if (matched) {
                        console.log(`[+] 1号机武器ID=${key}，校验通过`);
                    } else {
                        console.log(`[x] 1号机武器ID=${key}，需要158/159/160；已跳过弹药锁定`);
                        ammoGroups.clear();
                        ammoRetry.fill(0);
                    }
                    weaponKey = key;
                }
                ammoAllowed = matched;
                lastWeaponCheck = now;
            }

            if (ammoAllowed) {
                for (let index = 0; index < AMMO_FIELDS.length; index++) {
                    const [off, maximum] = AMMO_FIELDS[index];
                    let addresses = ammoGroups.get(index);
                    if (!addresses && now >= ammoRetry[index]) {
                        addresses = await findSyncCopies(mem, unit + off, maximum);
                        ammoRetry[index] = monotonic() + 0.1;
                        if (!unitValid(mem, unit) || !weaponIdsMatch(readWeaponIds(mem, unit))) {
                            ammoAllowed = false;
                            weaponKey = '';
                            ammoGroups.clear();
                            ammoRetry.fill(0);
                            break;
                        }
                        if (addresses.length) {
                            ammoGroups.set(index, addresses);
                            console.log(`[+] ${AMMO_NAMES[index]}同步副本: ${addresses.map(hex).join(', ')}`);
                        }
                    }
                    if (addresses && addresses.length) {
                        for (const address of addresses) {
                            const d = mem.read(address, 4);
                            if (d.length === 4 && d.readUInt32BE(0) <= maximum) {
                                mem.write(address, AMMO_BUFFERS[index]);
                                mem.write(address + 0x0C, GAUGE_FULL_BUFFER);
                            }
                        }
                    }
                }
            }
        }
        await sleep(args.ammo ? 5 : 20);
    }
    console.log('\n[+] 已停止');
}

/** 主程序「开」：返回 Promise，常驻循环启动成功后完成；启动失败则 reject，运行期异常记录日志 */
function on() {
    if (process.platform !== 'win32') {
        return Promise.reject(new Error('该修改器仅支持 Windows，请在 Windows 主程序中配合 RPCS3 使用'));
    }
    if (running) return Promise.resolve();

    let resolveStart;
    let rejectStart;
    const started = new Promise((resolve, reject) => {
        resolveStart = resolve;
        rejectStart = reject;
    });
    let startSucceeded = false;
    currentRun = run(parseArgs([]), () => {
        startSucceeded = true;
        resolveStart();
    }).catch(error => {
        console.error('[x]', error.message || error);
        running = false;
        if (!startSucceeded) rejectStart(error);
    });
    return started;
}

/** 主程序「关」：置标志位并返回 Promise，常驻循环真正退出后完成 */
async function off() {
    running = false;
    if (currentRun) await currentRun;
}

module.exports = { on, off };

// 独立命令行运行：node exvs_trainer.js [选项]（主程序 require 时不走这里）
if (require.main === module) {
    process.once('SIGINT', () => { running = false; });
    const args = parseArgs(process.argv.slice(2));
    if (args.help || !(args.boost || args.hp || args.ex || args.ammo || args.list)) {
        printHelp();
    } else {
        run(args).catch(error => {
            console.error('[x]', error.message || error);
            process.exitCode = 1;
        });
    }
}
