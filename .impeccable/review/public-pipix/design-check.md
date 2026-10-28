# 公共皮皮虾采集：既有设计系统符合性记录

日期：2026-10-26。范围：公共采集重构及知乎、微博草稿交接，Mode 为 Operate。

本记录完成 Impeccable finishing documentation 的系统符合性核对，最终交付裁决由 finish reviewer 独立记录；这里不替代其 verdict pass。

## 核对依据

- 方向契约：`.impeccable/surfaces/pipix-sources.md`，沿用白色桌面工作台，区分来源记录与渠道交付状态。
- 业务边界：`docs/features/content-sources.md`，一次采集、多渠道草稿各自编辑；交付只在本地保存。
- 业务实现：`src/pipix/Workflow.tsx`、`PipixSources.tsx`、`PipixDetail.tsx`、`PipixExport.tsx`、`pipix.css`。
- 集成：`src/navigation.ts`、`src/zhihu/Workflow.tsx`、`src/weibo/Workflow.tsx`、`src/accounts/WeiboComposer.tsx`。
- 既有系统契约：`src/styles/tokens.css`、`src/ui/form-controls.css`，以及公共 `Header`、`Panel`、`Button`、`Status`、`Notice`、`Empty`、`LoadingState`、`Select`、`CheckboxField`、`Pagination`、`QueryError`、`Dialog`。
- 界面证据：已查看最终源码截图目录 `/var/folders/wh/x6t1yf457k37rhq9d89k9jm80000gn/T/panxu-pipix-e2e-qCrxyC`。本核对没有运行测试、服务或检测器，也没有重新生成截图。

## 符合性

| 核对项 | 实现和截图证据 | 结论 |
| --- | --- | --- |
| 白色桌面视觉 | 公共 `Header`、白色 Panel、蓝色主操作、语义状态和系统中文字体；`source-1440.png` | 保留既有工作台层级、密度与色彩 |
| 双列与长内容 | 链接、历史在左，图文、评论、渠道交付在右；业务布局复用间距和边界变量，正文及来源文字支持折行；`selection-1440.png`、`source-1366.png`、`exports-bottom-1366.png` | 1440×900 与 1366×768 下通过工作区纵向滚动访问渠道操作和完整去向记录 |
| 选择与表单 | 图片、评论使用 `CheckboxField`；排序、渠道、账号使用 `Select`；输入与文本域继承公共尺寸、焦点与禁用态；列表使用 `Pagination` | 沿用公共交互契约，没有页面焦点覆盖或原生下拉 |
| 公共入口与渠道交付 | 导航增加公共采集入口，知乎、微博页使用既有 `Button` 快捷进入；渠道区展示必要账号、字符数、本地保存边界和已有草稿提示；`shared-destinations-1440.png`、`exports-bottom-1366.png` | 新增业务信息通过既有控件表达，没有建立第二套视觉语法 |
| 去向状态与反馈 | 来源列表显示去向数量；交付记录保留渠道、账号标识和标题；成功反馈显式使用 `success`，失败在操作旁显示公共危险 Notice 并保留选择；`shared-destinations-1440.png`、`import-error-1440.png` | 来源状态与渠道交付记录可辨，反馈使用现有语义色 |
| 微博草稿定位与编辑 | 复用 `WeiboComposer` 和公共 `Dialog`；指定草稿加载期间锁定编辑、图片和提交动作，缺失使用 `QueryError` 提供重试；定位后显示来源、文案、可见范围和“保存本地草稿”；`weibo-loading-1440.png`、`weibo-missing-1440.png`、`weibo-composer-1440.png` | 加载、失败和可编辑状态清楚；公共控件契约延续到对话框 |
| 本地草稿恢复 | 链接按工作空间暂存，选择和目标按工作空间、原帖隔离；指定微博草稿的暂存键另含账号与 post ID，恢复不包含确认授权；本地保存和上传分别显式触发 | 延续现有表单恢复及发布确认边界，没有新增通用状态机制 |
| 空态、读取失败与图片故障 | `Empty`、`LoadingState`、`QueryError` 处理读取状态；刷新失败保留已有内容；配图故障有占位及说明；图片保持完整比例；`empty-1440.png`、`read-error-1440.png`、`image-error-1366.png` | 沿用既有恢复方式和内容核对方式 |

## 系统变更与资产

本轮没有新增视觉系统、公共 token、字体、主题或公共控件规格。所查 token、表单与公共组件文件没有本轮工作区差异。`pipix.css` 仅承载公共采集领域的布局、来源列表、目标字段和交付记录，继续引用既有颜色、间距和圆角变量；没有业务侧 Toast 配色或公共焦点覆盖。

截图中的配图明确写有“模拟采集图片”和“用途：本地模拟”，是测试内容，不是交付的装饰资产或发布素材。本轮没有新增需要写入设计系统的品牌栅格图片。

## 文档处理

沿用 `reference/document.md` 的扫描方法，核对 token、控件、布局与最终画面。本次属于既有系统中的普通业务结构调整，不把双列比例、配图高度、去向字段或草稿步骤提升为全项目规范。

依 surface brief 的 Documentation boundary，根目录没有 `PRODUCT.md`、`DESIGN.md` 不构成本轮补写全项目规范的理由；不生成根目录 `DESIGN.md` 或 `.impeccable/design.json`，不检查或修复无关漂移。现有源码继续承担系统事实，业务设计及方向分别保留在 `docs/features/content-sources.md` 和 surface brief。本记录独立保存，上一轮 `.impeccable/review/zhihu-pipix/` 历史文档保持原样。

结论：本轮公共采集及草稿交接符合现有设计系统，没有需要同步到全项目设计规范的系统变更。
