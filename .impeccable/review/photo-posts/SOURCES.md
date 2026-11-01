# 开发视觉预览

`preview.html` 直接导入当前 `src/photo-posts/render.ts` 与字体加载方法，展示同一 Canvas 画布；没有账户、业务 IPC、保存或发布操作。示例口令为占位内容。

`reference-cover.webp` 是用户提供的[抖音参考作品](https://www.douyin.com/note/7688670509488230607)中展示的第一张封面原图，2026-11-01读取。仅用于核对原封面构图，不作为应用内置素材，不参与生产构建，也不代表取得该剧资源或图片发布授权。图片内容属于原作者，未编辑该原图；预览仅将其交给应用现有 Canvas 海报排版。

其余海报由当前本地 Canvas 源码绘制，字体来源见 `src/photo-posts/assets/SOURCES.md`。预览图片并非图片模型生成。
