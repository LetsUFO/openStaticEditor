import { app, BrowserWindow, ipcMain } from 'electron';
import { join, isAbsolute } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';

// 示例：渲染进程可通过 window.api.ping() 调用
ipcMain.handle('ping', () => 'pong');

// 系统内置目录：渲染进程解析 fileSrc 里的简写（%download% / %document%）时使用
ipcMain.handle('app:paths', () => ({
	downloads: app.getPath('downloads'),
	documents: app.getPath('documents')
}));

// custom/config.json —— 运行（dev）与打包后都要能加载到
const DEFAULT_CONFIG = { name: 'OpenStaticEditor', width: 960, height: 680 };

/**
 * custom 目录根路径（config.json 与用户脚本都在这里）。
 * 打包后：extraResources 把 custom 内容复制到 resources 目录（app.asar 之外，便于用户直接改）
 * dev：入口 out/main/index.js，向上两级即项目根
 */
function getCustomDir() {
	return app.isPackaged ? join(process.resourcesPath, 'custom') : join(__dirname, '../../custom');
}

function loadConfig() {
	const files = app.isPackaged
		? [join(getCustomDir(), 'config.json')]
		: [join(getCustomDir(), 'config.json'), join(process.cwd(), 'custom/config.json')];

	for (const file of files) {
		try {
			return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(file, 'utf-8')) };
		} catch (error) {
			console.warn(`[config] 读取失败，尝试下一个：${file} (${error.message})`);
		}
	}
	console.warn('[config] 未找到 custom/config.json，回退默认配置');
	return { ...DEFAULT_CONFIG };
}

const config = loadConfig();

// 渲染进程（Pinia store）通过 window.api.getConfig() 取同一份数据
ipcMain.handle('config:get', () => config);

/**
 * 运行 custom 目录下的读取脚本，返回解析后的数据。
 * 脚本约定（CommonJS）：
 *   module.exports = function (ctx) {
 *     // ctx.fileSrc       —— config.json 里配置的原始文件路径
 *     // ctx.filePath      —— 解析后的绝对路径（相对路径按 custom 目录解析）
 *     // ctx.customDir     —— custom 目录绝对路径，方便脚本读取同目录其它资源
 *     // ctx.downloadsPath —— 系统下载目录绝对路径（Electron 官方 getPath('downloads')）
 *     // ctx.documentsPath —— 系统文档目录绝对路径（Electron 官方 getPath('documents')）
 *     // return 解析后的数据（同步或 Promise 均可）
 *   }
 * 若脚本直接导出数据（非函数），则原样返回。
 *
 * 脚本路径解析顺序（相对 readScriptSrc）：
 *   1. customDir 下（如 readScriptSrc = "read_base.js"）
 *   2. 项目根下（如 readScriptSrc = "custom/read_base.js"，打包后同 resources 目录）
 *   绝对路径直接使用。
 */
ipcMain.handle('file:read', async (_event, { fileSrc, readScriptSrc } = {}) => {
	const customDir = getCustomDir();

	if (!readScriptSrc) {
		throw new Error('未配置 readScriptSrc，无法加载读取脚本');
	}

	// 脚本路径：绝对路径直接用，否则依次尝试 customDir 下 与 项目根下
	let scriptPath;
	if (isAbsolute(readScriptSrc)) {
		scriptPath = readScriptSrc;
	} else {
		const fromCustom = join(customDir, readScriptSrc);
		const projectRoot = app.isPackaged ? process.resourcesPath : join(__dirname, '../../');
		const fromRoot = join(projectRoot, readScriptSrc);
		scriptPath = existsSync(fromCustom) ? fromCustom : fromRoot;
	}

	const filePath = fileSrc ? (isAbsolute(fileSrc) ? fileSrc : join(customDir, fileSrc)) : '';

	// require 会缓存模块，脚本修改后需要清缓存才能重新加载
	const resolved = require.resolve(scriptPath);
	delete require.cache[resolved];
	const script = require(resolved);

	// 支持函数导出 与 直接数据导出
	const reader = typeof script === 'function' ? script : script?.default;
	const ctx = {
		fileSrc,
		filePath,
		customDir,
		downloadsPath: app.getPath('downloads'),
		documentsPath: app.getPath('documents')
	};
	const data = typeof reader === 'function' ? await reader(ctx) : script;

	return data;
});

/**
 * 运行 custom 目录下的通用脚本（目前用于保存：saveScript 拿表单数据写回存档）。
 * 请求参数：{ scriptSrc, dataKey, filePath, data }，脚本函数收到
 * ctx = { scriptSrc, dataKey, filePath, data, customDir, ... }
 * （下拉选项过滤已移到渲染进程 store 内完成，不再走这里）
 */
ipcMain.handle('script:run', async (_event, payload = {}) => {
	const { scriptSrc, dataKey, filePath, data } = payload;

	if (!scriptSrc) throw new Error('未配置 scriptSrc，无法运行脚本');

	const customDir = getCustomDir();
	let scriptPath;
	if (isAbsolute(scriptSrc)) {
		scriptPath = scriptSrc;
	} else {
		const fromCustom = join(customDir, scriptSrc);
		const projectRoot = app.isPackaged ? process.resourcesPath : join(__dirname, '../../');
		const fromRoot = join(projectRoot, scriptSrc);
		scriptPath = existsSync(fromCustom) ? fromCustom : fromRoot;
	}

	// require 会缓存模块，脚本修改后需要清缓存才能重新加载
	const resolved = require.resolve(scriptPath);
	delete require.cache[resolved];
	const script = require(resolved);

	const reader = typeof script === 'function' ? script : script?.default;
	const ctx = {
		scriptSrc,
		dataKey,
		filePath,
		data,
		customDir,
		downloadsPath: app.getPath('downloads'),
		documentsPath: app.getPath('documents')
	};

	return typeof reader === 'function' ? await reader(ctx) : script;
});

function createWindow() {
	const mainWindow = new BrowserWindow({
		width: config.width,
		height: config.height,
		title: config.name,
		show: false,
		autoHideMenuBar: true,
		webPreferences: {
			preload: join(__dirname, '../preload/index.js'),
			sandbox: false
		},
		useContentSize: true
	});

	mainWindow.on('ready-to-show', () => mainWindow.show());

	// 页面加载后，Electron 会用 HTML 的 <title> 覆盖窗口标题（page-title-updated），
	// 这里阻止该行为，并把标题锁定为 custom/config.json 的 name。
	const applyWindowTitle = () => {
		if (mainWindow.getTitle() !== config.name) mainWindow.setTitle(config.name);
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
