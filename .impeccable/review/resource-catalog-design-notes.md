# 资源清单设计复用核对

核对日期：2026-10-29。范围为 `src/pages/ResourceCatalog.tsx`、`src/resource-catalog/*`，结合现有 tokens、公共控件、代表页面及本目录已有的手动截图。按本轮边界使用 Impeccable document 的扫描方法，仅记录扩展证据；不建立 PRODUCT.md、DESIGN.md 或新的视觉体系。

结论：资源清单延续盘序现有白色桌面工作台，未发现实质设计不符。清单索引、公开预览、发布交接与版本维护形成清楚的操作层次，没有引入装饰性指标卡、渐变、独立字体或深色主题。

| 核对项 | 当前证据 |
| --- | --- |
| 主题与颜色 | `src/styles/tokens.css` 维护唯一的 light 色彩、字体、间距、控件和面板变量；`resource-catalog.css` 的颜色均引用现有语义变量，使用白色面板、浅灰底、蓝色操作和琥珀色待处理提示，没有新增色值。 |
| 公共控件 | 页面复用 Header、Button、Empty、Status、LoadingState、QueryError、Select；CatalogWorkspace 复用 Tabs 和 Dialog；编辑器复用 Field、Select、Dialog、Notice；预览复用 Pagination；发布区复用 Panel、Field、Select 和反馈组件。与 `src/pages/ResourceCollection.tsx`、`src/pages/ResourceExport.tsx` 的公共组件使用方式一致。 |
| 表单焦点 | 文本框、文本域和 Select 的边界与焦点来自 `src/ui/form-controls.css`；本业务样式没有另写 focus、outline 或焦点动画覆盖。局部搜索栏的外层不绘制边框或焦点，输入框只有一层公共焦点。按钮、复选框、summary 继承 `src/styles/base.css` 的键盘焦点。 |
| 字号与密度 | 页面标题沿用公共 Header；清单标题为 20px，区块标题 15px，表格正文 13px，辅助信息 12px。主要间距与圆角引用既有变量，和现有面板、表单、按钮保持同一桌面密度。 |
| 工作区层次 | 左侧索引、右侧清单标题与操作、资源预览/发布维护 Tabs 顺序明确。索引使用蓝色选中底；维护状态与待更新数量使用现有 Status。发布区按交接和已有文档维护分组，文档条目用分隔线组织。 |
| 长内容 | 标题与链接可换行，说明默认限制三行并提供展开/收起；索引可滚动，差异列表与历史列表具有局部高度上限。截图中长标题、双网盘链接和展开说明仍可区分资源名称、说明和访问入口。 |
| 状态与反馈 | 首次加载、真实空态和读取失败分别使用公共 LoadingState、Empty（内部为 DataState）和 QueryError；账号空态在发布区域就近指向账号管理。Toast 调用显式声明 success、error 或 info，未新增局部 Toast 配色。 |

已实际查看的 1366×768 手动截图：

- `resource-catalog-1366.jpg`：清单索引、标题操作和紧凑预览。
- `resource-catalog-editor-1366.jpg`：公共 Dialog、编辑表单及文本域焦点。
- `resource-catalog-long-1366.jpg`：长标题、说明展开与多链接排版。
- `resource-catalog-handoff-1366.jpg`：平台/账号选择、冻结版本、复制与官方平台交接、登记表单。
- `resource-catalog-history-1366.jpg`：待更新状态、三类差异与登记历史。
- `resource-catalog-empty-1366.jpg`：首次创建入口与简短流程说明。
- `resource-catalog-read-error-1366.jpg`：单处读取失败提示和重试入口；画面右下角为手动验收模拟面板。
- `resource-catalog-no-accounts-1366.jpg`：账号空态、禁用状态及就近添加账号入口。

非阻断复用差异：ResourceCatalog 与 CatalogPreview 分别实现了相同的搜索图标和输入框结构，而 `src/ui/primitives.tsx` 已有 SearchField。现状仍使用公共输入框尺寸与焦点，未形成视觉漂移；本轮仅记录，不改源码或扩大全局重构。

边界：此次只做源码与已有截图核对，没有运行自动化测试、脚本化界面操作或重新截图。截图覆盖 1366×768 的本地模拟内容，不能代替 1440×900 的实际界面检查，也不证明平台账号登录或远端分享权限。
