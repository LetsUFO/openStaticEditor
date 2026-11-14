import { contextBridge, ipcRenderer } from 'electron';
import { electronAPI } from '@electron-toolkit/preload';

// 自定义 bridge API（按需扩展）
/** @type {import('../../src/lib/lib').Api} */
const api = {
	ping: () => ipcRenderer.invoke('ping'),
	// 取 custom 目录下的 config.json，可传相对子路径（如 'ES2/config.json'）
	getConfig: (subPath) => ipcRenderer.invoke('config:get', subPath),
	// 扫描 custom 下的一级子目录，返回目录名数组
	listCustomDirs: () => ipcRenderer.invoke('config:scanSubdirs'),
	// 按 config.json 的 width / height 调整窗口内容尺寸
	setWindowSize: (width, height) => ipcRenderer.invoke('window:setSize', width, height),
	// 设置窗口标题（config.json 的 name + ver）
	setWindowTitle: (title) => ipcRenderer.invoke('window:setTitle', title),
	// 系统内置目录（downloads / documents），供渲染进程解析 fileSrc 简写
	getPaths: () => ipcRenderer.invoke('app:paths'),
	// 用系统浏览器打开外部链接（图片推广位跳转），主进程会校验域名白名单
	openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
	// 运行 custom 目录下的读取脚本，返回解析后的数据
	// baseSrc: 当前 custom 子目录（如 'Rustil/'），主进程会据此算出脚本子目录传给脚本
	readFile: (fileSrc, readScript, baseSrc) =>
		ipcRenderer.invoke('file:read', { fileSrc, readScript, baseSrc }),
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
