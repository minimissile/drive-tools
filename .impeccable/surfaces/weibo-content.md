# 微博内容工作区

Mode: Operate. Target: `src/weibo/Workspace.tsx`, `src/weibo/IdeaEditor.tsx`, `src/weibo/Delivery.tsx`, `src/accounts/OtherAccounts.tsx`.

## Direction contract

THESIS: 从一条想分享的内容开始，在同一工作区保存选题、准备账号版本、审阅发布和查看统计。资源绑定放在需要链接时；账号管理负责身份与浏览器环境。

OWN-WORLD: 延续 DESIGN.md 白色紧凑桌面工作台、公共蓝色主操作、表格、分区与原有控件。14寸及以上桌面，本轮1440×900验收；不新增视觉世界或移动版。

STORY: 用户可先记选题，再选账号、补充依据和文案；需要时显式调用现有AI。每个账号文风独立、每份内容版本独立，发布确认与回执继续复用既有链路。

FIRST VIEWPORT: 内容标题与新建主操作在上方，三页签切换内容列表、数据复盘、账号文风；账号、搜索、排序紧接其后。编辑器左侧内容设置、右侧文案与主操作。保存草稿不要求资源、事实依据或登录。

FORM: 既有桌面操作工作台的扩展；不进行概念或视觉世界替换。seed: none (unavailable)

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Editorial constraint

用户授权只读查看本人微博历史资源帖，并要求保持其风格。已观察到目录式标题和已知规格、标题后的“链接：”、短介绍、原海报或封面；影视规格只能来自本次已核实事实。生日自动动态、社会评论转发和测试帖不作样本，不复制旧链接。预设见 `shared/weibo-workspace.ts`，可按账号覆盖。

## Verification scope

- `scripts/qa-weibo-workspace.mjs` 在专属测试窗口运行，页面级业务传输指向临时AppService与数据库；不修改真实业务，不调用实际模型、上传或发布。
- 计划时间是待办排序，不代表自动定时发帖。
- 复盘只展示本地快照，真实0、缺失与采集时间分开；不虚构微博链接点击。
- 新后端只编译暂存，由用户点击“应用更新并重启”加载。

## Finish and documentation · 2026-11-07

- 保持现有 DESIGN.md、公共变量、控件与焦点契约；本轮没有创建新视觉世界、token 或发布栅格资产。PRODUCT.md 与 `.impeccable/design.json` 当前缺失，按既有实现及本表面契约完成扩展，不顺带生成或修复全局文档。
- 最新隔离 UI 报告为 `.impeccable/review/weibo-workspace-2026-11-07/ui-test.json`，1440×900，16 项检查通过、页面错误 0；页面业务传输指向独立临时 AppService，没有真实业务修改、实际模型调用、上传或发布。微博专项测试 27 项及类型检查通过。
- `finish-verdict.md` 将原 F1／F2／F3 评为 resolved，disposition 为 ship；只覆盖独立资料搜索与长标题、本地词源保留、历史链接及独立统计快照入口三项，不扩大为新的全表面或官方发布验收。
- `live-readonly.json` 记录已加载 revision 243 的真实本地只读查看：本人账号预设正确，1 条既有内容及 1 个缓存统计目标可见；没有保存文风、业务写入、最新官方统计读取、生成、上传或发布。本任务窗口均已清理，主窗口已恢复焦点，其他任务窗口保留。
- 使用说明见 `docs/features/weibo-content.md`；资源准备与交接更新在 `docs/weibo-marketing.md`，统计入口更新在 `docs/features/weibo-statistics.md`。证据对照、既有漂移与文档边界见 `.impeccable/review/weibo-workspace-2026-11-07/documentation.md`。
