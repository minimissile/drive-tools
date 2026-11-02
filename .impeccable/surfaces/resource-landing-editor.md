# 资源落地页编辑器

Mode: Operate。Status: as-built ordinary extension，2026-11-02。

## 1. Authority and scope

入口为资源库固定入口面板的“落地页内容”。这是既有白色中文桌面工作台的长表单扩展，沿用 `DESIGN.md`、`src/styles/tokens.css` 和公共 Dialog、Button、Field、Status、Notice、Empty、LoadingState、QueryError；不新增主题、品牌或控件系统。

本记录在实现完成后按源码与截图补记，是 **as-built 描述**，不冒称用户批准的设计契约。没有批准 comp、seed、候选排序或 QUALITY BAR 卡；context launcher 的 permission denied 已知，直接读取 incumbent 文档。根 `PRODUCT.md` 不存在，未创建；本轮只记录该编辑表面，不重写全局视觉规范。

## 2. Direction contract — as built

THESIS: 将可核对的资源依据、内容编辑与发布检查放在一个受保护的长表单中，用户能明确区分生成、保存草稿和公开发布。

OWN-WORLD: 工作台白色弹窗与细边界、深蓝灰中文系统文字、蓝色主操作、绿色通过状态和琥珀警告；复用既有36px输入与30px紧凑按钮，焦点仍由公共表单样式拥有。

STORY: 查看当前资源与文件依据 → 补充可公开且已核实的信息 → 显式生成并独立检查 → 编辑标题、摘要、要点、分节与FAQ → 切换阅读预览 → 保存或明确发布。资料变化、冲突和发布结果待核对时提供可恢复路径，生成完成不等于已发布。

FIRST VIEWPORT: 弹窗最大1180px，顶部是弹窗标题、当前资源及发布状态。内容以272px左栏放生成依据、编辑补充、生成按钮和发布检查，右侧放“编辑内容/阅读预览”及宽正文区；两列相距24px、以1px线区分。保存、发布及查看公开页固定在底栏右侧，读取云端状态与撤下公开内容在左侧，长正文在弹窗主体滚动。

FORM: code-led 普通扩展；未经过新的方向评选。`seed: none (unavailable)`。签名交互是“依据与正文并排、编辑与阅读同位切换”：切换视图保留同一份草稿，底部提交范围始终可见。动效复用公共焦点160ms缓动，减少动态效果时为0ms；不增加独立页面入场动效。

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## 3. Scene, TYPE, MATERIAL, GROUND

使用场景是14寸及以上桌面工作台中审阅、修改较长中文资源内容，常见室内光照。受保护弹窗保留资源上下文，白底与公共表单对比保证持续编辑时能辨认输入、辅助说明和发布动作。

- TYPE：复用系统中文无衬线，当前资源16px，左栏及分节标题13px，输入13px，提示12px/1.75，计数与未保存提示11px。阅读预览正文14px/1.9、最大70ch，标题25px/1.45、节标题19px、问题标题14px；该预览是内容阅读模式，不声称完整还原公开网页壳层与领取面板。
- MATERIAL：弹窗宽 `min(1180px, 100vw - 48px)`、高 `min(860px, 100dvh - 48px)`，内边距20px。工作区左右比例272px与剩余宽度；左栏右内边距24px，工作区上下16px。字段间16px、分节内12px、FAQ内8px；左栏分组间24px并留20px顶内边距。主体滚动，公共 footer独立于正文。圆角、遮罩和柔和浮层深度继承公共 Dialog，不在领域CSS中新增阴影体系。
- GROUND：复用 `--surface: #fff`、`--bg: #f6f8fc`、`--text: #1d2b42`、`--muted: #5d6c84`、`--line: #e1e7f0`、`--blue: #2e61d5`。通过/警告分别复用绿和琥珀语义；Toast显式声明 success/warning。输入高度36px、圆角7px与焦点由 `src/ui/form-controls.css`统一，文本域可纵向调高，不另写业务焦点覆盖。

## 4. States and quality floor

读取使用 `useIpcQuery`，首次加载区域占位，刷新保留已有 context；失败由一处 QueryError提供重试，未完成读取不展示伪造空草稿。无草稿时说明生成步骤，生成中显示“正在撰写并检查”及耗时范围，禁用会冲突的操作；生成、发布、重试与撤下均为显式动作，不放入自动读取。

长表单按工作空间数据路径和资源ID隔离暂存，不完整编辑也能恢复。多窗口版本冲突保留当前编辑并提供“采用最新草稿”；资料已更新时要求重新生成。编辑补充变化后不能保存旧正文冒充新依据。编辑/预览共享草稿，未保存修改明确标记；发布时重新检查修改内容。

发布检查展示完整性、实际文件、事实与建议分离、引用可追溯、正文价值、重复内容与独立检查等结果，待修改项可展开。通过并由用户发布后才进入目录与 sitemap，提示收录与引用由搜索服务决定。发布结果待核对时保留状态，提供读取云端和重试原发布，不诱导重新生成；请求失败后的恢复只读取当前状态，不自动重放AI或发布。撤下公开内容保留固定领取入口。

底栏保留主要操作的清晰标签：保存草稿、保存并发布、更新发布及相应忙碌状态。已发布状态、内容检查通过、未保存编辑、资料陈旧、版本冲突和结果待核对各自表达；本次截图覆盖已发布且检查通过的非空编辑与阅读预览，不能据此宣称全部异常分支已实测。

## 5. Evidence and maintenance

源码核对：`src/resource-landing/ResourceLandingDialog.tsx`、`landing-editor.css`、`src/resources/ResourceLinkPanel.tsx`；公共对照 `src/styles/tokens.css`、`src/ui/form-controls.css`、`src/ui/dialog.css` 与 `shared/resource-landing.ts`。documenter 已目视核对 `../review/editor-1440.png` 和 `../review/editor-preview-1440.png`：实际资源长文、来源补充、左侧检查状态、视图切换和固定底栏均与源码一致。公开侧的1366×768及1440×900证据见 `resource-landing-public.md`。独立 finish reviewer 已沿用本轮完整审阅的有效截图，最终唯一来源文案修复判为 resolved、remaining clear、disposition ship；该修复复核见 `../review/resource-landing-review.md`，不扩大为全部编辑器状态或另一轮全页面验收。

桌面范围为14寸及以上，本轮证据使用1440×900与1366×768逻辑视口；不增加手机、平板、840px或全矩阵承诺。该 documenter只做源码/文档对照与已有截图目视检查，没有创建窗口、运行测试或界面脚本，没有AI调用、远端转存或发布。

既有漂移保留：`DESIGN.md` 的旧格式与缺失 `.impeccable/design.json` 未在普通扩展中修复；系统字体在 Operate/Read场景已有明确权威，不当作新品牌 display字体选择。未将局部预览字号、弹窗尺寸或任何未实测状态升级成全局规范。写入边界仅本文件与 `resource-landing-public.md`，保留源码、README、系统文档及其他任务改动。

## 2026-11-02 · 正文质量修订

本轮保持既有Read/Operate布局，改为先提取实际PDF或文本，再整理内容。示例页使用104页PDF中的47页抽样文字，提供10章页码导航、实际条目与适用边界；无FAQ和要点时不绘制空区块。编辑器增加读取/导入原文件及分项质量结果，未发布修改单独标记。内部五项审核至少8.2/10且每项达70%，并通过正文、引用、摘要完整性等硬门槛；该分数不代表搜索平台评分。

最终截图与验收记录已更新，旧finish reviewer的ship结论仅适用于此前批次，未将其延用为本轮独立审阅结论。本轮由主任务逐项对照正文与实际界面验证，详见`docs/features/resource-landing-seo.md`。
