// 外部脚本隔离执行器：脚本在独立子进程中 require 并调用方法。
// 脚本卡死（同步死循环、永不 resolve、顶层阻塞）只会卡住子进程，主进程按超时结束它。
// 子进程内的 cache 保证「开重新加载、关复用同一实例」。
import { spawn } from 'node:child_process';

/** 单次脚本调用默认超时（毫秒）：超时视为脚本卡死，强制结束子进程 */
export const SCRIPT_INVOKE_TIMEOUT = 30000;

const SCRIPT_WORKER_CODE = `
const cache = new Map();
// 脚本可能注册定时器/异步任务，未捕获异常不应导致整个执行进程退出
process.on('uncaughtException', () => {});
process.on('unhandledRejection', () => {});
process.on('disconnect', () => process.exit(0));

process.on('message', async (req) => {
	const { id, scriptPath, method, reload, ctx } = req;
	try {
		let mod = cache.get(scriptPath);
		if (reload || !mod) {
			delete require.cache[require.resolve(scriptPath)];
			mod = require(scriptPath);
			cache.set(scriptPath, mod);
		}
		const fn = mod && mod[method];
		if (typeof fn !== 'function') throw new Error('脚本未导出方法：' + method);
		await fn(ctx);
		process.send({ id, ok: true });
	} catch (error) {
		process.send({ id, ok: false, error: (error && error.message) || String(error) });
	}
});
`;

/** @type {import('node:child_process').ChildProcess | null} */
let scriptWorker = null;
let scriptRequestId = 0;
/** @type {Map<number, { resolve: Function, reject: Function, timer: ReturnType<typeof setTimeout> }>} */
const scriptPending = new Map();

function rejectAllPending(reason) {
	for (const pending of scriptPending.values()) {
		clearTimeout(pending.timer);
		pending.reject(reason);
	}
	scriptPending.clear();
}

/** 结束脚本子进程；下一次调用会按需重新拉起 */
export function stopScriptWorker() {
	const worker = scriptWorker;
	scriptWorker = null;
	if (worker) {
		try {
			worker.kill();
		} catch {
			/* 已退出 */
		}
	}
	rejectAllPending(new Error('脚本进程已结束'));
}

/** 脚本子进程输出转发到主进程终端，便于确认触发是否生效 */
function forwardLog(chunk, stream) {
	for (const line of String(chunk).split(/\r?\n/)) {
		if (line) stream.write(`[script] ${line}\n`);
	}
}

function ensureScriptWorker() {
	if (scriptWorker) return scriptWorker;

	const env = { ...process.env };
	// 主进程运行在 Electron 中，子进程需要以 Node 模式执行同一二进制
	if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';

	const worker = spawn(process.execPath, ['-e', SCRIPT_WORKER_CODE], {
		// stdin 忽略；stdout/stderr 转发；IPC 承载调用结果
		stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
		windowsHide: true,
		env
	});

	worker.stdout.on('data', (chunk) => forwardLog(chunk, process.stdout));
	worker.stderr.on('data', (chunk) => forwardLog(chunk, process.stderr));

	worker.on('message', (message) => {
		const pending = scriptPending.get(message?.id);
		if (!pending) return;
		scriptPending.delete(message.id);
		clearTimeout(pending.timer);
		if (message.ok) pending.resolve();
		else pending.reject(new Error(message.error || '脚本执行失败'));
	});

	worker.on('exit', () => {
		// 旧进程（超时被杀）的退出事件不应影响新进程上的请求
		if (scriptWorker !== worker) return;
		scriptWorker = null;
		rejectAllPending(new Error('脚本进程意外退出'));
	});

	scriptWorker = worker;
	return worker;
}

/**
 * 在隔离子进程中调用脚本方法；超时视为卡死并结束子进程。
 * @param {{ scriptPath: string, method: string, reload: boolean, ctx: object }} request
 * @param {number} [timeout] 超时毫秒数，默认 SCRIPT_INVOKE_TIMEOUT
 */
export function runScriptInWorker(request, timeout = SCRIPT_INVOKE_TIMEOUT) {
	return new Promise((resolve, reject) => {
		let worker;
		try {
			worker = ensureScriptWorker();
		} catch (error) {
			reject(error);
			return;
		}
		const id = ++scriptRequestId;
		const timer = setTimeout(() => {
			scriptPending.delete(id);
			// 卡死的脚本进程已不可信，直接结束；下次调用会重新拉起
			stopScriptWorker();
			reject(new Error(`脚本执行超时（${timeout / 1000} 秒），已强制结束脚本进程`));
		}, timeout);

		scriptPending.set(id, { resolve, reject, timer });
		try {
			worker.send({ id, ...request });
		} catch (error) {
			clearTimeout(timer);
			scriptPending.delete(id);
			reject(error);
		}
	});
}
