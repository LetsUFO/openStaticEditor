import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';

// 示例：渲染进程可通过 window.api.ping() 调用
ipcMain.handle('ping', () => 'pong');

// custom/config.json —— 运行（dev）与打包后都要能加载到
const DEFAULT_CONFIG = { name: 'OpenStaticEditor', width: 960, height: 680 };

function loadConfig() {
	// 打包后：extraResources 把 config.json 复制到 resources 目录（app.asar 之外，便于用户直接改）
	// dev：入口 out/main/index.js，向上两级即项目根
	const files = app.isPackaged ? [join(process.resourcesPath, 'config.json')] : [join(__dirname, '../../custom/config.json'), join(process.cwd(), 'custom/config.json')];

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
