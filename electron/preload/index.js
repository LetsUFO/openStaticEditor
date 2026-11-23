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
	// 弹出原生文件夹选择对话框，返回选中目录绝对路径（用户取消返回空串），供 useFolderSelect 使用
	selectDirectory: (defaultPath) => ipcRenderer.invoke('dialog:openDirectory', defaultPath),
	// 运行 custom 目录下的读取脚本，返回解析后的数据
	// 脚本工作目录由主进程按脚本自身位置推导，无需传 baseSrc
	// fileName 来自 config.json -> loadFiles[key].fileName，供脚本定位目标文件
	readFile: (fileSrc, readScript, fileName) =>
		ipcRenderer.invoke('file:read', { fileSrc, readScript, fileName }),
	// 运行 custom 目录下的通用脚本（保存等），返回脚本结果
	runScript: (payload) => ipcRenderer.invoke('script:run', payload),
	// 调用 switch 的 script 模块导出方法（payload.method 为 on/off 配置的方法名）：
	// 模块在主进程常驻缓存，只调用一次、不等待完成，常驻由脚本自控
	invokeScript: (payload) => ipcRenderer.invoke('script:invoke', payload)
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
