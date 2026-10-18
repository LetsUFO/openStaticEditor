# OpenStaticEditor

Vue 3 + Pinia + Electron 桌面应用骨架，使用 electron-vite 构建，可打包成 Windows `.exe` 安装包。

## 技术栈
- Vue 3（`<script setup>`）
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
产物位于 `release/<version>/OpenStaticEditor-<version>-setup.exe`。

macOS 上打包 dmg：
```bash
npm run dist:mac
```

## 镜像说明
默认 npm 源（nexus / 华为云）对 `electron` 返回 502，本项目 `.npmrc` 已切换到
npmmirror（`registry.npmmirror.com`）并配置 `ELECTRON_MIRROR`，确保 electron 二进制可下载。
若你的网络能直连官方源，可删除 `.npmrc` 改用默认。
