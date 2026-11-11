# OpenStaticEditor

Vue 3 + Pinia + Electron 桌面应用骨架，使用 electron-vite 构建，可打包成 Windows `.exe` 直接运行。

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

> `package.json` 的 `version` 必须写成纯 semver（如 `0.4.0`），供 npm / electron-builder 解析。
> `v` 前缀只加在展示与产物命名上：构建脚本由 `scripts/custom-meta.js` 统一补齐，
> UI 由 `src/App.vue`、窗口标题回退由 `electron/main/index.js` 各自补齐。
> `custom/*/config.json` 的 `ver` 同样只写纯 semver（如 `0.1.3`），
> 由 `electron/main/index.js` 的 `loadConfig()` 在读取时统一补 `v`（兼容历史带 `v` 的写法）。

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

## 授权说明

Copyright 2026 Let's UFO

本项目是**源码可见（source-available）**软件，**不是** OSI 定义的开源软件。
完整、具有法律效力的条款以仓库根目录 [`LICENSE`](./LICENSE) 为准，本节只是便于理解的摘要；
两者不一致时，以 `LICENSE` 原文为准。

### 无需授权：个人非商业使用

个人出于研究、学习、实验、测试、私人娱乐、兴趣项目等**非商业目的**，
可以查看、下载、使用、修改本项目。
为上述非商业目的进行的**修改与二次开发同样允许**。

我们**鼓励**你基于本程序的能力，在 `custom/` 目录下开发各类脚本、配置与数据文件。
对于**改动仅限于 `custom/` 目录**的副本，可在同等条件下自由再分发或共享，
但须随附许可证条款（或条款 URL）以及 `Required Notice:` 版权声明行。

改动涉及 `custom/` 以外内容的副本，**禁止再分发或共享**；
如需分发，须另行取得版权所有者书面授权。
无论改动范围如何，本许可证的其他条款（包括非商业限制）均持续适用，
不因修改主程序而解除。

`LICENSE` 的 *Noncommercial Organizations* 一节所列非商业组织
（慈善机构、教育机构、公共研究机构、公共安全 / 卫生机构、环保组织、政府机构）
用于非商业目的同样无需单独授权，其资金来源或经费义务不影响该许可。

### 必须事先取得书面授权：任何商业使用

无论使用者是**个人还是任何形式的组织**，只要使用目的具有商业性，都必须事先取得
版权所有者的单独书面授权。包括但不限于：

- 出售、出租、收费分发本软件或其副本；
- **二次开发后再商用**：基于本项目修改、扩展、裁剪、封装或制作衍生作品，
  再将成果用于任何商业目的，包括打包出售、集成进收费产品、作为付费服务 / SaaS 对外提供、
  客户项目交付、企业内部经营使用。改动幅度、是否改名、是否只取用部分代码或配置，
  均不改变需授权的要求；二次开发本身不会解除本许可证的非商业限制；
- 将本软件原样用于收费产品、付费服务、SaaS、客户交付，或企业内部经营与任何变现流程；
- 以本软件为他人提供有偿的技术支持、部署或集成服务。

商用授权请通过本仓库 Issues 或版权所有者的 GitHub 主页联系洽谈。
无法确认某种用途是否属于非商业用途的，**默认视为未获授权**。

### 边界说明

- 判断标准是**使用目的是否具有商业性**，不是使用者的身份：个人用于商业目的同样需要授权。
- **非商业限制随衍生作品传递**：`LICENSE` 的 *Changes and New Works License* 只允许为
  非商业目的修改与创作新作品，*No Other Rights* 禁止再授权或转让。
  因此不能通过 fork、改名、二次开发或只取用部分代码，使包含本项目的整体成果获得商用许可；
  任何收到副本的人，其修改与衍生作品仍受同等的非商业限制。
- 仓库公开、可下载**不等于**授予任意使用权。
- 第三方依赖（见 `package-lock.json`）与 `custom/` 目录下的用户脚本、配置、数据文件
  各适用其自身条款；本授权仅覆盖版权所有者有权授予的部分。