# 落地页 Agent 接手基线 · 2026-11-08

核验日期：2026-11-08，时区 Asia/Shanghai。主要公开 HTTP 样本采集于北京时间 12:57–12:59（04:57–04:59 UTC），运维只读补核于 13:18–13:20，旧资源路径补核于 13:20:59。本报告记录首次只读接手，不是发布、收录或获客效果验收。

## 负责范围与执行边界

本对话“落地页 Agent”长期负责 `https://panxu.site` 的单资源说明页、固定网盘入口、公开清单站点及接口、搜索发现与收录、SEO/GEO 内容质量和真实效果、站长工具、匿名统计及 Cloudflare 运行维护。资源库的采集和网盘管理、本地清单编辑及文档平台分发仍由各自模块维护；共享契约变动前检查所有调用方。

已读取根 `AGENTS.md`、[交接文档](../features/landing-page-agent-handoff.md)、[产品上下文](../../.agents/product-marketing.md)、[实施标准](../features/seo-geo-operating-standard.md)、相关功能、运维及历史验收文档，并采用项目级 ai-seo、seo-audit 与已有 programmatic-seo 中适用的核对方法。当前工作区存在大量并行改动，本轮未改动其源码、配置或既有文档。

本轮只发公开 GET、平台读取及只读查询；不运行访客脚本，不向 `/events` 发送事件，不跟随外部网盘跳转。没有调用付费 AI、转存、创建分享、建链、发布、修改 DNS 或正文、重试 IndexNow、创建定时任务、应用迁移或重启共享后端。公开 HTTP 检查仍可能进入 Cloudflare 请求量或安全日志，不能作为新增用户。匿名浏览器计数与 Cloudflare 请求量应分开解释。

## 当前已验证：公开访问与发现条件

以下为当日实际响应，脱敏证据及正文 SHA-256 见 [HTTP 证据](evidence/landing-page-2026-11-08-http.json)。原始 HTTP 文件暂存在 `/tmp/panxu-landing-baseline-2026-11-08-http/`，内含公开分享信息，不整份复制入仓库。

| 对象 | 本日结果 | 证据与边界 |
| --- | --- | --- |
| [正式首页](https://panxu.site/) | 200、可索引指令、自指 canonical、SSR 目录 | 可进入既有资源与清单；初始 HTML 21,482 字节，无需 JS 获取正文 |
| [示例资源](https://panxu.site/r/fVOZw5ZbE_Z5) | 200、可索引指令、自指 canonical、单一 H1 | 标题为“人情世故指南PDF下载：不会拒绝、怕得罪人时怎么说？”，文件信息、读取范围、正文、依据在初始 HTML 中；本轮未重读 PDF，未独立重审全部事实 |
| [旧简历说明页](https://panxu.site/r/XsP0Nyq9w6fw) | 200、`index,follow`、自指 canonical、完整 SSR 说明 | 由队列和历史事件发现此路径；页面明确文件正文未被读取，未进入今日地图；属于需审阅的旧内容策略边界，不能把地图数量当全部可访问正文数量 |
| [固定跳转](https://panxu.site/go/fVOZw5ZbE_Z5) | 302 至 `pan.quark.cn`，禁缓存，`noindex,nofollow,noarchive` | 未跟随外站，不据此断言文件仍可下载、分享永不过期或接收者可领取 |
| [清单目录](https://panxu.site/catalogs)及[既有清单](https://panxu.site/c/dbedf7b723e3468e) | 均 200、SSR、单一 H1、自指 canonical、可索引指令 | 目录有 1 份清单；详情有 **20 项**，不是历史 18 项；结构化数据与页面数量一致 |
| [robots](https://panxu.site/robots.txt) | 200，无意外 `X-Robots-Tag` | `User-agent: *` 放行公开路径，排除 `/api/`、`/go/`，声明正式地图 |
| [地图索引](https://panxu.site/sitemap.xml)与 3 个子地图 | 均 200，无意外 noindex | 站点页 3 个（首页、about、catalogs）、单资源 1 个、清单 1 个；合计是地图 URL 数，不是搜索引擎索引数 |
| [llms.txt](https://panxu.site/llms.txt)及[资源 Markdown](https://panxu.site/r/fVOZw5ZbE_Z5.md) | 均 200，均 noindex | llms 发现目录与公开样本一致；Markdown HTTP `Link` canonical 指回 HTML，不形成第二篇文章 |
| [about](https://panxu.site/about)与[privacy](https://panxu.site/privacy) | 均 200，about 可索引；privacy `noindex,follow` | 说明整理方法、AI 参与、范围与统计口径；本轮未作法律或隐私合规审计 |
| `/api/health` | 200，返回服务名与协议 version=1 | 仅服务标识，不验证数据库就绪、运行源码版本或管理令牌 |
| 首页分类、清单分类、清单目录搜索 | 3 个参数样本均 `noindex,follow` | canonical 回对应无参数正式页；未遍历所有筛选组合与分页 |
| Pages 别名的同资源页 | 200、`noindex,follow`、canonical 回正式域 | 不作为第二个搜索站；此样本未注入事件脚本 |
| workers.dev 历史别名 | 本环境连接重置，未取得 HTTP 响应 | 不判定全球故障，不影响本轮正式域样本成功的事实 |

首页、资源与清单均输出“盘序资源”品牌、图标声明及可解析的 JSON-LD；首页含 WebSite，资源含 WebPage、CreativeWork 与 BreadcrumbList，清单含 CollectionPage 与 ItemList。本轮核对了 HTML 中的声明，没有执行浏览器视觉验收或搜索富媒体测试，不能据此保证搜索采用站名、图标或富媒体样式。

公开清单 `dateModified` 与清单子地图 `lastmod` 都为 `2026-11-08T04:22:48.302Z`（北京时间 12:22:48）。示例资源仍为 `2026-11-02T03:57:00.615Z`。这些是公开快照日期，不是本轮修改记录。请求经 AMS/LAX 等边缘节点，不替代中国大陆关闭代理后的接收者网络验收。

## 当前已验证：源码及协议边界

以下仅证明 2026-11-08 工作区源码状态，部署一致性另行核对。

- Pages 适配器通过内部 `RESOURCE_LINKS.fetch(request)` 调用原 Worker；配置沿用原服务与 D1。见 `cloudflare/resource-links/pages/worker.ts:7`、`pages/wrangler.jsonc:6`、`wrangler.jsonc:15`。
- `/r/` 正文、`/go/` 302、停用 410、未发布领取页及别名索引边界均有独立路由；正式 robots/地图不继承管理响应的 noindex。见 `cloudflare/resource-links/src/index.ts:270`、`:468`、`:488`、`:519`。
- 新发布摘要仍为 25–120 字、完整句子；需实际正文依据、有效引用、总分至少 82/100、每项至少 70%、无不支持事实和现行审核规则版本。总分不是搜索平台评分。见 `shared/resource-landing.ts:6`、`:201`、`:271`、`cloudflare/resource-links/src/landing-store.ts:131`。
- 自动优化使用当前编辑及最新依据，摘要异常单独重写，再独立审核；至多两轮、六次 AI 请求，不自动发布、不降低门槛。见 `core/resource-landing.ts:475`、`:553`、`:603`、`:640`、`:679`。
- IndexNow 使用触发器队列及既有 5 分钟 cron，失败退避至 6 小时；200/202 标记 submitted。见 `cloudflare/resource-links/src/indexnow.ts:59`、`:98`、`:108`。不通过读取触发本轮推送。
- 匿名事件按 UTC 日汇总，尊重 DNT/GPC，文档可见后计 view，复制成功才计 copy，同一文档同类事件最多一次。管理读取近 28 天；桌面凭据白名单已包含 GET traffic。见 `cloudflare/resource-links/src/landing-traffic.ts:18`、`:61`、`:109`、`desktop/resource-links-network.ts:13`。未在桌面运行后端验证此白名单修复。

## 平台读取与待核对

| 平台或指标 | 本轮实际情况 | 结论边界 |
| --- | --- | --- |
| Cloudflare 插件 | 身份工具可响应；既有账号 Pages、Worker deployments、zone 均 HTTP 403；D1 仅查询表名的 SELECT 请求也为 403 | 当前插件连接不能读取这些资源；没有重新连接或申请扩权。后续使用既有 Wrangler OAuth 只读成功，见下文 |
| Google Search Console / Bing | 工具未列出可用浏览器连接；尝试读取运行中的 Chrome 被工具以“当前浏览器 URL 不允许 Computer Use”中止 | 浏览器会话已结束，未继续导航或绕过限制；未读到今天的站长报表，不等于站点未验证、无索引或账号无权限 |
| IndexNow 队列、迁移与匿名计数 | 既有 Wrangler OAuth 只读成功，账号和 D1 ID 与项目一致 | 已取到当日快照；不能把事件计数当搜索平台点击、UV 或下载成功 |
| GEO 实际引用 | 本轮未运行跨引擎回答采样 | 仍为“未测量”，不是零引用；公开抓取成功不等于 AI 回答采用 |
| 两份 Word 草稿状态 | 目录与地图列出 1 篇 PDF；另补核到 1 篇旧“社招数据分析师简历”说明 | 旧说明与历史“商业分析”“toB 运营”两份草稿不同，不能据此判定两份草稿已发布或仍私有；需本地/鉴权元数据单独读取 |

### Wrangler 只读补核

项目子目录未安装可直接运行的 Wrangler，使用官方固定版本 4.156.0 临时 CLI，缓存与日志放在 `/tmp/panxu-landing-baseline-2026-11-08-ops/`。既有 OAuth 可用，没有新登录或扩权，没有改动项目依赖。永久脱敏结果见 [运维证据](evidence/landing-page-2026-11-08-ops.json)。

- Worker 最新观测部署 100% 使用 `c7078c39-0ea7-422e-840d-3642a439a716`，部署时间 `2026-11-04T14:01:12.264771Z`，与历史样式部署记录一致；不据此声称所有当前未提交源码都已上线。
- Pages 生产列表最新记录为 `e8e940fb-1803-41f1-9040-2b0827114128`、main，CLI 显示 `6 days ago`；列表另有更早 Failure 记录，不能当成当前故障。正式域的当前可读性由前述 HTTP 样本单独证明。
- D1 已应用迁移 0001–0005。四条 SELECT 的元数据均为 `changed_db=false`、`rows_written=0`；未查询秘密值、完整资源文档或分享目标。
- **IndexNow 当前 6 项 pending，最近 HTTP 状态均为 429**。路径是首页、about、catalogs、既有清单、PDF 资源及一条旧资源路径；三项 attempts=6，三项 attempts=32。读取时记录的下次退避为北京时间 13:37:52、16:00:51、16:25:52，本轮未触发重试。`updated_at` 不作为最近推送时间解释；该表没有独立的最近尝试时间字段。
- 匿名统计查询口径为 UTC 2026-10-12 至 11-08，读取时截止 `2026-11-08T05:19:26.918Z`。实际启用时间为 `2026-11-04T08:45:03.432Z`（北京时间 11 月 4 日 16:45:03），不是完整 28 天运行数据。

| 匿名来源分类 | view | outbound | copy |
| --- | ---: | ---: | ---: |
| direct / 未知 | 31 | 2 | 0 |
| google | 3 | 0 | 0 |
| 合计 | **34** | **2** | **0** |

以上为数据库已记录的浏览器事件，可能包含开发核验、重复文档打开和自动化访问。历史已知开发者事件不能完全从无访客 ID 的聚合数据中还原剔除；不能把余额都归为真实用户。Google 分类的 3 次 view 均在 UTC 11 月 5 日，分别出现在首页、PDF 资源和一条旧资源路径，只说明浏览器来源域被分类为 Google，不能代替 GSC 点击/查询或证明索引。没有 AI 分类记录也不等于零引用。清单页尚未统计，当前没有足够证据计算清单转化或获客增长。

## 历史记录：只按当时口径理解

- 2026-11-02：正式域、Pages 服务绑定、DNSSEC、18 条固定入口迁移及 GSC/Bing 接入已有完成记录。本轮未重新验证父区 DS、注册商续费或全部 18 条入口。
- 2026-11-04：[历史基线](seo-geo-baseline-2026-11-04.md)中的 GSC 0 展示/0 点击仅覆盖图表当时的 11 月 1–2 日；Bing 地图成功也是当日状态，均不外推至今天。
- 同日 IndexNow 有 4 项 pending、HTTP 429、退避样本 attempts=17，不能不经读取就认定仍限流或已恢复。
- 同日匿名 view=1/outbound=1 明确来自开发核验，不是新增用户。桌面统计读取白名单修复当时待用户手动应用，其他重启记录不能替代该端到端验证。
- 两份 Word 草稿当时只保存；9.6/9.9 是内部审核分数，不是收录质量分。清单历史 18 项已被本日公开 20 项的证据更新；历史报告保留原值。

## 内容与测量线索

1. **清单主题范围需复核。** 当前 20 项中可见“墓碑百方”“小说目录”“英语语法宝典”等条目，与“求职与个人成长”标题及简介的匹配程度需要编辑判断。本轮只记录线索，不判定无价值，不代资源清单模块删除条目或重新发布。清单条目说明不等于核读每份原文件。
2. **旧元数据说明页与发现目录条件不同。** `/r/XsP0Nyq9w6fw` 可索引且有通用改写建议，但明确未读取文件正文；没有列入地图。源码 `landing-eligibility.ts:14` 保留 v1 快照兼容，而 `landing-store.ts:57` 的目录查询要求 documents 与 dimensions，能解释此现状。需明确旧页是否继续参与索引及如何补充真实依据；不擅自撤下，也不通过放松新发布条件解决。两份 Word 草稿状态仍独立待核对。
3. **旧资源摘要与现行新发布规则不同。** 既有 PDF 页正文摘要及 CreativeWork description 为 136 个 Unicode 字符，meta description 为 80 个。快照更新仍为 11 月 2 日，适用旧页保持可读规则；不能据此声称现行 120 字发布校验失效。后续修订应完整精简并重审，不能直接截断或机械刷新日期。
4. **统计目前不覆盖公开清单。** 事件 schema 仅允许 `/`、`/r/<slug>`；清单目录和 `/c/` 不注入脚本，清单打开网盘直接用发布快照中的官方分享地址。现有计数不能称为全站、清单转化或成功下载。见 `shared/landing-traffic.ts:38`、`cloudflare/resource-links/src/site-shell.ts:71`、`catalog-page.ts:47`。
5. **DOCX 来源文案尚有通用物理页措辞。** 文件区已区分 PDF 物理页与 DOCX 文本片段，但通用来源说明及 Markdown 末尾仍写“物理页”。未来公开已读 DOCX 页时会产生范围表述冲突。见 `cloudflare/resource-links/src/landing-page.ts:93`、`:96`、`:139`、`:153`。本轮未修改代码，没有核定两份已读 Word 草稿的当前发布状态。

## 按影响排序的后续维护事项

| 优先级 | 事项 | 可核验的完成条件 |
| --- | --- | --- |
| P1 | 排查 IndexNow 持续 429 | 读取推送链路与平台诊断，定位当前 6 项退避原因；保留队列、操作与退避，不强制连续重发，不把一次 200/202 当收录 |
| P1 | 补齐站长与 GEO 真实效果 | 可用会话下读取 GSC/Bing 的查询×页面、展示/点击/索引及报告截止日；沿用 P01–P10 并结合真实查询记录引擎/功能、中文地区、问题、次数 n、实际引用 URL 与准确性，未测保持未测，不建定时任务 |
| P1 | 审阅公开内容范围与发现策略 | 明确当前 20 项清单是否符合标题/简介，以及未读取正文的旧兼容页是否继续可索引；实际内容变更需按职责编辑、补证据并显式更新，不自动同步本地变更 |
| P2 | 统一旧摘要与文档依据措辞 | 后续有内容编辑授权时处理 136 字旧摘要、DOCX 文本片段文案；保留事实、独立审核与显式发布边界 |
| P2 | 明确或扩展清单统计覆盖 | 先定义目录、清单页及出站计数口径，再决定是否实现；继续匿名、尊重隐私信号，不能将 /go 请求量或来源分类当成功下载/引用率 |

## 本轮官方资料核对

核对日为 2026-11-08。Google 说明 AI Overviews/AI Mode 沿用基础 SEO，链接候选须已索引且具备摘要资格，不要求额外 AI 文件或特殊 schema，技术条件满足也不保证抓取、索引或展示；其流量包含在 Search Console 的 Web 整体数据中。[Google 官方说明](https://developers.google.com/search/docs/appearance/ai-features)

OpenAI 区分搜索发现的 OAI-SearchBot、潜在训练的 GPTBot 与用户触发的 ChatGPT-User；这些控制互不等同。robots 放行与可读性只是访问条件，不能代替实际引用记录。[OpenAI 爬虫说明](https://developers.openai.com/api/docs/bots)

IndexNow 200 仅表示收到 URL，202 表示收到且待密钥验证；429 表示请求过多。接收回执不等于收录。[IndexNow 官方协议](https://www.indexnow.org/documentation)

## 检查与收尾

本轮交付为新日期报告及脱敏 HTTP、运维证据，仅做文档、链接路径及 JSON 静态检查，不跑全量测试或构建、不声明 UI 与端到端测试通过。未新建桌面测试窗口；浏览器工具读取受限后已结束该会话，已通过 `npm run dev:window -- --focus main` 切回盘序主窗口。临时 CLI 进程已退出。后续继续在本对话维护，不向其他维护对话发送消息。
