// custom 层自包含测试：不引用主程序任何内部实现。
// - 作为外部脚本被主程序调用时：导出 on() / off()；
// - 命令行运行 node test.js：执行本文件内的用例（含超时/无反馈/异常模拟）。
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const CONFIG_FILE = path.join(DIR, 'config.json');
const RESULT_FILE = path.join(DIR, 'test.log');
const TIMEOUT = 500; // 本地模拟「没有反馈」的超时阈值（毫秒）

/** 递归收集所有 switch 且配置了脚本的字段项 */
function collectSwitchItems(node, out = []) {
	if (!node || typeof node !== 'object') return out;
	if (node.type === 'switch' && node.script && node.onFnName && node.offFnName) out.push(node);
	for (const value of Object.values(node)) collectSwitchItems(value, out);
	return out;
}

/** 本地超时包装：模拟调用方对「没有反馈」的处理，由脚本自身实现 */
function withTimeout(promise, ms = TIMEOUT, label = '调用') {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`${label}超时（${ms} 毫秒），没有反馈`)),
			ms
		);
		Promise.resolve(promise).then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			}
		);
	});
}

function appendResult(lines) {
	fs.appendFileSync(RESULT_FILE, lines.join('\n') + '\n');
}

// ---------------------------------------------------------------- 主程序调用（真实场景）
// 主程序通过隔离执行器加载本脚本并调用 onFnName/offFnName。
function on() {
	try {
		const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
		const item = collectSwitchItems(config).find((li) => li.script === 'test.js');
		const lines = [
			`[test] on 执行 ${new Date().toISOString()} pid=${process.pid} platform=${process.platform}`,
			item
				? `[test] 命中配置项「${item.label}」，方法 ${item.onFnName}/${item.offFnName}`
				: '[test] 配置中未找到 test.js 对应的 switch',
			'[test] PASS 主程序已加载本脚本并成功调用 on'
		];
		appendResult(lines);
		console.log(lines.join('\n'));
		return Promise.resolve();
	} catch (error) {
		appendResult([`[test] FAIL on 执行异常：${error.message}`]);
		return Promise.reject(error);
	}
}

function off() {
	appendResult([`[test] off 执行 ${new Date().toISOString()} pid=${process.pid}`]);
	return Promise.resolve();
}

module.exports = { on, off };

// ---------------------------------------------------------------- 命令行自检
if (require.main === module) {
	let failures = 0;
	const check = (name, cond, extra = '') => {
		console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${extra ? ' -> ' + extra : ''}`);
		if (!cond) failures++;
	};

	(async () => {
		// 1. 导出契约
		check('导出 on/off 函数', typeof module.exports.on === 'function' && typeof module.exports.off === 'function');
		check('on/off 返回 Promise', module.exports.on() instanceof Promise, 'on');
		module.exports.off();

		// 2. 配置绑定：config.json 里的方法名必须与导出方法一致
		let item = null;
		try {
			const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
			item = collectSwitchItems(config).find((li) => li.script === 'test.js') || null;
			check('配置中存在 test.js 开关项', !!item);
		} catch (error) {
			check('读取 config.json', false, error.message);
		}
		if (item) {
			check(
				'配置方法名与导出方法匹配',
				typeof module.exports[item.onFnName] === 'function' &&
					typeof module.exports[item.offFnName] === 'function',
				`${item.onFnName}/${item.offFnName}`
			);
		}

		// 3. 正常反馈
		let normal = '';
		try {
			normal = await withTimeout(Promise.resolve('ok'));
		} catch (error) {
			normal = error.message;
		}
		check('正常反馈可返回', normal === 'ok', normal);

		// 4. 没有反馈（永不 resolve）
		let noFeedback = '';
		try {
			await withTimeout(new Promise(() => {}));
		} catch (error) {
			noFeedback = error.message;
		}
		check('没有反馈时本地超时生效', noFeedback.includes('没有反馈'), noFeedback);

		// 5. 异常反馈
		let abnormal = '';
		try {
			await withTimeout(Promise.reject(new Error('模拟执行异常')));
		} catch (error) {
			abnormal = error.message;
		}
		check('异常反馈可传递', abnormal === '模拟执行异常', abnormal);

		// 6. 结果落盘
		const log = fs.existsSync(RESULT_FILE) ? fs.readFileSync(RESULT_FILE, 'utf8') : '';
		check('执行记录已写入 test.log', log.includes('[test] on 执行'));

		console.log(failures ? `${failures} 项失败` : '全部通过');
		process.exit(failures ? 1 : 0);
	})().catch((error) => {
		console.error('测试异常：', error);
		process.exit(2);
	});
}
