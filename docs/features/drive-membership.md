# 网盘会员信息

账号列表将会员信息放在独立一列，展示当前会员类型、到期时间和更新时间。操作按钮统一保留在账号操作列。核验登录或点击“刷新容量和会员信息”时，同时读取容量与会员信息。

支持百度、夸克、UC、迅雷、光鸭和 PikPak，使用账号原有的内置或指纹环境与认证传输。所有查询均为只读；不修改订阅，不续费，不读取或修改网盘文件。

## 状态

- 有效会员显示平台会员类型及实际到期时间。
- 明确的普通用户显示“非VIP会员”。
- 已到期会员保留到期日期，显示“会员已到期”。
- 平台缺少状态或日期时分别显示“会员状态未知”或“平台未提供”，不根据容量、取消续费或缺失字段推断非会员/永久会员。
- 尚未执行采集的历史账号显示“会员信息尚未读取”；账号会话或首次查询失败显示“会员信息读取受阻”，保留尝试时间和原因。只有平台实际返回了无法确认的状态，才显示“平台未提供会员状态”。
- 读取失败时保留上次结果及更新时间，标明“上次记录”与失败原因。会员接口失败不抹掉容量，不阻止已完成的身份核验。

缓存按账号 UID 校验，身份不匹配的缓存不展示；删除账号时同步清理。到期判断使用平台实际时间，支持秒、毫秒及有时区的日期时间，国内日期字段按中国时区显示。

百度会员旧版解析缓存不再展示，需刷新后重新保存。接口中的 `2147483647`、`2147483648`、`4294967295` 等边界占位时间不能作为实际到期日期；已确认会员但缺少真实日期时保留会员类型，显示平台未提供到期时间。2026 年 11 月 24 日已用本人比特 #1 会话验证：`vip0`、`is_vip=0`、`is_svip=0` 应显示非 VIP，不显示 2038 年到期时间。

## 平台字段

| 网盘 | 只读接口 | 会员依据与到期字段 |
| --- | --- | --- |
| 百度 | `/rest/2.0/membership/user?method=query` 与 `/api/gettemplatevariable` 的会员标志 | 优先使用 `is_vip` / `is_svip` 确认类型，以相应付费会员产品的真实有效期展示到期时间；忽略 `vip0` 基础权益与扩容包 |
| 夸克、UC | `/1/clouddrive/member` | 当前 `member_type` 及 `super_vip_exp_at` / `exp_at` 等平台返回字段，取消续费不等于立即失效 |
| 迅雷 | 官方 `/v1/user/me` | `vip_info` 的网盘/下载会员，`is_vip` 及实际 `expire_date` 等到期字段 |
| 光鸭 | `/assets/v1/get_assets` | 官网使用的 `vipStatus` / `svipStatus`（2 有效，3 到期）及 `vipExpireTime` |
| PikPak | `/drive/v1/privilege/vip` | `data.status` / `data.type` / `data.expire`，同时核对返回的 `user_id` |

协议核对依据包括 [光鸭官网公开脚本](https://www.guangyapan.com/static/js/index.409585b579.js)、[迅雷官网会员资料模块](https://static-pan.xunlei.com/_nuxt/dist/client/service-sso.085014623c6b2f64f527.js) 与 [rclone PikPak 适配器原始类型](https://github.com/rclone/rclone/blob/master/backend/pikpak/api/types.go)。夸克已在本人 #10 环境只读核验会员类型和到期时间，其余真实账号依登录状态读取，不将模拟测试视为真实账号验证。

## 验收

```sh
node --import tsx --test tests/membership.test.ts tests/capacity.test.ts tests/providers.test.ts tests/new-drives.test.ts tests/quark-browser.test.ts tests/drive-request-scope.test.ts
npm run test:session -- --module scripts/qa-drive-membership.mjs --label 网盘会员状态界面验收 --session drive-membership --page accounts --close
```

界面测试模拟六家账号的有效、非会员、过期、未知、缺失日期与读取失败状态，在 1366×768 源码专属窗口检查列对齐、长账号名称、刷新反馈和操作列。后端编译后按项目规定等待用户手动应用更新。
