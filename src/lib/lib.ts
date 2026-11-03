/**
 * 通用工具：系统目录简写解析 + 外部脚本执行约定。
 * 渲染进程（App.vue / LoadFile.vue）与主进程（electron/main/index.js）共用。
 * 只放纯逻辑：path / fs 等能力由调用方传入，避免渲染进程打包时引入 node 内置模块。
 */

/** 系统目录映射：主进程 app:paths 与渲染进程 window.api.getPaths() 返回同构对象 */
export interface SystemPaths {
	downloads: string;
	documents: string;
	user: string;
}

/** 把 Electron app.getPath 的结果收敛成 SystemPaths（主进程专用） */
export function createSystemPaths(
	getPath: (name: 'downloads' | 'documents' | 'home') => string
): SystemPaths {
	return {
		downloads: getPath('downloads'),
		documents: getPath('documents'),
		user: getPath('home')
	};
}

/** 简写名 → SystemPaths 键（比较时统一转小写） */
const SHORTCUT_KEYS: Record<string, keyof SystemPaths> = {
	download: 'downloads',
	document: 'documents',
	user: 'user'
};

/**
 * 解析路径里的系统目录简写（成对 %，不区分大小写）：
 *   %download% → 系统下载目录，%document% → 系统文档目录，%user% → 用户主目录
 * 无简写时原样返回；未知简写抛错，避免静默拼出错误路径。
 */
export function resolvePathShorthand(fileSrc: string, paths: SystemPaths): string {
	if (!fileSrc || !fileSrc.includes('%')) return fileSrc;
	return fileSrc.replace(/%([^%]+)%/g, (_match, key: string) => {
		const field = SHORTCUT_KEYS[key.toLowerCase()];
		if (!field) {
			throw new Error(`未知路径简写 %${key}%（当前支持 %download% / %document% / %user%）`);
		}
		return paths[field];
	});
}

/** 外部脚本 ctx 的通用字段（每个脚本都会收到） */
export interface ScriptEnv {
	customDir: string;
	downloadsPath: string;
	documentsPath: string;
}

export function createScriptEnv(customDir: string, paths: SystemPaths): ScriptEnv {
	return {
		customDir,
		downloadsPath: paths.downloads,
		documentsPath: paths.documents
	};
}

/** preload 通过 contextBridge 暴露到 window.api 的接口（渲染进程与 preload 共用此类型） */
export interface Api {
	ping: () => Promise<string>;
	getConfig: (subPath?: string) => Promise<AppConfig>;
	getPaths: () => Promise<SystemPaths>;
	readFile: (fileSrc: string, readScript: string) => Promise<any>;
	runScript: (payload: {
		scriptSrc: string;
		dataKey?: string;
		filePath?: string;
		data?: any;
	}) => Promise<any>;
}

export interface ScriptPathEnv {
	customDir: string;
	projectRoot: string;
	/** 由主进程传入 node:path 的 isAbsolute */
	isAbsolute: (path: string) => boolean;
	/** 由主进程传入 node:path 的 join */
	join: (dir: string, name: string) => string;
	/** 由主进程传入 node:fs 的 existsSync */
	exists: (path: string) => boolean;
}

/**
 * 脚本路径解析：绝对路径直接使用；相对路径先找 customDir，找不到再回退项目根
 * （如 "read_base.js" 找 custom 目录，"custom/read_base.js" 找项目根 / 打包后的 resources）。
 */
export function resolveScriptPath(scriptSrc: string, env: ScriptPathEnv): string {
	if (env.isAbsolute(scriptSrc)) return scriptSrc;
	const fromCustom = env.join(env.customDir, scriptSrc);
	return env.exists(fromCustom) ? fromCustom : env.join(env.projectRoot, scriptSrc);
}

/**
 * 外部脚本约定（CommonJS）：
 *   module.exports = function (ctx) { ... }  // 导出函数 → 用 ctx 调用
 *   module.exports = { ... }                 // 非函数 → 原样返回
 * ESM 转译后的 default 导出同样按函数处理。
 */
export async function executeScript(script: any, ctx: Record<string, any>): Promise<any> {
	const reader = typeof script === 'function' ? script : script?.default;
	return typeof reader === 'function' ? await reader(ctx) : script;
}
