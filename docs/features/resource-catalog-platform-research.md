# 资源清单：平台接入可行性调研

调研日期：2026-10-29。范围：飞书、腾讯文档、石墨文档；依据官方开放平台文档和官方 SDK。调研未登录用户账号、未创建或修改远端文档、未调用付费接口。

## 结论与产品路线

三个平台都能承载供读者访问的资源清单，但「网页登录成功」与「应用可以调用官方 API 发布」是两种授权。不能把平台 Cookie 当作开放平台令牌，也不能把打开编辑器、复制正文或保存 URL 算作远端写入成功。

| 平台 | 官方 API 可行性 | 自动发布的前置条件 | 无开放平台凭据时的可用路径 |
| --- | --- | --- | --- |
| 飞书 | 创建 docx、编辑块、管理分享权限有官方接口 | 应用凭据、所需权限和目标文件权限；以用户身份写入时另需 OAuth | 在隔离登录会话打开官方工作台，粘贴清单或导入文件，登记分享链接 |
| 腾讯文档 | 创建文件、更新文档/表格、设置公开阅读均有官方接口 | 已审核应用的 Client ID/Secret、用户 OAuth、接口权限与调用额度 | 同上；平台内设置「任何人可查看」并核验分享链接 |
| 石墨文档 | 官方 SDK 支持创建协作文档、导入和协同编辑 | 向石墨申请 appId/secret、签名、可被石墨访问的回调服务 | shimo.im 官方工作台手动发布与维护，登记分享链接 |

首期可交付的是完整的**辅助发布与维护流程**：分类筛选 → 生成清单快照 → 预览/复制或导出 → 使用所选账号打开平台 → 用户在平台完成发布 → 登记读者链接及对应快照 → 本地资源变化后提示待更新 → 更新同一远端文档并登记新快照。用户可直接分发已登记的读者链接。无需开放平台审核，也不依赖未公开私有接口。

官方 API 自动发布可沿同一快照与发布记录模型接入。未提供对应凭据或完成外部授权时，应明确说明需要的条件，不能显示「一键同步」已经可用。受控浏览器自动操作编辑器需要各平台真实账号的端到端验收；复杂编辑器、验证码和产品改版使其不适合作为未经验证的默认发布协议。

## 飞书

官方服务端 API 提供[创建文档](https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document/create)、[创建块](https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document-block/create)和[批量更新块](https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document-block/batch_update)入口。创建与内容写入是分开的操作，适配器需要保存 document_id、受盘序管理的块 ID 和实际完成的步骤；不能仅凭创建空文档成功就记作清单发布成功。官方[云文档连接器说明](https://www.feishu.cn/content/383321056779)也列出了新版文档的创建、读取和删除块能力。

鉴权应使用官方访问令牌流程。企业自建应用通过 App ID/Secret 取得 tenant_access_token；官方[快速上手示例](https://www.feishu.cn/content/474748863724)展示了该方式。用户身份令牌需要独立 OAuth。浏览器登录会话仅用于官方页面登录与编辑，不替代开放平台授权。

对外可访问还涉及[文档分享设置](https://open.feishu.cn/document/server-docs/docs/permission/permission-public/patch)。文档 URL 存在并不代表组织外读者可读；应用权限、文档权限和组织的外部分享策略都可能阻止操作。自动接入应在写入完成后读回分享设置，保留「内容已写入、外部访问待处理」状态。更新同一文档时仅替换受盘序管理的内容，避免清空用户在平台手工增加的文字。

说明：本轮浏览工具可以确认飞书官方 API 文档入口，但部分页面正文由脚本渲染，未取得完整的字段及限额正文。具体请求字段、细粒度 scope、分批上限应在实现该适配器前通过当前官方 API Explorer 或 SDK 再核对；不能把社区镜像当作已完成真实接入验证。

## 腾讯文档

[官方接入教程](https://docs.qq.com/open/document/app/get_started.html)明确要求先注册开发者、创建并审核第三方应用，取得 Client ID/Client Secret；用户扫码同意授权后，用回调 code 换取令牌。API 请求需要 Access-Token、Client-Id、Open-Id 三个头部，普通网页登录 Cookie 不符合这个鉴权协议。

[官方 OAuth 流程](https://docs.qq.com/open/document/app/oauth2/)给出的授权码有效期为 5 分钟且只能使用一次，Access Token 为 30 天，Refresh Token 为 1 年；授权、令牌换取和刷新应由后端维护。Open ID 可能随用户账号绑定/解绑发生变化，因此必须核对授权主体，不能把旧令牌与新 Open ID 混用。权限变更后需要[重新授权](https://docs.qq.com/open/document/app/scope.html)。

已核实的写入与公开阅读接口：

| 目的 | 官方接口与约束 |
| --- | --- |
| 创建文档或表格 | [`POST /openapi/drive/v2/files`](https://docs.qq.com/open/document/app/openapi/v2/file/files/create.html)，类型包括 doc、sheet、smartsheet；默认创建空文档；标题上限 36 字符；需要 `scope.drive.creatable` |
| 更新文档内容 | [`POST /openapi/doc/v3/{fileId}:batchUpdate`](https://docs.qq.com/open/document/app/openapi/v3/doc/batchupdate/update.html)，单次最多 30 个操作；该批次任一操作错误则整批不生效；需要 `scope.doc` |
| 设置分享权限 | [`PATCH /openapi/drive/v2/files/{fileID}/permission`](https://docs.qq.com/open/document/app/openapi/v2/file/files/permission/set.html)，需要 `scope.drive.file.permission` |
| 公开可读 | 官方 [policy 定义](https://docs.qq.com/open/document/app/openapi/v2/file/files/permission/common.html)中 `publicRead` 表示任何人可查看，`publicWrite` 则允许任何人编辑；资源清单面向读者时应使用前者 |

在线表格有独立内容接口。当前[表格接口目录](https://docs.qq.com/open/document/app/openapi/v2/sheet/)明确将 V2 标为已废弃、V3 为推荐，后续适配不应根据旧博客采用 V2。接口需按[官方请求规范](https://docs.qq.com/open/document/app/openapi/v2/)检查 HTTP 状态和业务码 `ret`，不能根据 `msg` 的文本猜测成功。

费用不能默认忽略。[官方开放接口概述](https://docs.qq.com/open/document/app/)目前说明自 2025-07-01 起每应用提供 20,000 次限免调用，并提供资源包采购入口。额度、到期时间、实际计费规则需以接入应用后台为准；自动读取页面不能隐式触发有额度成本的写入或重复重试。

## 石墨文档

能够核实的一手技术路线是[石墨 SDK 核心概念](https://sdk.shimo.im/v2/docs/concepts/)。该方案用于将协同文档能力嵌入接入方产品，App ID 和 Secret 由石墨颁发，需联系石墨获取。每个应用的数据隔离；接入方需要提供石墨可访问的回调接口，返回文件信息和当前用户权限。这里的 X-Shimo-Token 是接入方自己的身份令牌，不是 shimo.im 网页用户 Cookie。

[开始接入](https://sdk.shimo.im/v2/docs/roll/)要求签名、承载编辑器的 Web 页面和回调服务，最小协作流程至少实现文件元信息及当前用户信息回调。本地桌面单机数据库并不能直接满足公网回调条件。因此「用户登录自己的石墨网页账号后，直接用此 SDK 操作该账号个人空间」不能从这些文档推出。

[协同编辑 API](https://sdk.shimo.im/v2/docs/apis/edit/)提供 `POST https://shimo-domain/sdk/v2/api/files` 创建接口，并支持轻文档、表格、传统文档及幻灯片；请求需要接入服务商文件 ID、签名和用户 token。文档权限由接入方系统及回调共同决定，不能默认等同于 shimo.im 个人空间的公开分享 URL。官方 SDK 同时提供[文件操作](https://sdk.shimo.im/v2/docs/apis/file/)能力，但本轮没有取得用于消费级个人空间自动发布的官方通用 OAuth/API 协议。

首期采用官方页面辅助发布。后续若获得商务 SDK 的正式接入资格，需要另行设计可访问的服务端、身份桥接、只读访问页与分享策略；这应作为部署级能力，不只是桌面端填一个 token。

## 与现有项目的衔接建议

以下是基于本仓库结构的实现建议，不是平台文档的声明：

- 平台登录放进现有 `website_accounts` 与「账号管理 → 其他账号」，复用工作空间隔离的 Electron Session。平台窗口应使用选定账号的同一 Session 打开，避免外部浏览器绕过账号隔离。
- 账号记录区分「已保存网页登录会话」「已核验外部身份」「API 已授权」；没有可验证 UID 的平台不得构造虚假平台 UID。Cookie 存在也不等于服务端会话仍有效。
- 资源清单是独立业务目录及 IPC 处理器；`src/ui` 只复用选择器、分页、加载/错误/空态及反馈。现有 AI 资源导出包含付费判断，不应在打开清单或分类筛选时复用其运行步骤。
- 生成清单使用本地完整资源读取，不依赖资源库第一页或有上限的 UI 快照。清单保留标题、说明、分类规则、字段配置、资源顺序与排除项；读者看到资源标题、简述、分类、网盘平台、已有分享链接和必要提取码。
- 只导出已有可分享信息，不隐式查询付费接口、不转存、不创建新网盘分享。没有有效分享信息的资源应提示或排除，不能把本机路径和账号凭据写给读者。
- 发布记录保留平台、账号引用、读者 URL、快照摘要、版本、登记时间和维护状态。一份清单可登记多个平台，各自保留发布版本。
- 本地修改清单、分类资源新增/删除、标题或分享信息变化后，将相应平台标为待更新；不能自动声明远端内容已同步。保存 URL 应表述为「登记发布结果」，不能表述成「发布成功」或「已确认所有人可访问」。
- 成功的远端写入与本地刷新失败应分别处理；超时结果未知时保留操作记录，避免重试创建重复文档。自动更新优先使用稳定远端文件 ID，仅维护受盘序管理的区域。

## 验证边界

本轮可用临时数据库和模拟端口验证分类聚合、快照稳定性、变更检测、发布记录维护、跨工作空间隔离、URL 平台白名单及错误恢复；可查看当前源码界面验证桌面布局和主要操作。真实账号的验证码登录、外部分享策略、远端写入和无登录读者访问必须另有相应账号与权限后才能完成平台端验收，不以本地模拟通过替代。
