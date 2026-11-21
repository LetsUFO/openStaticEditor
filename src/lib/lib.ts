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

/**
 * 把 fileSrc 按 `|` 拆成多个备选文件路径，并去掉首尾空白。
 * 例如 `%download%/a.svd|%download%/b.svd` => [a, b]。
 */
export function splitFileSrcCandidates(fileSrc: string): string[] {
	if (!fileSrc) return [];
	return fileSrc
		.split('|')
		.map((item) => item.trim())
		.filter(Boolean);
}

/**
 * 判断 loadFiles 的一个条目是否「真正配置了可加载的文件」。
 * loadFiles 下的字段名是开放的：条目名（key，如 RPW_DATA / base）可任意，
 * 子字段也不局限于 fileSrc / filePath / useFolderSelect，所以这里不枚举具体字段名。
 * 判定标准：只要条目对象里存在任意一个非空值（非 "" / null / undefined / false），
 * 即视为已配置、需要参与加载流程；全空的占位条目（模板里子字段全为 ""）才过滤掉，
 * 避免加载页出现空行、或加载时报「未配置 fileSrc」卡住。
 */
export function isLoadFileEntryConfigured(entry: unknown): boolean {
	if (!entry || typeof entry !== 'object') return false;
	return Object.values(entry as Record<string, unknown>).some(
		(v) => v !== '' && v != null && v !== false
	);
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
	listCustomDirs: () => Promise<string[]>;
	setWindowSize: (width: number, height: number) => Promise<void>;
	setWindowTitle: (title: string) => Promise<void>;
	getPaths: () => Promise<SystemPaths>;
	/**
	 * 弹出原生文件夹选择对话框，供 useFolderSelect 条目让用户手动选择目录。
	 * @param defaultPath 对话框默认打开的目录（通常传该条目已选的 file.filePath）
	 * @returns 选中目录的绝对路径；用户取消时返回空串
	 */
	selectDirectory: (defaultPath?: string) => Promise<string>;
	/** baseSrc: 当前 custom 子目录（如 'Rustil/'），由主进程 join(customRoot, baseSrc) 算出脚本子目录 */
	readFile: (fileSrc: string, readScript: string, baseSrc?: string) => Promise<any>;
	runScript: (payload: {
		scriptSrc: string;
		dataKey?: string;
		filePath?: string;
		data?: any;
		/** baseSrc: 当前 custom 子目录（如 'Rustil/'），由主进程 join(customRoot, baseSrc) 算出脚本子目录 */
		baseSrc?: string;
	}) => Promise<any>;
	/**
	 * 调用 switch 配置 script 模块导出的方法（method 取 on/off 字段配置的方法名）。
	 * 主进程常驻缓存该模块（on/off 共享模块内部状态），只调用一次、不等待执行完成；
	 * 是否常驻由脚本自行控制（如 on 启动循环、off 置标志位结束）。
	 */
	invokeScript: (payload: {
		scriptSrc: string;
		method: string;
		/** true：重新读取脚本文件（开启）；false：复用已加载实例（关闭） */
		reload?: boolean;
		baseSrc?: string;
	}) => Promise<{ ok: boolean }>;
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

/**
 * 清理脚本抛错经 IPC 回传时的包装，只保留脚本自己抛出的业务提示。
 * Electron 会把主进程错误包成「Error invoking remote method 'file:read': Error: xxx」，
 * 这些前缀对用户没有意义，展示前统一剥掉。
 */
export function cleanScriptError(err: any): string {
	return String(err?.message || err)
		.replace(/^Error invoking remote method '[^']*':\s*/, '')
		.replace(/^Error:\s*/, '');
}
