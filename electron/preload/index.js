import { contextBridge, ipcRenderer } from 'electron';
import { electronAPI } from '@electron-toolkit/preload';

// 自定义 bridge API（按需扩展）
const api = {
	ping: () => ipcRenderer.invoke('ping'),
	// 取主进程加载的 custom/config.json
	getConfig: () => ipcRenderer.invoke('config:get'),
	// 系统内置目录（downloads / documents），供渲染进程解析 fileSrc 简写
	getPaths: () => ipcRenderer.invoke('app:paths'),
	// 运行 custom 目录下的读取脚本，返回解析后的数据
	readFile: (fileSrc, readScriptSrc) =>
		ipcRenderer.invoke('file:read', { fileSrc, readScriptSrc }),
	// 运行 custom 目录下的选项脚本，返回下拉选项数组
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
