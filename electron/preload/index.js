import { contextBridge, ipcRenderer } from 'electron';
import { electronAPI } from '@electron-toolkit/preload';

// 自定义 bridge API（按需扩展）
/** @type {import('../../src/lib/lib').Api} */
const api = {
	ping: () => ipcRenderer.invoke('ping'),
	// 取 custom 目录下的 config.json，可传相对子路径（如 'ES2/config.json'）
	getConfig: (subPath) => ipcRenderer.invoke('config:get', subPath),
	// 系统内置目录（downloads / documents），供渲染进程解析 fileSrc 简写
	getPaths: () => ipcRenderer.invoke('app:paths'),
	// 运行 custom 目录下的读取脚本，返回解析后的数据
	readFile: (fileSrc, readScript) =>
		ipcRenderer.invoke('file:read', { fileSrc, readScript }),
	// 运行 custom 目录下的通用脚本（保存等），返回脚本结果
	runScript: (payload) => ipcRenderer.invoke('script:run', payload)
};

if (process.contextIsolated) {
	try {
		contextBridge.exposeInMainWorld('electron', electronAPI);
		contextBridge.exposeInMainWorld('api', api);
	} catch (error) {
		console.error(error);
	}
} else {
	window.electron = electronAPI;
	window.api = api;
}
