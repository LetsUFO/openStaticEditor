# OpenStaticEditor

Vue 3 + Pinia + Electron 桌面应用骨架，使用 electron-vite 构建，可打包成 Windows `.exe` 安装包。

## 技术栈
- Vue 3（`<script setup lang="ts">`）
- Pinia（状态管理，已接入）
- Vite（构建工具，经 electron-vite 驱动）
- Electron（桌面运行时）
- electron-builder（打包 exe / dmg）

## 目录结构
```
openStaticEditor/
├── .npmrc                      # 使用 npmmirror 镜像，解决私有源 502
├── electron.vite.config.js     # electron-vite 配置
├── package.json
├── electron/
│   ├── main/index.js           # 主进程
│   └── preload/index.js        # 预加载桥接
└── src/                        # 渲染进程（Vue 应用）
    ├── index.html
    ├── main.js                 # 入口：createApp + Pinia
    ├── App.vue
    ├── stores/counter.js       # Pinia store 示例
    └── components/HelloWorld.vue
```

## 开发 / 构建
```bash
npm install          # 安装依赖（已配置 npmmirror 镜像）
npm run dev          # 开发模式（带 HMR）
npm run build        # 仅编译到 out/
```

## 打包成 exe（Windows 安装包）
> ⚠️ 在 **Windows** 机器上执行（macOS 无法直接产出 nsis exe 安装包）：
```bash
npm run dist:win
```
产物位于 `release/v<version>/<name>-v<version>-setup.exe`，例如 `release/v0.4.0/openStaticEditor-v0.4.0-setup.exe`。

> `package.json` 的 `version` 必须写成纯 semver（如 `0.4.0`），供 npm / electron-builder 解析。
> `v` 前缀只加在展示与产物命名上：构建脚本由 `scripts/custom-meta.js` 统一补齐，
> UI 由 `src/App.vue`、窗口标题回退由 `electron/main/index.js` 各自补齐。

macOS 上打包 dmg：
```bash
npm run dist:mac
```

## 镜像说明
默认 npm 源（nexus / 华为云）对 `electron` 返回 502，本项目 `.npmrc` 已切换到
npmmirror（`registry.npmmirror.com`）并配置 `ELECTRON_MIRROR`，确保 electron 二进制可下载。
若你的网络能直连官方源，可删除 `.npmrc` 改用默认。

## 数据对接
needFileKey和loadFiles下key匹配
saveScript:指定所需的文件key，传给脚本