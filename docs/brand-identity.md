# 盘序品牌图标

盘序是面向个人内容运营的本地桌面工作台：汇集多网盘资料，完成转存、本人分享核验和知识归档，再连接流量选题、AI 内容制作与发布准备。

## 设计

“叠页成序”：两层资料页折合为 Panxu 的首字母 P。后页代表汇集的资源，前页代表整理后的内容；连续的轮廓连接归档与输出。保留现有白色界面和品牌蓝，不改变业务导航与产品名称。

这是现有视觉体系内的品牌资源扩展；通用颜色、排版与控件仍以 `docs/design-tokens.json` 和 `src/styles/tokens.css` 为准，本文仅约束图标及其品牌组合。

- 主色沿用 `#2e61d5`；底座从 `#3977ee` 过渡至 `#224cb6`。
- 前页使用白色，后页使用浅蓝色；以大片面和留白保持小尺寸辨识度。
- 侧栏显示 36 × 36 的无外阴影标志，旁边保留“盘序 / PANXU STUDIO”；在 840 像素最小窗口中，完整英文副标题仍保持单行。图形为装饰图片，避免屏幕阅读器重复播报产品名。
- App 图标使用 1024 × 1024 透明画布，底座为 880 × 880，四周留出 72 像素；外阴影只用于 App 资源。

## 资源与维护

矢量主稿：`src/assets/brand/panxu-mark.svg`。侧栏和网页 favicon 直接使用主稿；修改主稿后，通过 `scripts/generate-icons.mjs` 重新生成 `build/icon.svg`、`build/icon.png`、`build/icon.icns` 和 `build/icon.ico`，不要分别手改导出文件：

```sh
npm run build:icons
```

导出使用项目已有的 Electron 离线渲染，不需要额外依赖，也不生成安装包。ICNS 包含 16–1024 像素及 Retina 表示；ICO 包含 16、24、32、48、64、128、256 像素。生成后重启开发窗口即可更新程序坞图标。

开发窗口从 `build/icon.png` 读取运行图标。发行配置将它复制至 `resources/brand/icon.png`；macOS 包图标使用 `build/icon.icns`，Windows 安装与程序图标使用 `build/icon.ico`。现有已安装程序需在以后正常打包更新时获得新图标。

macOS 的程序坞悬停名称读取应用包的 `CFBundleName` / `CFBundleDisplayName`；`app.setName()` 只改变 Electron 内部名称。`npm run dev` 通过 `scripts/dev-macos.mjs` 将本项目依赖内的开发运行时同步为“盘序”，并使用 `com.panxu.studio.dev` 标识及刷新该应用的系统注册。重装依赖后再次启动会自动恢复；不会改动安装版或项目外的运行时。已运行的旧进程需在空闲时重启后使用新名称。

## 验证范围

2026-10-17 已查看当前源码在 1600 像素桌面和 840 像素最小窗口中的资源库、内容工作室与品牌局部截图，完成隔离本地数据的导航验证、TypeScript / Vite 构建、ICNS 系统解码及 ICO 二进制结构检查。开发运行图标读取为 1024 × 1024；macOS Dock 原生显示、Windows 实机与安装包显示仍需在对应环境验收。本次未生成安装包或提升版本。

## 视觉探索来源

2026-10-17 使用内置 ImageGen 探索折页 P 的造型，再手工整理成精确 SVG 几何主稿。运行资源均来自 SVG 渲染，不依赖生成稿的像素和透明边缘。

最终使用的探索提示词：

> Use case: logo-brand. Create a single final macOS app icon concept for Panxu Studio (盘序), a local desktop workspace that organizes multi-cloud-drive resources, archives them into a knowledge library, turns research into AI-assisted content and prepares distribution. Design concept: 'ordered pages become P'. A highly distinctive geometric capital P built from two or three orderly, interlocking folded document ribbons. Bold white front ribbon, a restrained pale ice-blue rear page visible at the lower left. One beautifully balanced clear counter-space; strong silhouette readable at 32 pixels. The outer tile is saturated cobalt blue (#2e61d5) with very subtle directional tonal depth, softly rounded macOS superellipse corners, front-on orthographic, centered on a square transparent canvas with modest equal margins. Restrained premium productivity software identity. Precise consistent curves, crisp vector-like geometry. Very subtle paper overlap depth, no glossy plastic. No text, no Chinese glyph, no wordmark, no cloud, no arrows, no sparkle, no network nodes, no border ring, no extra badges. Only one icon, no presentation board, no multiple variations, no UI mockup. Transparent outside the tile. App icon should occupy approximately 86 percent of canvas width.
