/**
 * 根据 custom/config.json 的 appIcon 生成打包图标：
 *   build/icon.ico   —— Windows（exe / NSIS 安装器）
 *   build/icon.icns  —— macOS（.app）
 * electron-builder 默认读取 build/ 下的这两个文件，因此 package.json 里无需再指定 icon。
 *
 * 由 electron.vite.config.js 的图标插件在每次构建时调用（build/package/dist/… 都经过 electron-vite build），
 * 也可以手动执行：node scripts/build-icons.js
 */
const { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, mkdtempSync } = require('node:fs');
const { join, resolve, extname } = require('node:path');
const { execFileSync } = require('node:child_process');
const { tmpdir } = require('node:os');

const root = resolve(__dirname, '..');
const buildDir = join(root, 'build');
const icoTarget = join(buildDir, 'icon.ico');
const icnsTarget = join(buildDir, 'icon.icns');

// iconset 标准尺寸；源图最大 256，不生成 1024（放大只会更糊）
const ICONSET = [
	{ name: 'icon_16x16.png', size: 16 },
	{ name: 'icon_16x16@2x.png', size: 32 },
	{ name: 'icon_32x32.png', size: 32 },
	{ name: 'icon_32x32@2x.png', size: 64 },
	{ name: 'icon_128x128.png', size: 128 },
	{ name: 'icon_128x128@2x.png', size: 256 },
	{ name: 'icon_256x256.png', size: 256 },
	{ name: 'icon_256x256@2x.png', size: 512 },
	{ name: 'icon_512x512.png', size: 512 }
];

function log(message) {
	console.log(`[icons] ${message}`);
}

function resolveAppIcon() {
	let config;
	try {
		config = JSON.parse(readFileSync(join(root, 'custom', 'config.json'), 'utf-8'));
	} catch (error) {
		log(`读取 custom/config.json 失败：${error.message}`);
		return '';
	}

	const icon = typeof config.appIcon === 'string' ? config.appIcon.trim() : '';
	if (!icon) {
		log('config.json 未配置 appIcon');
		return '';
	}

	// 兼容 "custom/xxx.ico"（相对项目根）与 "xxx.ico"（相对 custom 目录）两种写法
	const candidates = [join(root, icon), join(root, 'custom', icon)];
	const found = candidates.find((file) => existsSync(file));
	if (!found) log(`appIcon 指向的文件不存在：${icon}`);
	return found;
}

function buildIcns(source) {
	const workDir = mkdtempSync(join(tmpdir(), 'openstaticeditor-icon-'));
	const iconsetDir = join(workDir, 'App.iconset');
	mkdirSync(iconsetDir, { recursive: true });

	try {
		// sips 既能读 .ico（取出最大帧），也能直接处理 .png
		const basePng = join(workDir, 'base.png');
		execFileSync('sips', ['-s', 'format', 'png', source, '--out', basePng], {
			stdio: 'ignore'
		});

		for (const { name, size } of ICONSET) {
			execFileSync(
				'sips',
				['-z', String(size), String(size), basePng, '--out', join(iconsetDir, name)],
				{ stdio: 'ignore' }
			);
		}

		execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', icnsTarget], { stdio: 'ignore' });
	} finally {
		rmSync(workDir, { recursive: true, force: true });
	}
}

async function buildIcons() {
	const source = resolveAppIcon();
	if (!source) {
		log('未生成自定义图标，打包将使用 electron-builder 默认图标');
		return;
	}

	mkdirSync(buildDir, { recursive: true });
	log(`appIcon -> ${source}`);

	if (extname(source).toLowerCase() === '.ico') {
		copyFileSync(source, icoTarget);
		log('已生成 Windows 图标 build/icon.ico');
	} else {
		// electron-builder 会用 build/icon.png 自行转换 Windows 图标
		copyFileSync(source, join(buildDir, 'icon.png'));
		log('appIcon 不是 .ico，已生成 build/icon.png 交由 electron-builder 转换');
	}

	if (process.platform !== 'darwin') {
		log('非 macOS 平台，跳过 build/icon.icns');
		return;
	}

	try {
		buildIcns(source);
		log('已生成 macOS 图标 build/icon.icns');
	} catch (error) {
		log(`生成 macOS 图标失败，打包将使用默认图标：${error.message}`);
	}
}

// electron-builder 的 beforePack 钩子会直接加载本模块并调用导出的函数，
// 这里不能 process.exit，否则会中断打包进程。
module.exports = buildIcons;

if (require.main === module) {
	buildIcons();
}
