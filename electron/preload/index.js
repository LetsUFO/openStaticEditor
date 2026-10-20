import { contextBridge, ipcRenderer } from 'electron';
import { electronAPI } from '@electron-toolkit/preload';

// 自定义 bridge API（按需扩展）
const api = {
	ping: () => ipcRenderer.invoke('ping'),
	// 取主进程加载的 custom/config.json
	getConfig: () => ipcRenderer.invoke('config:get')
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
