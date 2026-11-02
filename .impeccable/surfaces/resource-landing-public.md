# 资源落地页、公开目录与整理说明

Mode: Read。Status: as-built ordinary extension，2026-11-02。

## 1. Authority and scope

这是盘序既有白色、品牌蓝、系统中文字体的公开阅读表面扩展。视觉权威来自既有 `DESIGN.md`、实际公共变量与当前构建，不创建新品牌或替换工作台系统。根目录 `PRODUCT.md` 不存在；本记录不补写产品身份。公开阅读页的字号与留白服务正文理解，不把桌面 Operate 的表格密度直接移植到文章。

本记录在实现和复核后整理，属于 **as-built 描述**，不是用户批准的概念契约。没有用户批准的 comp、seed 或 QUALITY BAR 卡；不追认方向选择、候选排名或视觉参考。context launcher 已因 permission denied 不可用，改读 incumbent 文档和源码，没有重装、绕过或运行 detector。范围为 `/r/:slug`、`/`、`/about` 及其公开阅读与查找状态；固定领取入口 `/go/:slug` 的职责独立。

## 2. Direction contract — as built

THESIS: 先让读者核对资源信息、理解用途与信息边界，再决定是否去网盘获取。页面以可读文章与实际文件记录承担价值，领取操作不替代正文。

OWN-WORLD: 白色底、深蓝灰文字、盘序蓝操作、细分隔线，保留中文系统无衬线。目录与文章共享简洁站头、品牌和导航；正文分节，领取区只占右侧窄列。

STORY: 目录按名称或主题查找 → 读资源概述与要点 → 核对文件名和大小 → 阅读事实说明、标明身份的原创示例和使用建议 → 展开 FAQ 与整理依据 → 去网盘查看。事实引用可定位对应依据，不能把通用方法理解成文件原文。

FIRST VIEWPORT: 桌面站头下先有面包屑；左侧是两行长标题、AI 辅助整理身份、更新时间、概述、要点及文件信息，右侧领取面板顶部放蓝色“前往网盘查看”和复制按钮，下接当前链接折叠、核验说明与页内目录。1440×900 与1366×768均保持约740px正文、64px列间隔和292px领取列，不挤压长标题或把主操作藏在正文末尾。

FORM: code-led 的既有系统普通扩展；无已选择的候选排名或批准 comp。`seed: none (unavailable)`。签名交互是“依据可追溯”：正文依据链接定位到文件或展开的来源，阅读时右侧同时保留领取与目录。页面锚点平滑滚动，减少动态效果时改为直接滚动；没有装饰入场动画。

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## 3. Scene, TYPE, MATERIAL, GROUND

使用场景为14寸及以上桌面：读者在日常室内光照下阅读较长中文说明、核对文件并打开网盘。白底与清晰正文延续既有工作台身份；本轮不建立深色或随系统变化的主题。

- TYPE：系统栈为 `-apple-system, BlinkMacSystemFont, PingFang SC, Microsoft YaHei, sans-serif`。文章标题34px/1.4、720字重、字距−0.025em；概述17px/1.95；节标题22px/1.5；正文15px/1.9；文件名14px，辅助说明12–13px。目录标题36px，条目标题21px；文章日期和文件大小使用等宽数字。以上是公开阅读表面的实际源码层级，不升级为工作台通用字号。
- MATERIAL：内容依靠线性分节和留白组织，文章与目录条目无包裹卡片和阴影。领取面板以1px边框、12px圆角、24px内边距划定操作区域，sticky top为24px；正文节间40px，标题下16px，文件行上下12px。公共站头、主体、页脚宽度为 `min(1120px, 100% - 64px)`；目录两列、列间48px；整理说明正文最大740px。
- GROUND：白底 `#fff`，主文字 `#1d2b42`，主要操作 `#2e61d5`。公开站壳局部使用辅助色 `#586981`、边界 `#dfe6ef` 与浅底 `#f5f7fb`；它们没有被写回桌面 tokens。42px最小高度的公开按钮与搜索框独立于桌面36/30px控件契约；按钮圆角7px。键盘焦点为3px浅蓝外轮廓，选中文字和插入光标沿用蓝色关系。

## 4. States and quality floor

完整文章由服务端 HTML 输出，title、description、canonical、OG 与 JSON-LD随同内容提供；正文阅读不依赖客户端请求。公开来源折叠、FAQ 和当前网盘链接使用常见 `details/summary`；复制结果通过局部 `role=status` 明示成功或手动复制恢复。跳过导航链接、语义文章/导航、键盘焦点与长文件名换行均在源码中保留。

文件名和大小来自已记录事实；未展开文件夹明确其范围。事实说明引用依据，使用建议和原创示例注明身份，不由文件元数据推测章节、页数、作者、出版性质、授权或效果。来源面板使用人可读的“资源资料”“录入说明”“已核验的获取方式”；机器字段已从来源展示文案中移除，人工编辑正文保留。发布前有结构、事实引用、完整性、重复内容与独立内容检查；只有人工触发且通过检查的发布内容进入目录与 sitemap，不承诺搜索收录、排名、流量或 AI 引用。

目录区分“资源正在整理中”与“没有找到匹配的资源”，有明确返回全部入口与翻页。主域名无查询参数且存在公开文章时目录可索引，查询/筛选结果为 noindex；资源文章的 `/r/` 可索引页面与 `/go/` 固定302跳转分离。未发布完整说明、停用、链接缺失或无效目标的恢复页面沿用相应状态分支，不把领取链接本身视为已发布文章。Markdown与 llms.txt复用同一已发布内容，不另造第二版事实。

## 5. Evidence and maintenance

源码核对：`cloudflare/resource-links/src/site-shell.ts`、`landing-page.ts`、`index.ts`，以及 `shared/resource-landing.ts` 的发布质量规则；incumbent 对照 `DESIGN.md`、`src/styles/tokens.css` 与既有 `resource-catalog.md` 等 surface。线上样本是版本2的 `https://panxu.site/r/fVOZw5ZbE_Z5`，公开目录为 `https://panxu.site/`。

本次 documenter 目视核对 `../review/article-1440.png`、重拍后的 `article-1366.png`、`article-sources-1366.png`、`catalog-1440.png` 与 `about-desktop.png`；其余长正文、FAQ和完整说明证据为 `article-full.png`、`article-details-1366.png` 与 `about-full.png`，由独立 finish reviewer 复核。1366首屏已按 `article-1366-capture.json` 在1366×768逻辑视口重新捕获，底部连续显示文件信息，无重复站头；此前混帧属于已替换截图证据，不作为 UI缺陷或重设计依据。

独立 finish reviewer 此前已完整审阅本轮布局及 TYPE/MATERIAL/GROUND；最终修复复核见 `../review/resource-landing-review.md`：来源文案泄漏为 resolved，remaining为 clear，disposition为 ship。该最终 ship只覆盖唯一 material fix及其可见回归复查，其他九张沿用此前有效证据；不把它写成另一轮全页面或真实发布验收，也不表示已获得收录、排名、GEO引用或流量。

本轮只覆盖1440×900、1366×768桌面范围；已有980/760px CSS降级规则是实现事实，不表示完成手机、平板或840px专项验收。本 documenter 未运行自动化、AI、付费接口或发布；状态分支的源码存在不等于逐项真实流程验收。没有新增图片素材，截图是验收证据，不是发给读者的产品资产。

既有漂移保留：根 `DESIGN.md` 是既有中文业务规范，未按本版 DESIGN.md schema提供 frontmatter/八节结构；`.impeccable/design.json` 不存在。本次普通扩展不修复这些历史格式差异，也不把公开阅读页的局部中性色与字号规范化成全局 tokens。未改 `DESIGN.md`、侧车、`PRODUCT.md`、源码或其他任务文件。

## 2026-11-02 · 正文质量修订

本轮保持既有Read/Operate布局，改为先提取实际PDF或文本，再整理内容。示例页使用104页PDF中的47页抽样文字，提供10章页码导航、实际条目与适用边界；无FAQ和要点时不绘制空区块。编辑器增加读取/导入原文件及分项质量结果，未发布修改单独标记。内部五项审核至少8.2/10且每项达70%，并通过正文、引用、摘要完整性等硬门槛；该分数不代表搜索平台评分。

最终截图与验收记录已更新，旧finish reviewer的ship结论仅适用于此前批次，未将其延用为本轮独立审阅结论。本轮由主任务逐项对照正文与实际界面验证，详见`docs/features/resource-landing-seo.md`。
