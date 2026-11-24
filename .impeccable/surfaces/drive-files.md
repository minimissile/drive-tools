# 网盘文件

- Mode: Operate
- Primary target: `src/pages/DriveFiles.tsx`
- Related: `src/drive-files/LocalDriveIndex.tsx`, `src/drive-files/DriveBrowser.tsx`, `src/drive-files/drive-index.css`, `src/drive-files/drive-files-page.css`
- User priority: 首屏多展示文件，操作集中。
- Direction: 延续盘序白底蓝色紧凑桌面工作台。账号选择用上下文栏，浏览方式下方只保留一个目录工作区，状态与同步动作放在一起。
- First viewport: 标题、账号、浏览方式、同步状态、查询与批量操作、文件列表。目录树与表格共享剩余高度，工具栏和分页保持可见。
- Density: 复用 36px 控件与 13px 文件表正文，通过合并分区和删除重复信息增加内容，不整体缩放或缩小字体。
- Row hierarchy: 名称为主要信息；普通目录不重复完整路径，搜索结果保留所在位置；多个关联资源使用公共菜单。
- Extremes: 同步中、部分完成的长错误、尚未同步、读取失败、长文件名、深目录、多个资源关联、录入预览与实时网盘。
- Behavior: 保留同步、筛选、资源登记与实时文件操作语义；不自动发起远端变更。不增加依赖或图像素材。

## 完工检查 · 2026-11-24

结论：布局优化通过。1366×768 保留全局待更新条时，本地表格起点从约 764px 提前至 431px，首屏从 0 行增加为 4 个完整文件行。1440×900、长关联资源菜单、深目录、同步中、部分完成、尚未同步、读取错误、录入预览和实时网盘已查看截图。预览展开聚焦首个输入，收起后回到触发按钮。

TypeScript 检查与两个任务专属窗口的页面模拟回归通过；没有进行真实网盘写入、建链或远端同步。单次机械扫描没有报告问题。沿用公共控件尺寸与焦点，没有新增生产位图或依赖。

截图与详细记录见 `docs/reviews/drive-files-layout-2026-11-24.md`。界面按前端热更新加载，后端未由本任务重启。
