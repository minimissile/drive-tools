# 列表发现扩展：既有设计系统符合性记录

日期：2026-10-26。范围：公共皮皮虾采集中的列表发现入口，Mode 为 Operate。

这是普通业务扩展的 finishing documentation 记录，不替代独立 finish review。该轮独立复核已给出 `disposition: ship`，无 material findings；复核与本记录均限于当前源码和模拟 UI，不表示真实 TikHub API 联调完成。

## 核对依据与范围

- 方向契约：`.impeccable/surfaces/pipix-sources.md`，保留白色双列工作区，在左列增加“获取数据列表／分享链接”两种采集方式。
- 业务边界：`docs/features/content-sources.md` 的列表发现扩展、使用方式及验收记录。
- 本轮实现：`src/pipix/PipixDiscovery.tsx`、`PipixSources.tsx` 的采集方式页签及衔接、`pipix.css` 的发现表单与候选列表样式。
- 既有系统：`src/styles/tokens.css`、`src/ui/form-controls.css`，公共 `Tabs`、`Select`、`CheckboxField`、`Pagination`、`Field`、`Button`、`Empty`、`LoadingState`、`Notice` 与 `QueryError`。
- 已查看最终截图目录 `/var/folders/wh/x6t1yf457k37rhq9d89k9jm80000gn/T/panxu-pipix-e2e-eWkzdU/` 中的 `empty-1440.png`、`discovery-1366.png`、`discovery-actions-1440.png`、`discovery-error-1440.png`。本次只读取已有证据，没有启动服务、运行测试或检测器。

## 符合性

| 核对项 | 源码与画面证据 | 结论 |
| --- | --- | --- |
| 视觉与布局延续 | 页面继续使用白色 Panel、蓝色主操作、系统中文字体和双列布局；发现入口嵌入左侧已有工作区，右侧保留图文挑选与渠道交付；四张指定截图 | 延续既有 Operate 工作台，没有替换视觉系统 |
| 采集方式与来源选择 | `PipixSources` 使用公共 `Tabs`；`PipixDiscovery` 使用公共 `Select` 切换关键词、推荐、作者及话题，条件输入使用 `Field` | 复用既有导航、标签、下拉和表单边界，未新增原生下拉或页面焦点覆盖 |
| 配置层级 | 首次未配置时展开 API Key 区，配置后折叠；输入为密码类型，仅在组件状态中保留，不加入 `useLocalDraft`；`empty-1440.png`、`discovery-1366.png` | 配置入口可发现，后续候选操作的空间保持清楚；加密保存机制以功能文档为依据，不在本记录另做安全裁决 |
| 查询动作与提示 | 页面明确标识 TikHub 第三方及每页可能计费；获取列表和获取下一页均为显式按钮，自动读取仅限本地配置状态；`discovery-actions-1440.png` | 付费查询动作与本地选择分离，沿用既有按钮与说明文字层级 |
| 候选选择与批量动作 | 公共 `CheckboxField` 支持逐条、本页选择，`updateSelection` 限制最多 20 条；计数与“采集所选”位于候选上方；`discovery-1366.png`、`discovery-actions-1440.png` | 在 1366×768、1440×900 桌面范围内保留主要操作可达性 |
| 长内容和分页 | 候选标题采用三行截断并提供完整 `title`，作者及类型使用次级文字，列表边界和间距引用系统变量；公共 `Pagination` 翻阅本地候选 | 信息密度与现有列表相容，没有新增公共排版规格 |
| 失败、空态与恢复 | 配置读取使用 `LoadingState`、`QueryError`；查询失败使用公共危险 Notice，保留候选及选择；真实空结果和筛选无结果有不同 `Empty` 文案；`discovery-error-1440.png` 直接显示原候选及 2/20 选择仍在 | 恢复状态沿用现有控件与语义色，不以失败伪装为空结果 |
| 与既有采集衔接 | `onCollect` 复用公开详情采集队列，和分享链接共用采集结果、历史、图片及评论挑选、多渠道素材流程；`discovery-actions-1440.png` | 新入口延伸现有业务，没有建立第二套预览或渠道交付界面 |

## 系统变更与证据边界

没有新增公共 token、字体、主题、公共控件或统一交互规格。所查 `tokens.css`、`form-controls.css` 及复用公共组件没有本轮工作区差异。新增 CSS 只承担发现表单、Key 折叠区和候选行的领域布局，颜色、边界与间距继续引用现有变量，没有局部重写公共焦点或反馈配色。

截图中的候选标题明确标为“模拟列表”；右侧图片 403 是既有故障模拟状态。此轮未新增发布素材、装饰栅格资产或品牌视觉资产。未把 `discovery-source-menu-1440.png` 作为下拉打开态证据。

功能文档已记录 25 项单元／集成及扩展 E2E 通过；本记录不重新执行这些检查。真实 Key 缺少，上游业务响应结构、可用率和图文覆盖仍未联调，模拟画面及上述符合性不扩大为真实 API 可用承诺。

## 文档处理

依 `reference/document.md` 的扫描方法核对现有控件、token、业务布局与已渲染画面。根目录仍无 `PRODUCT.md`、`DESIGN.md`；依方向契约的 Documentation boundary，不为普通扩展补写全项目规范或 `.impeccable/design.json`。候选分页数、截断行数和列表获取步骤保留为领域实现，不提升为全项目设计规则。

本轮只新增本符合性记录；不修改业务代码、README、既有验收文档，也不修复预存漂移。

结论：列表发现扩展符合既有白色桌面设计系统，无需同步全项目设计规范的系统变更。
