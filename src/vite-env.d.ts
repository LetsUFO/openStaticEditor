/// <reference types="vite/client" />

// custom/config.json 的结构（单一来源：主进程读取、store 与组件共用此类型）
interface AppConfig {
	name: string;
	width: number;
	height: number;
	// config.json 可自行扩展字段，都会原样带过来
	[key: string]: unknown;
}

interface Window {
	// preload 通过 contextBridge 暴露的自定义 API
	api: {
		ping: () => Promise<string>;
		getConfig: () => Promise<AppConfig>;
	};
}
