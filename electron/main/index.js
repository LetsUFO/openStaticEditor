import { app, BrowserWindow, ipcMain, net, protocol, screen, shell } from 'electron';
import { join, isAbsolute } from 'node:path';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import {
	createScriptEnv,
	createSystemPaths,
	executeScript,
	resolveScriptPath
} from '../../src/lib/lib';

// 示例：渲染进程可通过 window.api.ping() 调用
ipcMain.handle('ping', () => 'pong');

// 自定义协议：渲染进程用 app-asset://local/?src=<相对路径> 加载 custom 下的图片等静态资源。
// 必须在 app ready 前注册；dev（http 页面）下也能加载本地文件，避免 file:// 被浏览器拦截。
protocol.registerSchemesAsPrivileged([
	{
		scheme: 'app-asset',
		privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
	}
]);

// 系统内置目录：渲染进程解析 fileSrc 里的简写（%download% / %document% / %user%）时使用
const systemPaths = () => createSystemPaths((name) => app.getPath(name));
ipcMain.handle('app:paths', () => systemPaths());

// custom/config.json —— 运行（dev）与打包后都要能加载到
const DEFAULT_CONFIG = { name: 'OpenStaticEditor', width: 960, height: 680 };

// 当前窗口标题（渲染进程加载 config.json 后可动态更新，见 window:setTitle）
let windowTitle = '';

/**
 * custom 目录根路径（config.json 与用户脚本都在这里）。
 * 打包后：extraResources 把 custom 内容复制到 resources 目录（app.asar 之外，便于用户直接改）
 * dev：入口 out/main/index.js，向上两级即项目根
 */
function getCustomDir() {
	return app.isPackaged ? join(process.resourcesPath, 'custom') : join(__dirname, '../../custom');
}

/**
 * 根据 subPath 算出 custom 子目录：'ES2/config.json' → 'ES2/'，undefined → ''
 */
function getBaseSrc(subPath) {
	if (!subPath) return '';
	const idx = subPath.lastIndexOf('/');
	return idx >= 0 ? subPath.slice(0, idx + 1) : '';
}

/**
 * 需要重写的路径字段名（末尾匹配，大小写不敏感）。
 * 只有 key 命中这些关键字的 string 值才会加 baseSrc 前缀。
 */
const PATH_FIELD_SUFFIXES = [
	'script', // getSaveFiles, es2_loadout, es2_saveFile 等脚本路径
	'src', // background.src 图片路径
	'icon' // appIcon 图标
];
function isPathField(key) {
	if (typeof key !== 'string') return false;
	const lower = key.toLowerCase();
	return PATH_FIELD_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/**
 * 递归重写 config 对象中的路径字段：
 *   在已知的路径字段（key 以 script/src/icon 结尾）上，
 *   非空、不以 '/' / '%' / data: / blob: / http(s): 开头的值，
 *   前面加上 baseSrc（custom 子目录，如 'ES2/'）。
 *   Everspace2.ico + baseSrc='ES2/' → ES2/Everspace2.ico
 *   getSaveFiles.js + baseSrc='ES2/' → ES2/getSaveFiles.js
 * label、tip 等非路径字段原样保留。
 */
function rewriteCustomPaths(obj, baseSrc) {
	if (!baseSrc) return obj;
	const ABSOLUTE_PREFIXES = ['/', '%', 'data:', 'blob:', 'http:', 'https:'];
	const walk = (value, key) => {
		if (typeof value === 'string') {
			if (!isPathField(key)) return value; // 只重写路径字段
			if (!value || value.startsWith(baseSrc)) return value;
			const isAbsolute = ABSOLUTE_PREFIXES.some((p) => value.startsWith(p));
			return isAbsolute ? value : baseSrc + value;
		}
		if (Array.isArray(value)) return value.map((item) => walk(item, key));
		if (value && typeof value === 'object') {
			const result = {};
			for (const [k, v] of Object.entries(value)) {
				result[k] = walk(v, k);
			}
			return result;
		}
		return value;
	};
	return walk(obj);
}

/**
 * 规范化 config.json 的 ver：统一成「恰好一个 v 前缀」的展示值。
 *   配置里写 '0.1.3' / 'v0.1.3' / 'V0.1.3' → 一律返回 'v0.1.3'；未配置 → 原样返回。
 * 约定：config.json（用户可改区）只写纯 semver，v 是展示细节，由主进程读取时统一补齐。
 * 兼容历史配置已带 v 的写法，也兼容打包后用户手上的旧 custom 目录，避免出现 vv0.1.3。
 * 所有下游（窗口标题 / Pinia store / LoadProject 列表）拿到的 ver 都带 v，无需各自拼接。
 */
function normalizeConfigVer(cfg) {
	const raw = typeof cfg.ver === 'string' ? cfg.ver.trim() : '';
	if (!raw) return cfg;
	return { ...cfg, ver: `v${raw.replace(/^v+/i, '')}` };
}

/**
 * 读取 custom 目录下的 config.json。
 * @param {string} [subPath='config.json'] 相对 custom 目录的子路径（如 'ES2/config.json'）。
 */
function loadConfig(subPath = 'config.json') {
	const files = app.isPackaged
		? [join(getCustomDir(), subPath)]
		: [join(getCustomDir(), subPath), join(process.cwd(), 'custom', subPath)];

	for (const file of files) {
		try {
			const raw = JSON.parse(readFileSync(file, 'utf-8'));
			// 根据子目录重写所有 custom/ 路径，让后续脚本/资源加载直接用正确路径
			const baseSrc = getBaseSrc(subPath);
			return normalizeConfigVer(rewriteCustomPaths({ ...DEFAULT_CONFIG, ...raw }, baseSrc));
		} catch (error) {
			console.warn(`[config] 读取失败，尝试下一个：${file} (${error.message})`);
		}
	}
	console.warn(`[config] 未找到 custom/${subPath}，回退默认配置`);
	return normalizeConfigVer({ ...DEFAULT_CONFIG });
}

// 主进程自身先读顶层 config.json（用于窗口标题 fallback，渲染进程会按需加载子目录）
const config = loadConfig();

// 渲染进程（Pinia store）通过 window.api.getConfig(subPath) 加载指定子目录 config
ipcMain.handle('config:get', (_event, subPath) => loadConfig(subPath));

/**
 * 扫描 custom 下的一级子目录（每个游戏一个），返回目录名列表。
 * 渲染进程根据数量决定：只有 1 个 → 自动加载；多个 → 稍后让用户选择。
 */
ipcMain.handle('config:scanSubdirs', () => {
	const customDir = getCustomDir();
	if (!existsSync(customDir)) return [];
	const entries = readdirSync(customDir, { withFileTypes: true });
	return entries.filter((e) => e.isDirectory()).map((e) => e.name);
});

/**
 * 渲染进程加载 config.json 后，按其中的 width / height 调整窗口内容尺寸并重新居中。
 * 窗口创建时开启了 useContentSize，这里需要把内容尺寸换算成外框尺寸，
 * 再用一次 setBounds 同时设置位置和尺寸 —— 避免「先改尺寸、再 center」产生跳变或位置偏差。
 */
ipcMain.handle('window:setSize', (event, width, height) => {
	const win = BrowserWindow.fromWebContents(event.sender);
	if (!win) return;
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;

	// 外框尺寸 = 内容尺寸 + 边框/标题栏差值（getBounds 为外框，getContentBounds 为内容区）
	const frame = win.getBounds();
	const content = win.getContentBounds();
	const frameW = Math.round(width) + (frame.width - content.width);
	const frameH = Math.round(height) + (frame.height - content.height);

	// 以窗口当前所在显示器的可用区域（扣除菜单栏/Dock）为基准居中
	const area = screen.getDisplayMatching(frame).workArea;
	win.setBounds(
		{
			x: Math.round(area.x + (area.width - frameW) / 2),
			y: Math.round(area.y + (area.height - frameH) / 2),
			width: frameW,
			height: frameH
		},
		// macOS 支持原生窗口动画；位置和尺寸一次过渡，最终位置精确
		process.platform === 'darwin'
	);
});

/**
 * 渲染进程加载 config.json 后设置窗口标题（name + ver）。
 * 同步更新 windowTitle，避免页面标题事件（page-title-updated）把标题改回旧值。
 */
ipcMain.handle('window:setTitle', (event, title) => {
	const win = BrowserWindow.fromWebContents(event.sender);
	if (!win || typeof title !== 'string' || !title) return;
	windowTitle = title;
	win.setTitle(title);
});

/**
 * 图片推广位的跳转域名白名单。
 * config.json 属于用户可改区，如果直接透传 URL 给 shell.openExternal，
 * 配置被篡改后就会变成任意链接/本地文件跳转入口，所以这里只放行 https 的淘宝/天猫域名。
 */
const EXTERNAL_HOST_SUFFIXES = ['taobao.com', 'tmall.com', 'tmall.hk', 'afdian.com', 'afdian.net'];

/**
 * 用系统浏览器打开外部链接（目前用于侧栏图片推广位）。
 * 校验失败返回 false，由渲染层决定是否提示。
 */
ipcMain.handle('shell:openExternal', async (_event, url) => {
	if (typeof url !== 'string') return false;

	let target;
	try {
		target = new URL(url);
	} catch {
		return false;
	}
	if (target.protocol !== 'https:') return false;

	const host = target.hostname.toLowerCase();
	const allowed = EXTERNAL_HOST_SUFFIXES.some(
		(domain) => host === domain || host.endsWith(`.${domain}`)
	);
	if (!allowed) {
		console.warn(`[shell] 拒绝打开非白名单链接：${url}`);
		return false;
	}

	await shell.openExternal(url);
	return true;
});

/**
 * 定位并加载 custom 目录下的脚本模块（每次清缓存，脚本改动后无需重启应用）。
 * @param {string} scriptSrc 脚本相对路径（如 'Rustil/loadSaveFile.js'，已由 getConfig 重写）
 * @param {string} [baseSrc] 当前 custom 子目录（如 'Rustil/'），由渲染层从 store 里传入
 *   - 有 baseSrc：customDir = join(customRoot, baseSrc) → 脚本所在子目录，脚本可读同目录辅助文件
 *   - 无 baseSrc：customDir = customRoot → 兼容旧调用方
 */
function loadScriptModule(scriptSrc, baseSrc) {
	const customRoot = getCustomDir();
	// customDir：脚本运行时的工作目录，脚本里读同目录文件用它
	const customDir = baseSrc ? join(customRoot, baseSrc) : customRoot;

	const scriptPath = resolveScriptPath(scriptSrc, {
		customDir: customRoot, // 脚本定位始终从 customRoot 开始（scriptSrc 已经带了子目录前缀）
		projectRoot: app.isPackaged ? process.resourcesPath : join(__dirname, '../../'),
		isAbsolute,
		join,
		exists: existsSync
	});
	// require 会缓存模块，脚本修改后需要清缓存才能重新加载
	const resolved = require.resolve(scriptPath);
	delete require.cache[resolved];
	return { customDir, script: require(resolved) };
}

/**
 * 运行读取脚本（readScript），返回解析后的数据。
 * 脚本约定（CommonJS）：
 *   module.exports = function (ctx) {
 *     // ctx.fileSrc       —— config.json 里配置的原始文件路径
 *     // ctx.filePath      —— 解析后的绝对路径（相对路径按 custom 目录解析）
 *     // ctx.customDir     —— custom 目录绝对路径，方便脚本读取同目录其它资源
 *     // ctx.downloadsPath —— 系统下载目录绝对路径
 *     // ctx.documentsPath —— 系统文档目录绝对路径
 *     // return 解析后的数据（同步或 Promise 均可）
 *   }
 * 若脚本直接导出数据（非函数），则原样返回。
 */
ipcMain.handle('file:read', async (_event, { fileSrc, readScript, baseSrc } = {}) => {
	if (!readScript) throw new Error('未配置 readScript，无法加载读取脚本');

	const { customDir, script } = loadScriptModule(readScript, baseSrc);
	const filePath = fileSrc ? (isAbsolute(fileSrc) ? fileSrc : join(customDir, fileSrc)) : '';

	return executeScript(script, {
		fileSrc,
		filePath,
		...createScriptEnv(customDir, systemPaths())
	});
});

/**
 * 运行 custom 目录下的通用脚本（目前用于保存：saveScript 拿表单数据写回存档）。
 * 请求参数：{ scriptSrc, dataKey, filePath, data }，脚本函数收到
 * ctx = { scriptSrc, dataKey, filePath, data, customDir, ... }
 * （下拉选项过滤已移到渲染进程 store 内完成，不再走这里）
 */
ipcMain.handle('script:run', async (_event, payload = {}) => {
	const { scriptSrc, dataKey, filePath, data, baseSrc } = payload;

	if (!scriptSrc) throw new Error('未配置 scriptSrc，无法运行脚本');

	const { customDir, script } = loadScriptModule(scriptSrc, baseSrc);

	return executeScript(script, {
		scriptSrc,
		dataKey,
		filePath,
		data,
		...createScriptEnv(customDir, systemPaths())
	});
});

function createWindow() {
	// 窗口标题：config.json 的 name + ver（ver 已由 loadConfig 规范化为带 "v"）；
	// 缺省回退 package.json version —— app.getVersion() 返回纯 semver，这里补 "v" 保持展示一致
	const fallbackVer = `v${app.getVersion()}`;
	windowTitle = `${config.name} ${config.ver || fallbackVer}`;

	const mainWindow = new BrowserWindow({
		width: config.width,
		height: config.height,
		title: windowTitle,
		show: false,
		center: true,
		autoHideMenuBar: true,
		webPreferences: {
			preload: join(__dirname, '../preload/index.js'),
			sandbox: false
		},
		useContentSize: true
	});

	mainWindow.on('ready-to-show', () => mainWindow.show());

	// 页面加载后，Electron 会用 HTML 的 <title> 覆盖窗口标题（page-title-updated），
	// 这里阻止该行为，并把标题锁定为 windowTitle。
	const applyWindowTitle = () => {
		if (mainWindow.getTitle() !== windowTitle) mainWindow.setTitle(windowTitle);
	};
	mainWindow.on('page-title-updated', (event) => {
		event.preventDefault();
		applyWindowTitle();
	});
	mainWindow.webContents.on('did-finish-load', applyWindowTitle);

	// 禁止在应用内打开新窗口（安全）
	mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

	if (is.dev && process.env.ELECTRON_RENDERER_URL) {
		mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
	} else {
		mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
	}
}

app.whenReady().then(() => {
	electronApp.setAppUserModelId('com.azrael.openstaticeditor');

	// 路径解析规则与脚本一致：绝对路径直接用；相对路径先找 custom，再回退项目根/resources
	protocol.handle('app-asset', (request) => {
		const src = new URL(request.url).searchParams.get('src') || '';
		if (!src) return new Response('Bad Request', { status: 400 });
		const filePath = resolveScriptPath(src, {
			customDir: getCustomDir(),
			projectRoot: app.isPackaged ? process.resourcesPath : join(__dirname, '../../'),
			isAbsolute,
			join,
			exists: existsSync
		});
		return net.fetch(pathToFileURL(filePath).toString());
	});

	app.on('browser-window-created', (_, window) => {
		optimizer.watchWindowShortcuts(window);
	});

	createWindow();

	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') app.quit();
});
