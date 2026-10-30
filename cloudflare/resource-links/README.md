# 盘序资源固定入口 · Cloudflare Workers + D1

独立于桌面应用部署的 TypeScript 服务，没有第三方运行时依赖。Workers 提供公开领取页及临时跳转，D1 保存入口映射、版本和幂等操作回执；电脑关机不影响已部署入口。

本目录包含独立服务源码、迁移与配置示例，当前部署记录如下。管理令牌与网盘登录凭据是不同的秘密，本服务不接收网盘 Cookie、账号密码或网盘 API 令牌。

## 当前部署（2026-10-30）

已获用户授权，通过 Wrangler **4.156.0** 官方 OAuth 登录并使用系统钥匙串持久保存 CLI 凭据，完成 D1 创建、迁移与 Worker 发布。

| 项目               | 当前记录                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| Cloudflare 账号 ID | `9c4268f679907d278e67496c96cd8d86`                                                                           |
| 服务 origin        | [https://panxu-resource-links.mininuke567.workers.dev](https://panxu-resource-links.mininuke567.workers.dev) |
| 部署版本           | `54d54761-9451-4788-a262-f91696329346`                                                                       |
| D1 名称 / 绑定     | `panxu-resource-links` / `DB`                                                                                |
| D1 ID              | `45509f31-a688-4605-91e2-047cbc909b74`                                                                       |
| 数据库迁移         | `0001_resource_links.sql` 已成功应用                                                                         |

Worker 已配置管理 secret，当前桌面源码开发版已加密保存对应管理令牌并开启后续新资源的自动创建。未为既有资源补建入口，未执行网盘写入；令牌值不写入文档、源码或公开领取页。

线上首页已手动浏览成功；全项目与基于实际配置生成运行时类型后的 Worker TypeScript 检查通过。桌面端已接入 Chromium 隔离内存会话以支持系统代理，鉴权连接检查手动通过，确认令牌和 D1 结构可读；部署用的临时明文令牌文件已清理。未为验收创建真实资源映射，尚未验证实际资源的完整领取与换向流程，未运行自动化测试。

此前 Cloudflare 插件的 CIMD 客户端元信息读取遇到 503，参见[官方同类问题记录](https://github.com/cloudflare/mcp/issues/329)。本轮使用用户授权后的 Wrangler 完成部署。

## 首次部署

以下步骤用于另行部署新实例。当前实例已完成初始化，维护时保留原 D1 与入口数据，不重复创建或清空数据库。

需要 Cloudflare 账号及 Node.js 22 或更高版本；不需要服务器或自有域名。以下命令均在本目录执行，安装只影响本目录的 package 与 lock 文件。

```sh
cd cloudflare/resource-links
npm install
cp wrangler.example.jsonc wrangler.jsonc
npx wrangler login
npx wrangler d1 create panxu-resource-links
```

将创建结果的 `database_id` 填入 `wrangler.jsonc`，保持绑定名为 `DB`。如果同名 Worker 已存在，请在配置中换一个 Worker 名称。保留 `secrets.required: ["ADMIN_TOKEN"]`，这里只声明秘密名称，不包含令牌值。然后生成运行时类型、应用迁移并配置管理令牌：

```sh
npm run types
npm run db:migrate:remote
npx wrangler secret put ADMIN_TOKEN
npm run deploy
```

`ADMIN_TOKEN` 使用密码管理器生成的至少 32 个可见 ASCII 字符，推荐 32 字节随机数的十六进制或 base64url 表示。通过命令的交互提示输入，避免令牌进入 shell 历史、代码或 `vars`。令牌会授权读取和修改该服务内全部入口，请只保存在桌面后端的加密凭据存储，不能发到浏览器或嵌入公开页面。

首次部署会分配 `https://<worker>.<account-subdomain>.workers.dev`。把这个 **HTTPS origin** 和同一管理令牌填入桌面端服务设置；不要填写 `/r/…` 路径。自定义域名可日后添加，但原来的 `workers.dev` 地址不属于你，无法迁移给其他服务商。

Worker 尚不存在时，`wrangler secret put` 会提示创建用于保存 secret 的草稿 Worker，确认后再部署完整服务。不要通过删除 `secrets.required` 绕过秘密检查：当前 Wrangler 会阻止缺少必需秘密的部署。运行时未配置有效 secret 的管理接口也固定返回 503，不会开放无令牌写入。

## 本地开发与源码检查

以下步骤使用 Wrangler 本地模拟环境，不访问真实网盘。请勿把真实凭据放进示例文件。

```sh
cp .dev.vars.example .dev.vars
# 用随机令牌替换 .dev.vars 中的占位值
npm run types
npm run db:migrate:local
npm run dev
```

`npm run types` 使用当前 Wrangler 配置、兼容日期及标志生成 `worker-configuration.d.ts`，包括 `Cloudflare.Env` 与 Worker 运行时 API；`secrets.required` 确保无需读取秘密值也能生成 `ADMIN_TOKEN: string`。不要手写或修改生成文件。绑定、兼容日期或标志修改后应重新生成，可将不含秘密值的生成文件提交版本控制。

独立 tsconfig 仅使用 `ES2022` 标准库并显式加载生成文件，不混入浏览器 DOM 或桌面 Node 类型；源代码直接引用 `Cloudflare.Env`，入口用 `ExportedHandler<Env>` 检查。服务未使用 Node 内置模块，无需 `nodejs_compat`、`@types/node` 或第三方运行时包。仓库根 tsconfig 不包含此目录，两边类型保持隔离。

生成类型后，`npm run check` 仅执行 TypeScript 源码检查。本目录没有自动化测试、自动迁移或自动部署的安装钩子。若复用仓库已有 TypeScript，可在仓库根目录执行：

```sh
./node_modules/.bin/tsc --noEmit -p cloudflare/resource-links/tsconfig.json
```

`.dev.vars`、实际部署配置和 `.wrangler` 均已忽略；示例不包含真实账号或数据库标识。

## API 契约

所有响应均设置 `Cache-Control: private, no-store` 及 CDN 禁缓存头，不开放 CORS。管理请求必须从桌面后端发送，携带 `Authorization: Bearer <ADMIN_TOKEN>`；跨站 `Origin` 被拒绝。错误响应统一为：

```json
{
  "error": {
    "code": "REVISION_CONFLICT",
    "message": "远端入口版本已变化或不存在，请先读取最新记录后再保存。"
  }
}
```

| 方法、路径            | 鉴权   | 行为                                                                              |
| --------------------- | ------ | --------------------------------------------------------------------------------- |
| `GET /api/health`     | 无     | 仅返回 `{"service":"panxu-resource-links","version":1}`，不检查数据库、不泄露配置 |
| `GET /api/connection` | Bearer | 核验令牌、D1 绑定、两张表字段及回执触发器，成功返回相同服务标识；只读，不创建记录 |
| `GET /api/links/{id}` | Bearer | 返回当前 `RemoteLink`；不存在时 HTTP 404，JSON 内容为 `null`                      |
| `PUT /api/links/{id}` | Bearer | 条件创建/修改，成功 HTTP 200 并返回此次操作回执                                   |
| `GET /r/{slug}`       | 无     | 白色领取页；显示名称、网盘、当前分享链接与提取码，提供复制和打开按钮              |
| `GET /go/{slug}`      | 无     | 重新读取当前目标并用 302 临时跳转；不会请求目标服务器                             |

连接检查只验证数据库可读和迁移结构，不扫描资源内容，也不通过试写验证权限。绑定缺失、迁移未执行、字段不完整、回执触发器缺失或数据库无法读取时返回 `503 DATABASE_NOT_READY`，不会显示为正常连接。公开 `/api/health` 始终只提供服务标识，不能替代鉴权后的连接检查。

写入请求必须是 `application/json`，最大 16KB，不接受额外字段。`id` 为 8–128 位字母、数字、下划线或连字符；建议每个本地资源使用独立随机 UUID 作为管理 ID。`slug` 为独立的 8–32 位安全字符，建议采用至少 16 位随机字符串，避免使用资源 ID。短码是公开访问标识，知道地址即可访问，并不提供文件权限保护。

```json
{
  "operationId": "0de1f7c5-292d-4ebe-bbb8-a37956e5823a",
  "expectedRevision": 0,
  "slug": "example_7Ks9mQ2d",
  "title": "资源名称",
  "provider": "quark",
  "targetUrl": null,
  "code": "",
  "enabled": true
}
```

以上仅为数据结构示例，不会自动创建入口。`targetUrl: null` 可创建或更新为“分享链接正在更新”的领取页。资源名称为 1–200 个字符；提取码为 0–128 个字符；不接受控制字符；`enabled` 为布尔值。`provider` 支持 `quark / baidu / uc / xunlei / guangya / pikpak`。

成功返回：

```ts
interface RemoteLink {
  id: string;
  slug: string;
  url: string; // 当前服务 origin + '/r/' + slug
  title: string;
  provider: "quark" | "baidu" | "uc" | "xunlei" | "guangya" | "pikpak";
  targetUrl: string | null;
  code: string;
  enabled: boolean;
  revision: number;
  lastOperationId: string;
  updatedAt: string; // UTC ISO 时间
}
```

### 版本冲突与重试

- 首次创建的 `expectedRevision` 为 0，成功后 `revision` 为 1。更新必须使用上次读取的当前 revision，成功加 1。
- `slug` 创建后不可修改，`id` 和 `slug` 均唯一。更换目标、名称、提取码或启停状态都需要新操作编号和正确的 revision。
- `operationId` 是 UUID，在本服务内全局唯一。相同编号与相同字段值（不考虑 JSON 属性顺序）会返回该次**原始成功回执**，即便入口后来已有更新。回执不是当前状态快照；客户端需要最新状态时另做 GET。
- 同编号但任何提交字段不同返回 `409 OPERATION_CONFLICT`。revision 不匹配返回 `409 REVISION_CONFLICT`；已占用短码返回 `409 SLUG_CONFLICT`；尝试修改短码返回 `409 SLUG_IMMUTABLE`，都不会覆盖记录。
- 保存使用一条条件 UPSERT 完成 CAS，`AFTER INSERT/UPDATE` 触发器在同一数据库语句事务内写入原始回执。唯一约束和条件在 D1 内执行；不依赖“先读版本、再无条件写”的竞争窗口。
- 保存超时、返回 503 或响应丢失时，不能断言写入失败。**保留原 operationId 和完整请求内容，原样重试**。服务会从持久回执恢复结果；不要生成新编号重复创建。未能核对结果时返回 `503 OPERATION_UNCONFIRMED`。
- 桌面端在持久保存意图前校验完整请求，并只规范化公开展示名称：折叠控制字符和多余空白、最多 200 个 UTF-16 单元且不截断 Unicode 字符，资源原名称不改。首次发送收到兼容 Worker 明确的前置 4xx 拒绝后，才释放未提交的本地意图；已有未知结果的重试、409、5xx 和超时均保留原请求。
- 使用直接 D1 binding，未启用 Sessions API 读副本；按官方文档，查询走主库。服务不启用边缘缓存，修改目标后不会故意保留旧 302。

### 允许的网盘目标

只接受完整的单个 HTTPS 官方分享地址，与 `provider` 一致；精确主机允许表与桌面端六网盘对应：

| 网盘   | 允许主机                                 |
| ------ | ---------------------------------------- |
| 夸克   | `pan.quark.cn`                           |
| 百度   | `pan.baidu.com`、`yun.baidu.com`         |
| UC     | `drive.uc.cn`、`pan.uc.cn`、`fast.uc.cn` |
| 迅雷   | `pan.xunlei.com`                         |
| 光鸭   | `guangyapan.com`、`www.guangyapan.com`   |
| PikPak | `mypikpak.com`                           |

路径为 `/s/{安全分享ID}`；另允许百度 `/share/init?surl={安全分享ID}`。不允许任意其他域名、子域名、登录凭据、自定义端口、URL 片段、跳回本服务或反斜线。查询参数只允许提取码 `pwd`（光鸭另支持 `code`）及百度初始化路径的 `surl`，拒绝未知或重复参数。URL 若已包含提取码，必须与 `code` 字段一致。

`/go` 把独立的 `code` 合入目的地址（光鸭使用 `code`，其他平台使用 `pwd`）。网盘是否接受自动填码仍由各平台决定，领取页会始终显示可复制的提取码。服务不会核验资源归属、文件存在或分享有效期，客户端须先完成本人分享核验；URL 允许表只能约束目标平台。

### 公开状态与隐私

- 根地址 `/` 返回 200 和简洁的领取说明，提示打开分享者提供的完整链接；不列出资源、不读取数据库，也不声称服务已完成配置。未知路径返回友好的 404 页面，不显示内部错误。
- 未绑定分享链接：领取页/跳转入口返回 200 待更新说明，不自动重试、不显示伪造链接。
- 桌面备份会移除秘密。创建新入口时，原分享提取码缺失会先使用 `targetUrl: null`，不以空码猜测目标可公开领取；明确不支持提取码的平台（当前 PikPak）除外。其他情况通过显式联网核验或手动填写本人链接与提取码恢复绑定，既有目标不自动覆盖。
- 停用：返回 410；不存在：返回 404；数据库读取失败：返回 503，可稍后刷新。
- 公开页面不输出管理 ID、操作编号、版本或管理令牌；只输出领取所需的内容。
- HTML 对动态文本与属性严格转义，脚本不拼接业务数据，CSP 使用随机 nonce；无外部字体、图片、脚本、分析或追踪请求。
- D1 保存公开分享地址、提取码及历史操作回执。它们是对领取者公开的信息，并非网盘账号秘密；有数据库访问权的人能够读取这些记录。暂不提供删除接口，不应人工删除回执破坏重试语义。
- 默认 `workers.dev` 仅适合个人/非关键用途；Cloudflare 官方不保证它在中国大陆稳定可达。上线前应使用实际接收者网络验收，不能把免费全球 Workers 当作中国境内部署。

## 维护

更换管理令牌执行 `npx wrangler secret put ADMIN_TOKEN`，同步更新桌面端配置；不把旧令牌写回本地明文文件。迁移应通过新增编号 SQL 文件维护，避免修改已部署的历史迁移。D1 可使用 Cloudflare Time Travel 或导出备份；恢复时应将入口表与操作回执一起恢复。

免费额度按 2026-10-30 查阅的官方文档：Workers 每天 10 万次请求、单次 10ms CPU；D1 每天 500 万行读取、10 万行写入，总存储 5GB，单数据库 500MB。一次入口写入还会记录回执，不能简单按一次 API 调用等同一行写入；索引维护也可能计费。额度与定价应以上线时官方页面为准。

官方依据（2026-10-30 查阅）：

- [D1 prepared statements / bind、run、first](https://developers.cloudflare.com/d1/worker-api/prepared-statements/)
- [根据 Wrangler 配置生成 TypeScript 类型](https://developers.cloudflare.com/workers/languages/typescript/)
- [D1 数据库绑定 API](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [D1 SQL 与 SQLite 兼容](https://developers.cloudflare.com/d1/sql-api/sql-statements/)
- [SQLite UPSERT](https://www.sqlite.org/lang_upsert.html)、[触发器](https://www.sqlite.org/lang_createtrigger.html)
- [D1 主库与读副本一致性](https://developers.cloudflare.com/d1/best-practices/read-replication/)
- [D1 迁移](https://developers.cloudflare.com/d1/reference/migrations/)
- [Wrangler 配置](https://developers.cloudflare.com/workers/wrangler/configuration/)、[Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [workers.dev 用途与公开访问](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)
- [Workers 定价](https://developers.cloudflare.com/workers/platform/pricing/)、[D1 定价](https://developers.cloudflare.com/d1/platform/pricing/)、[D1 限制](https://developers.cloudflare.com/d1/platform/limits/)
- [中国大陆与全球网络路由](https://developers.cloudflare.com/support/troubleshooting/general-troubleshooting/geographic-traffic-routing/)
