import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import { ipcMain } from 'electron';

// 示例：渲染进程可通过 window.api.ping() 调用
ipcMain.handle('ping', () => 'pong');

function createWindow() {
	const mainWindow = new BrowserWindow({
		width: 960,
		height: 680,
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
