# 皮皮虾采集：既有设计系统符合性记录

日期：2026-10-26。范围：知乎运营中的普通业务扩展，Mode 为 Operate。

本记录完成 Impeccable finishing documentation 的系统核对，不替代 finish reviewer 的裁决。最终裁决见同目录 `report.json`：`ship`；失败项辨识与逐条重试、导入错误就地显示并保留选择两项问题均已 resolved。

## 核对依据与证据

- 方向契约：`.impeccable/surfaces/zhihu-pipix.md`，沿用白色桌面工作台、双列业务布局和现有中文系统字体。
- 系统来源：`src/styles/tokens.css`、`src/styles/controls.css`、`src/styles/workspaces.css`、`src/ui/form-controls.css`。
- 公共组件：`src/ui/primitives.tsx`、`Select.tsx`、`CheckboxField.tsx`、`Pagination.tsx`、`QueryError.tsx`，以及既有知乎列表样式 `src/zhihu/zhihu.css`。
- 业务实现：`src/zhihu/PipixSources.tsx`、`PipixDetail.tsx`、`pipix.css`；集成入口 `Workflow.tsx`、来源提示 `Contents.tsx`。
- 查看已完成的当前源码界面截图，未重新启动服务、执行测试或生成截图。截图目录：`/var/folders/wh/x6t1yf457k37rhq9d89k9jm80000gn/T/panxu-pipix-e2e-Q8Enhe`。

| 核对项 | 源码与画面证据 | 结果 |
| --- | --- | --- |
| 色彩、字体与密度 | 白色 Panel、浅色工作区、蓝色主按钮，文字和间距复用既有 token；`source-1440.png`、`source-1366.png` | 符合既有白色桌面工作台 |
| 表单与选择控件 | 输入和文本域沿用 `form-controls.css`；评论排序使用公共 `Select`；图片及评论勾选使用 `CheckboxField`；`selection-1440.png` | 未新增页面焦点覆盖、原生下拉或独立控件规格 |
| 导航与列表 | `Workflow.tsx` 将业务入口接入既有五页签；已采集列表沿用知乎列表行和公共 `Pagination`；`source-1440.png`、`selection-1440.png` | 结构和选择状态与现有工作流一致 |
| 操作和状态 | `Button` 区分主操作与次操作；采集成功、失败及导入状态使用公共 `Status`，导入后进入既有素材池；`source-1440.png`、`imported-1440.png` | 语义颜色与动作层级一致 |
| 空态与恢复 | 空列表和预览使用 `Empty`；读取失败使用 `QueryError` 并保留已读列表与详情；`empty-1440.png`、`read-error-1440.png` | 真实空态与读取失败可区分，恢复入口统一 |
| 错误与长内容 | 批次结果显示输入标识和逐项重试；导入错误在按钮旁用公共危险 Notice 显示一次；图片失败保留占位及说明；文本使用换行和任意位置折行；`source-1440.png`、`import-error-1440.png`、`image-error-1366.png` | 符合当前业务状态与长内容的工作台表达 |
| 桌面布局与内容图片 | 1366×768 与 1440×900 保持双列；选择和导入可经工作区纵向滚动到达；配图使用 `object-fit: contain`；`source-1366.png`、`selection-1440.png` | 符合本次桌面范围及内容核对目的 |

## 本轮系统变更

无新的视觉系统、公共 token、字体、主题、公共控件或统一交互规格变更。所查系统 token 与公共控件文件没有本轮工作区差异。

新增 `pipix.css` 仅承担该领域的双列比例、图片展示、评论滚动和结果布局；颜色、间距、边界与圆角通过现有变量表达。页面没有局部重定义公共输入焦点、Toast 配色或 Select 样式契约。素材池新增来源 Notice 和原帖按钮，继续使用既有组件。

截图中的绿色示例图为明确标注“模拟采集图片／用途：本地模拟”的测试内容，不是本次交付的装饰资产或发布素材。本轮没有新增需纳入视觉系统的品牌图片。

## 文档处理

`reference/document.md` 的扫描方法用于核对现有 token、公共组件、布局与实际界面。本次确认的是既有系统中的业务扩展；不把单页双列比例、图片高度或采集步骤提升为全项目规范。

根目录当前没有 `PRODUCT.md`、`DESIGN.md`。依方向契约的 Documentation boundary，本轮不补写全项目 `DESIGN.md`，不生成 `.impeccable/design.json`，不修复无关文档漂移。系统事实继续以现有源码为依据，业务方向保留在 surface brief，符合性记录保留于本文件。

核对结论：本轮扩展符合已存在的设计系统，没有需要同步到全项目设计规范的系统变更。
