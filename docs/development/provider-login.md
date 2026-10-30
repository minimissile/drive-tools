# 网盘登录导航中断误报

日期：2026-10-30。针对用户提供的百度网盘登录截图处理，未制作安装包。

## 原因

截图中官方百度页面已经显示，但工作台弹出 `ERR_ABORTED (-3)`，错误地址为百度自己的 `/login?redirecturl=...`。

`desktop/main.ts` 的 `openAccountWindow` 直接等待 `BrowserWindow.loadURL`。官网脚本跳转、用新的导航替换旧导航或用户关闭窗口，会取消旧的加载请求；原有实现把这一取消异常作为 `account.login` 失败传回工作台。弹窗在同一隔离窗口打开时，也直接调用了未作区分的 `loadURL`。

同项目的其他网站登录入口已使用 `isAbortedNavigation` 区分这一情况，网盘入口遗漏了该处理。这可以解释截图中的报错；单凭截图不能确认后续完整登录及 UID 核验是否成功。

Electron 的 [`loadURL` 文档](https://www.electronjs.org/docs/latest/api/web-contents#contentsloadurlurl-options)说明加载失败会使 Promise 拒绝；[导航取消事件文档](https://www.electronjs.org/docs/latest/api/web-contents#event-did-fail-provisional-load)区分了被取消的加载。

## 修改

- 新增 `desktop/provider-navigation.ts`，复用已有的取消错误识别方法与网盘官方地址规则。
- 首次打开、复用窗口打开指定页面、接管官方弹窗统一经过这一方法。取消旧导航不再显示为登录失败。
- 非取消错误继续失败，并提供网盘名称及可用的网络错误代码；不把含查询参数的完整登录地址作为用户报错显示。弹窗异步加载的真实错误也会提示。
- 打开窗口不表示账号已登录。保留原有 `account.check` 身份与 UID 核验、账号隔离和官方域名限制。

## 检查范围

TypeScript 静态检查与差异检查通过。复用当前运行在 8070 端口的源码开发服务，没有另开桌面实例，没有运行自动化测试，也没有清除登录会话或修改凭据。

电脑操作工具因当前页面的访问限制终止了会话，本轮无法手动复现百度登录和完成登录后的 UID 核验。修复后的实际官方登录流程仍需手动复核。
