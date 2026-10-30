# 平台网站图标

2026-10-30 从已接入平台的官方公开网站获取，共27个平台，约166 KiB。品牌与商标归各权利人所有，仅用于识别对应服务。实际首页、图片来源地址、文件名与获取日期见同目录的 `sources.json`。

所有图标随前端打包；查看账号、切换筛选或打开平台列表时不请求外部图片服务，也不发送本机账号、UID或登录凭据。

新增平台时，在 `scripts/platform-icon-sites.json` 登记官方首页，然后运行：

```sh
node scripts/sync-platform-icons.mjs 平台ID
```

省略平台ID可更新全部。脚本读取官网声明的 `icon`、`apple-touch-icon`，并回退到根目录 `favicon.ico`；官网未声明图标时可在登记中指定已核实的官方 `icon` 地址。图片请求携带公开官网来源，支持CDN正常的来源校验，不使用第三方图标代理。

下载限制HTTPS、超时及单文件1 MiB，检查实际PNG、ICO、JPEG或WebP文件头，拒绝把HTML错误页保存为图标。获取失败保留已有文件；没有可用文件时，`PlatformIcon` 显示通用网站图标。
