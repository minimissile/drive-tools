# 落地页 Agent：线上维护与 SEO/GEO 交接

交接日期：2026-11-08。工作区：`/Users/nuke/Desktop/drive-tools`。这是从资源库历史对话、既有 SEO/GEO 维护对话、项目文档和当前源码蒸馏的维护记忆，不是本日线上验收报告。历史部署、查询、页数与流量均按其记录日期理解；实际服务状态、版本、授权和流量须重新读取。

专用维护对话 ID：`01a1b983-02b4-7541-8bd4-433add0c9361`（本地项目“网盘营销工具”，对话名“落地页 Agent”）。

## 职责与目标

专门维护盘序公开资源站 `https://panxu.site`：资源落地页、稳定网盘入口、公开资源清单的站点展示与发布接口、SEO/GEO、发现与索引、访问与获取统计、Cloudflare 部署及线上故障排查。目标是获得与资源真实内容匹配的搜索访问和 AI 引用，并帮助读者判断资料是否适合，再进入真实网盘。

维护对话名为“落地页 Agent”。资源库继续负责采集、录入、网盘资源管理；资源清单 Agent 负责本地清单编辑、条目维护、AI 筛选及文档平台分发。落地页 Agent 负责公开站点及这些模块与站点的接口，修改共享契约时先检查现有调用方，避免双方同时改同一文件。

用户偏好：中文、紧凑白色桌面工作台；操作直接，避免重复确认、核对复选框和多余入口。主动完成已授权的开发与相关测试。遇到真正缺失的权限或资料时说明具体缺口，不因常规实施选择反复停下来确认。

## 必须先读的权威文件

1. 根 `AGENTS.md`：最新开发、手动应用后端、共享窗口及测试规则；优先于旧验收日志。
2. [产品上下文](../../.agents/product-marketing.md) 与 [SEO/GEO 实施标准](seo-geo-operating-standard.md)。
3. [资源落地页功能与质量](resource-landing-seo.md)、[固定入口](resource-links.md)、[搜索平台接入](search-engine-onboarding.md)。
4. [Cloudflare 运维说明](../../cloudflare/resource-links/README.md)、[资源清单](resource-catalog.md)。
5. [SEO/GEO 历史基线](../reviews/seo-geo-baseline-2026-11-04.md)、[清单站点验收](../reviews/resource-catalog-site-2026-11-04.md) 及 [清单样式记录](../reviews/resource-catalog-style-2026-11-04.md)。

若历史说明与当前源码、实际部署或根约定不一致，标记差异并以最新证据核对，不能仅凭某篇文档的“当前”二字判断运行状态。

## 线上地址与架构

| 入口 | 用途 |
| --- | --- |
| `https://panxu.site/` | 正式站点与已发布资源目录 |
| `/r/<短码>` | 单资源说明页；合格且显式发布后可参与索引 |
| `/go/<短码>` | 302 网盘跳转；分享失效后可换目标，短码保持，不参与索引 |
| `/catalogs`、`/c/<短码>` | 已发布主题清单目录与详情 |
| `/r/<短码>.md`、`/llms.txt` | 内容文本表示与发现目录；不代表获得 AI 引用 |
| `/sitemap.xml`、`/robots.txt` | 搜索发现入口；不能误带管理接口的 noindex/nofollow |
| `/about`、`/privacy` | 整理方法、AI 参与、范围与统计说明 |
| `/events` | 同域匿名浏览器事件采集 |

链路：访客 → Cloudflare Pages（自定义域 `panxu.site`）→ 内部服务绑定 `RESOURCE_LINKS` → Worker `panxu-resource-links` → D1 `panxu-resource-links`，绑定 `DB`。

Pages 默认域 `panxu-resource-links.pages.dev` 保留；Worker 默认域 `panxu-resource-links.mininuke567.workers.dev` 是历史入口。别名不是独立搜索站点，canonical 统一到正式域。不要把公开访客改回依赖 `workers.dev`；用户此前遇到其在国内不可达的问题，真实接收者网络可达性仍应按环境验收。

用户最初没有服务器与域名，后来在 Spaceship 购买 `panxu.site`。域名注册和续费仍在 Spaceship，DNS 已委派 Cloudflare，Pages 自定义域与 HTTPS 已接通。2026-11-02 记录 DNSSEC 已恢复，父区 DS 与 Cloudflare 一致；日常页面维护无需切换 NS、关闭 DNSSEC 或重建站点。账号、区域、D1 的非秘密标识及接入细节见 Cloudflare README，核对后复用。

## 内容流程与硬门槛

桌面入口：资源库 → 资源档案 → 固定入口 → 落地页内容。先核验本人分享及文件清单，读取实际正文或导入同名原文件，再生成/编辑/优化草稿，独立审核，最后显式发布。

- PDF、DOCX、TXT、Markdown 原文件最多 20MB。DOCX 本地提取文字；旧 DOC 需另存。扫描件、图片、压缩包不能冒充已读正文，尚未接入 OCR 与压缩包内容阅读。
- PDF 物理页码与 DOCX/文本片段编号不同；抽样提取必须说明范围，不能说通读全文。不能从 DOCX 文字推断字体、视觉排版、真实页数和编辑兼容性。
- 事实需要对应 `evidenceIds`，公开短摘录、读取范围和指纹；不上传整份原文。仅把可公开且已核实的编辑补充作为依据，不把宣传文章署名当文件作者。
- 内部总分至少 82/100，每个维度至少达到其满分 70%，且无不支持的事实。五维为依据25、帮助判断25、特有价值20、自然表达15、可信度15；分数不是搜索引擎评分。
- 摘要 25–120 字，必须是完整句子。要点和 FAQ 可空，不硬凑篇幅；文件信息、正文读取、引用、重复、虚构承诺及联系方式等仍有独立硬检查。
- AI 调用在桌面显式触发，使用现有凭据、预算与费用回执。访客访问仅读取已发布快照，不实时调用 AI。
- 不发送 Cookie、签名下载地址、系统路径、管理令牌或提取码给模型；先限定字段，再脱敏。不要把整份 skill 直接注入运行时提示词。
- 未达标时有“自动优化”，使用当前未保存编辑、最新依据和有效检查问题修订；重新审核，必要时额外修订一次。摘要截断时单独重写短摘要，不裁切或补标点伪装完整。一次流程最多六次 AI 请求；不足时仍保留问题，不降门槛、不循环刷分。
- 草稿不自动发布。多窗口使用草稿版本、来源指纹与资源锁避免覆盖；请求失败保留原稿，结果不明确只读核对，不自动重放付费请求。
- 发布使用 `operationId`、版本与入口修订校验，远端写入后读取回执。未知提交保持原操作，可“重试原发布”；不要换操作号重发。撤下保留草稿和固定入口；停用入口、撤下及空清单的索引行为分别处理。

## SEO：用户角度的标题、摘要与站点发现

用户明确不接受泛化、AI 味重、看似完整却没有具体信息的介绍；标题摘要要有搜索关键词和点击理由，但不牺牲真实性。

1. 资源主词放前面，格式、用途、主题和获取意图词只能基于实际文件与已核验入口。标题、摘要、首段及正文兑现同一承诺。
2. 用实际章节、例子、条目、适用人群及局限解释独特价值。换成另一份同类资源标题后大部分仍适用的正文应修订。
3. 不编造搜索量，不把候选长尾词标为高流量词。无依据的免费、最新、完整版、免登录、直链、全网最全、亲测等不能用于诱导点击。
4. SSR 初始 HTML 输出正文；保留唯一清晰 H1、title/description、canonical、相关内链、真实更新日期、适当结构化数据。不要为新鲜度机械改日期。
5. 品牌为“盘序资源”，图标复用盘序折页 P；已有 WebSite/Organization、面包屑和图标输出。下载操作、提取码及重复信息使用摘要范围控制；实际搜索展示由平台决定。
6. 筛选、翻页、跳转、管理接口、别名和文本副本的索引策略各自维护，不把无价值变体堆进地图，不为同资料批量造关键词页面。
7. 清单是显式发布快照，含条目说明不等于核读每份原文件。已有合格单资源页可关联；新建空清单不发布，存量可更新为空移除失效链接，空清单不参与索引。

Google Search Console 的网域资源为 `panxu.site`，Cloudflare TXT 验证；Bing 站点为 `https://panxu.site/`，保留 CNAME 与首页备用标签。站点地图均已有成功处理记录，不能删验证记录或另建 Pages 别名站点。IndexNow 由服务端队列发送，secret 为 `INDEXNOW_KEY`，数据库触发器入队，5分钟 cron 恢复；429 保留退避，200/202 仅表示接收状态，不代表收录。Google 不通过 IndexNow 接收通知。

## GEO：可引用性与真实效果

先读盘序适配标准，按任务使用项目级 `.agents/skills/ai-seo/SKILL.md`、`.agents/skills/seo-audit/SKILL.md` 与已有 `programmatic-seo`。引入版本及上游来源见 `.agents/skills/SEO-UPSTREAM.md`。历史未采用泛化 `seo-geo` skill 作为默认规则。

- 关键结论带清晰对象、适用条件、限制与依据，摘取后仍能正确理解；用自然中文，不强塞固定长度段落、统计、专家语录、表格或 FAQ。
- 搜索爬虫、模型训练爬虫、用户触发访问分开理解；不能用放行训练爬虫、llms.txt 或某种标记承诺 AI 流量。相关技术判断查当前官方资料，不把旧 skill 研究比例当结论。
- SEO 看 GSC/Bing 的查询×页面、展示、点击、CTR和位置；`site:`结果数、地图发现数及 IndexNow 回执都不是实际索引总量或排名。
- GEO 按引擎/功能、日期、语言地区、查询原文及样本次数记录实际引用 URL、推荐与回答准确性；提及、引用和来源点击分别计。单次结果不能代表稳定引用率；未测写“未测量”，不能填假0。
- 使用历史基线的 P01–P10 中文问题集合起步，不为每个问题新造页面。优先用后续真实查询修订候选问题。
- 改动前记录起点和可检验假设，数据足够后比较相同口径28天。技术测试、模型高分、UA 模拟抓取与开发者访问，都不能冒充真实搜索表现。

## 访问统计与隐私

同源 `/events` 按 UTC 日聚合 view/outbound/copy 及固定来源分类。只在文档可见后计访问，复制成功才计复制，同一文档同类事件最多一次；尊重 DNT/GPC，有请求校验和限流。不存 IP、Cookie、访客 ID、指纹、完整来源 URL、搜索查询、原文件或提取码，不加载第三方分析脚本。

最多保留90天，桌面“访问与获取”按需查看近28天，鉴权读取 `/api/traffic/:id`。这些不是 UV、成功下载数、搜索平台点击数或 AI 引用率；来源丢失、网络、隐私设置和限流会导致少计。开发核验访问需注明，不能写成获客增长。

## 历史节点与未完成核对

| 日期 | 已记录事实 | 不能外推的部分 |
| --- | --- | --- |
| 10月30日 | Wrangler OAuth、D1、Worker 固定入口初次部署 | 不是今天的版本或授权可用性证明 |
| 11月2日 | Pages、panxu.site、HTTPS、DNSSEC及18个入口迁移；真实 PDF 落地页上线 | 国内关闭代理可达性仍按接收者网络验证 |
| 11月2日 | GSC/Bing验证、地图与IndexNow接入；修复robots/地图误带noindex | 地图成功和推送200/202不等于已收录 |
| 11月4日 | 品牌图标、站名、摘要范围；SEO/GEO规则与匿名统计部署 | 未为此重写全部旧页，也无新增流量结论 |
| 11月4日 | 修复DOCX不可读、摘要180/120规则冲突、120字受约束解码截断；自动优化走通 | 两份简历当时只保存草稿，未公开发布 |
| 11月4日 | 清单站点、迁移0005；真实“求职与个人成长资源清单”18项发布及紧凑目录样式 | 本地条目改动不自动更新公开快照 |
| 11月5日 | 本地清单增加AI筛选、固定集合、条目编辑与可撤销删除 | 维护权限不因此扩张至真实批量发布 |

历史示例：`https://panxu.site/r/fVOZw5ZbE_Z5`（人情世故指南PDF），对应 `/go/fVOZw5ZbE_Z5`；清单 `https://panxu.site/c/dbedf7b723e3468e`。它们是既有检查样本，先核对是否仍公开，不把它们当成可任意改写的测试夹具。

2026-11-04 基线：GSC当时显示0展示/0点击，但图表只覆盖11月1–2日，不能评价改造后的效果；Bing地图成功；GEO引用未测。IndexNow当时有4项pending且HTTP429，需重查今天的队列，而不是假定现在仍限流或已恢复。首次 view=1/outbound=1 为开发者核验。

同日曾修复桌面凭据传输白名单遗漏 GET `/api/traffic/:id`，当时后端尚待用户手动应用，端到端读取待复核。后续其他对话的重启记录不能自动证明这一项已验收。两个 Word 草稿当时内部9.6/9.9分，不作为收录分数；目前是否发布需读取现状。

## 代码导航、部署与验证

| 领域 | 主要位置 |
| --- | --- |
| 生成、优化、审核、发布恢复 | `core/resource-landing.ts`、`core/ipc/resource-landing.ts`、`shared/resource-landing.ts` |
| 搜索编辑规则与版本 | `core/landing-search-policy.ts`，当前源码规则 `panxu-search-2026-11-04` |
| 正文与原文件 | `core/landing-document.ts`、`core/landing-docx.ts`、`shared/landing-document.ts`、`core/drive-files.ts`、`desktop/main.ts` |
| 桌面编辑与统计 | `src/resource-landing/ResourceLandingDialog.tsx`、`LandingTrafficPanel.tsx`、`landing-editor.css` |
| 固定入口与网络凭据边界 | `core/resource-links.ts`、`core/ipc/resource-links.ts`、`desktop/resource-links-network.ts`、`shared/resource-links.ts` |
| 公开路由、页面与发布校验 | `cloudflare/resource-links/src/index.ts`、`landing-page.ts`、`landing-store.ts`、`landing-eligibility.ts`、`page.ts`、`store.ts` |
| 品牌、发现与统计 | 同目录 `site-shell.ts`、`site-brand.ts`、`brand-assets.ts`、`search-verification.ts`、`indexnow.ts`、`landing-traffic.ts` |
| 清单衔接 | `core/catalog-landing.ts`、`shared/catalog-landing.ts`、站点 `catalog-page.ts`/`catalog-store.ts`/`catalog-style.ts` |
| Pages 适配 | `cloudflare/resource-links/pages/worker.ts`、`pages/wrangler.jsonc` |

迁移0001–0005分别用于固定入口、正文、IndexNow、匿名统计及公开清单。维护时核对远端迁移，不重新创建 D1，不修改已部署历史SQL。凭据沿用既有官方Wrangler授权与加密存储；`ADMIN_TOKEN`、`INDEXNOW_KEY` 只作为secret，绝不读取展示、抄入文档或放进公开页面。插件历史发生过CIMD临时不可用，官方Wrangler是已授权采用过的替代路径，未来仍以实际权限为准。

Worker 与 Pages 分别部署：业务/SSR改动通常部署Worker，只有Pages适配器或绑定变更才需Pages部署。当前脚本位于 `cloudflare/resource-links/package.json`：`types`、`check`、`db:migrate:remote`、`deploy`；Pages为 `pages:types`、`pages:check`、`pages:build`、`pages:deploy`。Pages脚本保留 `--force` 以避免部署成Worker。部署先审查当前差异，不能把并行未完工作整包发布；需要迁移时先按已授权范围备份与迁移，再部署并读取线上回执。不要照抄“首次部署”命令重建生产实例。

相关领域测试为 `tests/resource-landing.test.ts`、`tests/landing-document.test.ts`、`tests/resource-links-network.test.ts`。Worker/D1隔离脚本为 `scripts/check-resource-landing-worker.mjs`、`scripts/check-indexnow-worker.mjs`；公开读取、发布、正文与界面另有 `check-resource-landing-*.mjs`。先审查脚本是否含真实生成、发布、主窗口操作或旧独立实例假设，再选择运行，不能把脚本名称当成只读保证。

最新根约定：默认主动做相关自动化，纯文档只静态检查；桌面测试使用本任务专属 `test:session`/`withDevTestSession`窗口并准确清理ID；不操作主窗口、不全局拦截fetch、不启动第二套后台。后端只编译暂存，由用户点击应用，不能自动重启或把旧运行后端的结果当新代码通过。线上维护授权不自动包含清库、凭据扩权、付费生成、真实网盘写入或批量发布；按具体已授权任务执行。

## 首次接手任务及维护记忆

先完成一次只读接手核对：正式域、示例资源/清单、固定跳转、robots、地图、canonical、品牌与SSR；可用时读取站长工具、IndexNow回执及匿名统计。标出“已验证/历史记录/尚未核对”，为每项记录日期及证据；访问本身若进入计数，标注开发核验。无法访问的平台只记待核对，不反复索要确认或伪造指标。

首次接手不改变DNS、生产数据或现有正文，不触发AI生成/建链/真实发布，不创建后台定时任务。先在新对话汇报接手完成、当前证据及按影响排序的待办，后续用户在该对话继续交付维护需求。每次重要变更更新相应功能文档和新日期的验收/效果记录，保留历史，不把本文件变成长期不变的唯一真相。

历史对话索引：资源库 Agent（`01a182d1-7488-7ff2-be92-bd0916b0eb9a`）；资源库 Agent -SEO&GEO（`01a19a2f-089c-7072-b322-b55b09984743`）；资源清单 Agent（`01a1a609-7cd2-7002-a39c-276cc8bc3505`）。这些用于追溯，不自动替代最新用户指令或扩大权限。
