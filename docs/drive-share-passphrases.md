# 百度与夸克官方分享口令接口研究

研究日期：2026-11-25。目标是创建分享时自动获取官方中文口令，保存在本地并可单独复制。口令不是四位提取码，也不能从分享 URL 自行拼成。

## 百度：已验证并接入

主要证据为百度官网当前 Android 安装包 13.37.9（versionCode 4274），以及已有账号的实际接口响应。官网版本来源是 `/disk/cmsdata?do=client`；[官方安装包](https://downpack.baidu.com/Baidunetdisk_AndroidPhone_1026962m.apk)的本次 SHA-256 为 `677f1192fbba377caa930de18b4047c9064e2a69e37ae0066652319d9b829af4`。早期 wap 下载地址仍返回旧 12.23.2，不能用旧版本否定当前中文口令能力。

当前客户端 `FileShareController.getCommandType()` 在中文口令分享分支返回 1；`ShareApi.share()` 请求 `/share/pset` 并提交 `command_type=1`，`ShareParser` 从同一建链结果读取 `command_word`。`ChineseTokenPullAmisConfigKt.getEnTokenPairs()` 的默认标记对包含 `@@_#`，客户端将服务端原词包在这对标记之间。本地选择该固定默认标记对，保留服务端实际汉字，不自行生成汉字。

验证结果：

- 已有浏览器账号 POST `/commandWord/allowAccess`，`command_type=1`，返回 `errno=0`、`data.is_allow=true`。
- 原生 `/share/pset` 需要真实文件路径列表；已针对原本已分享的文件验证成功，响应同时提供分享 ID、链接、到期时间和中文 `command_word`。
- 现有网页版 `/share/set` 使用原 `fid_list`、提取码和有效期，增加 `share_type=9`、`command_type=1` 后，同样真实返回中文 `command_word`。最终实现采用这一方式，保持同一次建链且不增加目录读取。
- 两次真实验证链接都设置一天有效。响应与操作凭据留在本机临时研究目录，仓库不存放用户会话、实际文件名及链接明文。

`OwnShare.passphrase` 只携带平台实际返回的口令。独立建链的首份回执先保存分享 ID、链接和提取码，再加密保存口令；若加密失败，保留已返回结果，不自动再创建分享。缺失或不符合中文口令字段形态时保留普通链接，口令保持未获取。

未完成：手机百度 App 的实际剪贴板唤起识别验收、其他账号的口令权限差异，以及历史分享的只读口令补取。自动获取目前针对新建分享，不能推断已有历史链接的原中文口令。

## 夸克：macOS 官方桌面 SDK 桥接已验证并接入

主要证据为[官网 Android 下载渠道](https://download.quark.cn/download/quark?ch=kk@store_guanwang_ot)的 10.21.6.1191（versionCode 1191）安装包，以及本机官方 Quark 7.5.0.1049 客户端。Android 安装包 SHA-256：`eee7f82c9117121d91e48ea12c318cc231d091825937e2e2054135389b679c1c`。

现有账号的 `share/password` 请求增加 `distribute_share_plan=1`、`utoken_version=v2` 和 `fetch_file_category_num=0` 后，真实返回 `command_type`、`plan_id`、`default_plan_id`、有效期及分享文案模板。已观察到 `command_type=1` 与 `plan_id=auto3_c_code`。这些是生成方案，不是已经生成的中文口令。某次桌面参数响应模板使用 UC 文案，后续实现还需确认产品与渠道参数，不能直接采用该文案。

当前移动端调用关系：

1. `CloudShareTaskManager` 根据 `command_type` 选择生成分支，使用方案 ID 作为 `shareCode`，不把分享短码当成方案 ID。
2. 中文分支携带 `reflowExtInfo` 中的 `semantics=1`；`CloudJSApi.getShareUserToken()` 调用 `biz.shareUToken`。
3. 原生 handler 构建 `app=QUARK`、`businessCode=quark_cloud_disk`、`shareCode`、分享 URL、展示标题、到期时间等字段；按字段名排序后拼接字段值并追加时间戳。
4. Android 原生 SDK 通过 `signWithNumber` 计算签名，生产密钥槽编号为 12001。编号不是可直接替代签名的密钥。
5. JSON POST `https://utoken2.quark.cn/utoken/v2/create`；普通短串与中文口令可能分别生成后组合。解析走 `/utoken/v2/parse`，同样需要签名。

本机桌面客户端也有 `/utoken/v2/create` 调用，通过 `quantum.wsg.sign()` 签名，生产槽编号为 14100，默认主机为 `utoken2.uc.cn`。它的普通分享方案不能直接当作中文方案。桌面和 Android 对扩展字段加入签名的时机不同，必须以实际调用路径核对，不能把两个版本的参数随意合并。

桌面验证结果：`--quantum-node-inspect-ports` 使用 `quark-agent=端口,quark-cloud-drive=端口` 的映射形式。通过仅绑定回环地址的官方 Node 调试端口，能够调用真实 `quantum.wsg.sign({number:14100,value_to_sign})`。使用已授权的现有公开分享，JSON POST `https://utoken2.uc.cn/utoken/v2/create`，`shareCode=auto3_c_code`，服务真实返回 12 字中文口令；随后使用同一 SDK 签名调用官方 `/parse`，返回 `FULL_CHINESE_NO_SENSE_WITH_USERINFO`，Android 和 iOS URL 均指向原分享。此验证未创建新的网盘分享。

生产实现采用已验证的桌面字段，不混入 Android 的 `reflowExtInfo`。URL 保留原提取码，增加 `way=u_token`。服务返回的口令必须为中文，并经官方回解析校验分享 URL 和提取码，全部一致才允许保存。生成方案来自本人分享的 `share/password`；仅接受已验证的中文 `command_type=1`，不能硬编码方案替代权限检查。UToken 网络走独立非持久 Electron session 和系统代理，不携带账号 Cookie；私有分享方案查询仍使用该资源所属的已登录账号。

`desktop/quark-share-signer.ts` 仅在需要生成口令时启动官方桌面组件，使用匿名临时配置、无界面模式，复用到盘序后端退出。不会加载或清理用户的夸克浏览器配置。调试端口开放早于 SDK 就绪，因此先等待官方 `quantum.wsg.sign` 初始化，再调用原生 API；异步签名任务保留在官方 VM 中，调试协议只轮询普通结果数据，不使用容易报 `Promise was collected` 的 `awaitPromise`，也不动态导入原生模块。本实例串行调用签名并在关闭时清理自己的进程组和临时目录，不接入第三方转换服务，也不启动 Android 或模拟器。首次启动等待最多 30 秒；若官方组件失效，关闭本实例的匿名运行时，用户再次点击获取时重新初始化，不自动重放远端操作。

同一份代码已经真实验证冷启动、复用后的连续两次中文口令生成及官方回解析。无界面协议联调不等于手机 App 实测；手机剪贴板识别仍待验收。当前需要本机安装支持该 SDK 的官方 macOS 夸克客户端，Windows 尚不支持。客户端升级可能改变非公开 SDK；失败时保留已创建的分享链接并显示原因，用户可对现有分享点击“重试获取”，不会重复建链。

## 本地行为与测试边界

口令密文键按资源副本、独立建链操作、拆分项分别隔离。公开资源、操作凭据和任务日志不存口令明文；复制不会触发远端校验或建链。普通分享链接与提取码仍按原复制约定处理。

自动化覆盖同一次建链回执带口令、服务缺失或异常口令字段、加密存储、错误归属拒绝、独立分享隔离、资源归档、拆分后入库、重复提交不重复建链、存储失败保留建链凭据，以及复制离线可用。夸克新增签名排序、提取码与链接回解析、口令失败保留链接、现有分享补取及异步分享变化的测试。UI 测试通过任务专属 Electron 窗口和独立业务夹具，验证补取、重试和单独复制，避免改动用户主窗口与业务数据；这些测试不证明官方手机 App 已识别口令。

真实桌面协议复验使用 `scripts/qa-quark-passphrase-live.mjs`，需要显式设置 `PANXU_QUARK_COMMAND_SHARE` 为已授权的现有夸克分享。该脚本只注册中文口令并验证回解析，打印字符数、耗时及会话复用信息，不打印签名、Cookie 或口令正文。
