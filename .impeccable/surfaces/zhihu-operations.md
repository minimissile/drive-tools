# 知乎双号运营与运行日志

Mode: Operate。对既有业务工作区作结构整理，保留盘序白色紧凑桌面系统。

## Direction contract

THESIS：用户在首屏看懂账号进度、下一项执行和暂停原因，并能沿任务回执追到运行日志。

OWN-WORLD：继承根目录DESIGN.md、系统中文字体、白色Panel、浅色页面、蓝色主操作与现有语义色；复用统一36px输入、紧凑按钮、Select、Pagination、DataState、QueryError和焦点契约。

STORY：先看运行总览，按需进入账号计划、素材和发布任务；日志保留事件时间、账号、任务和细节，用真实回执区分完成、待执行和待核对。

FIRST VIEWPORT：顶部紧凑标题、素材与环境快捷入口；状态条显示调度及最近心跳和启动/停止动作；默认运行总览用全宽账号表呈现两个账号的等级、额度、下次执行与原因，下面列近期事件。其余页签保留原业务编辑，运行日志独立全宽筛选、列表和分页。覆盖1366×768和1440×900桌面。

FORM：既有工作台列表与领域页签的扩展，无新视觉世界或装饰资产；seed: none (unavailable)。已有历史采集brief只作为历史记录。

FINISH：unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Documentation boundary

普通扩展，保留现有DESIGN.md与公共tokens，不新增或改写全局视觉规范。用户已授权自主推进，不另设设计确认环节。最终以实际源码截图及独立复核记录为依据，模拟证据与真实发布事实分开。

## Shipped evidence — 2026-11-03

### 创作分与间距增补

- 本轮普通扩展：总览与账号页共用`CreatorProgress`，以官方等级页为数据来源，展示分数、下一等级总分、百分比、差分与官方更新日期；计划目标单独标注。未知分数不显示虚构的0；8号官方实际0分可以显示0%。
- 空间节奏：移除领域面板与父级grid重复的底部间距，分区12px、面板16px、表格单元格上下8px；调度条内上下8px、公共紧凑按钮30px，输入仍36px。账号页按进度、身份操作、发布规则分组，长暂停原因自然换行。
- 本轮核对：源码类型检查通过，在当前共享源码开发窗口手动刷新并查看账号页及总览真实界面；7号3,677/9,500、8号0/250与官方日期均呈现，暂停原因及主要操作可见。未执行自动化测试。上下文加载器和布局检测器均因本地启动器不可执行而未运行，未宣称检测器通过；根DESIGN.md及公共tokens未改动。

- 源码核对：`src/zhihu/Workflow.tsx`、`Overview.tsx`、`Logs.tsx`、`Tasks.tsx`、`Contents.tsx`及`zhihu.css`。首屏使用调度条、全宽账号表和最近记录；日志独立按账号、级别筛选，显示事件时间、任务标识、可展开详情与公共分页。未取得快照时显示读取中或状态未知，并禁用调度按钮，不预判为已停止。
- 系统证据：对照根`DESIGN.md`、`src/styles/tokens.css`、公共`primitives.tsx`、`controls.css`及`form-controls.css`。沿用白色面板、浅色页面、品牌蓝与语义色，12–16px分区、16px总览/日志面板内边距、36px输入和30px紧凑按钮；表格正文13px，日志时间/详情12px，辅助文字11px。焦点仍由公共样式负责。页签与日志筛选经`useLocalDraft`、`windowStorage`按工作空间和窗口隔离暂存。
- 截图来源：当前源码开发窗口，在首次读取状态修复后重新截取；均为界面截图，无生成图或新视觉提案。[总览1366×768](../review/zhihu-overview-1366.png)、[总览1440×900](../review/zhihu-overview-1440.png)、[日志1440×900](../review/zhihu-logs-1440.png)、[筛选及展开详情1440×900](../review/zhihu-logs-filtered-1440.png)。文档核对已查看四张图中的密度、列对齐、长消息换行与主要操作。
- 验收回执：本轮已执行的共享会话交互检查记录筛选、页签在刷新后恢复，未发现`pageerror`或文档横向溢出。独立复核将首次加载误报停止状态判为resolved，remaining clear，disposition ship；该结论仅覆盖这项修复的verdict-pass范围。本记录未另行执行自动化。截图与界面验收不作为夜间计划真实发布成功的回执。
- 既有偏差保留：公共`h1`仍为24px，与根文档优先20px的建议存在差异；根文档保留既有中文结构、未含规范frontmatter，`.impeccable/design.json`仍不存在。本轮是普通扩展，未修复这些既有差异，也未把它们提升为新规则；根文档及公共tokens保持只读。
