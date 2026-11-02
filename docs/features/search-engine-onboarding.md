# 搜索平台接入

正式站点使用 `https://panxu.site`。Google、Bing 均验证这个域名，不把 Pages/Workers 默认域名当作第二个搜索站点。

## 已配置的站长平台

2026-11-02：

- Google Search Console：网域资源 `panxu.site`，使用 Cloudflare DNS TXT 验证。`https://panxu.site/sitemap.xml` 已提交并成功处理，首次发现4个网址。示例资源页在11:50的 Google 实时检查中显示“网址可编入 Google 索引”，面包屑有效；索引记录仍为“已发现—尚未编入索引”。
- Bing Webmaster Tools：站点 `https://panxu.site/` 已验证，站点地图已提交。初始状态为 `Processing`，由 Bing 异步抓取。
- Bing 使用独立 CNAME 验证记录，并保留首页 `msvalidate.01` 备用验证标签。Google TXT、Bing CNAME 不应删除；首页标签由 Worker 在正式域名的首页 `<head>` 中输出，更新资源内容不会覆盖它。

未把 Cloudflare DNS 管理权授予搜索平台，也未将用户其他站点导入 Bing。站长统计初始为空不等于接入失败。

## IndexNow

IndexNow 已采用服务端直接推送。当前页面不缓存，不能仅依赖 Cloudflare Crawler Hints 的缓存 MISS 信号。

- `INDEXNOW_KEY` 通过 Cloudflare secret 保存，不写入仓库；正式站点根目录的对应 TXT 路径提供 UTF-8 校验内容。该路径只在正式域名响应，使用 noindex，默认域名不提供副本。
- D1 迁移 `0003_indexnow.sql` 添加提交队列。发布或更新正文、撤下已发布内容、修改已公开资源入口时，数据库触发器将公开资源页与目录首页入队；草稿和私人资源不入队。
- 成功的管理写入通过 `waitUntil` 尝试发送，定时触发器每5分钟恢复待发送项。失败使用退避策略，并保留 HTTP 状态、尝试次数和提交时间。并发更新不会被较早请求的成功回执清除。
- 只提交正式页面地址；不提交网盘地址、提取码、账号或正文。主要端点为 IndexNow 官方共享接口 `https://api.indexnow.org/indexnow`；网络不可用时使用 Bing 官方接口 `https://www.bing.com/indexnow`。HTTP 429 保留队列并按退避策略恢复，不连续重发。重定向使用 Workers 支持的 `manual`，校验信息不会随重定向外发。
- HTTP 200 表示提交已接收；202 表示接收后等待校验。两者都不代表已抓取、收录或获得排名。Google 仍通过站点地图发现更新，不使用 IndexNow。

首次已显式提交首页、整理方式页与示例资源页，共享端点返回 HTTP 202，随后通过 Bing 官方端点复核返回 HTTP 200。Bing 的 IndexNow 报表可能延后显示。 11:55的云端自动批次仍收到 HTTP 429 限流回执，队列已验证会保留地址并按退避时间恢复；本机显式提交为 HTTP 200。接入及提交成功不代表每个云端批次已被接收。

## 部署与排查

1. 复制服务配置，设置 `PUBLIC_ORIGIN` 与可选的 `BING_SITE_VERIFICATION`。
2. 配置 `ADMIN_TOKEN`、独立的 `INDEXNOW_KEY` secrets，然后应用迁移并部署 Worker。Pages 使用原有内部服务绑定。
3. 生成新的类型声明；验证 TXT 校验文件200、首页标签、robots和站点地图。
4. 在站长平台提交站点地图。通过 D1 只读查询 `indexnow_submissions` 核对 `status`、`http_status`、`attempts`、`submitted_at`。提交失败应检查网络与校验文件，不修改网盘数据或清空队列。

验收通过17项 IndexNow 专项检查与31项 Worker / D1 路由检查，另完成正式域名的校验文件与首页标签只读核对。

本轮隔离验证：`scripts/check-indexnow-worker.mjs` 检查队列触发、回执、退避、并发版本、撤下通知、默认 Workers fetch 与官方端点传输；`scripts/check-resource-landing-worker.mjs` 覆盖首页验证标签与别名隔离。测试使用独立 D1，推送服务限定为模拟；不替换进程级 fetch。

官方协议：[IndexNow 文档](https://www.indexnow.org/documentation)、[Bing 接入说明](https://www.bing.com/indexnow/getstarted)、[Cloudflare Crawler Hints](https://developers.cloudflare.com/cache/advanced-configuration/crawler-hints/)。


## 2026-11-02 站点地图抓取异常整改

用户原标签页显示“无法抓取”，新读取的列表已显示成功。随后刷新原标签页，也确认状态为“成功”、已发现4个网页。

排查同时发现正式域名的 robots 和 XML 站点地图错误继承了管理响应的 `X-Robots-Tag: noindex, nofollow, noarchive`。现已移除这些抓取入口上的限制，保留文本副本、管理接口与别名的既有索引边界。修复后重新提交了 `https://panxu.site/sitemap.xml`，提交成功，并核对列表状态。已发现数量不代表全部网址已收录。

本轮执行源码类型检查、线上 HTTP 手动核对与 Search Console 手动操作；主站点地图、两个子站点地图及 robots 均返回200。未运行新的自动化测试、制作安装包或修改域名/DNS配置。
