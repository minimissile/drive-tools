# 桌面版本升级与无服务器发布

盘序使用 `electron-updater`，更新包托管在**公开 GitHub Releases 仓库**。可以只公开一个存放二进制包的发行仓库，源码继续保留在私有仓库。客户端匿名读取正式版本，不存储 GitHub Token，不需要自建 API、数据库或下载服务器。

当前已配置发行仓库为 [minimissile/drive-tools](https://github.com/minimissile/drive-tools/releases)，已确认是公开仓库。当仓库尚无已发布版本时，客户端会显示尚未发布，而不会假报已是最新版。

[GitHub 官方说明](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)规定单个附件须小于 2 GiB，发布总大小和带宽没有总配额限制。国内访问 GitHub 的可用性取决于用户网络；连接失败时原版本仍可正常使用。未来如需要国内 CDN，可迁移到对象存储的静态 HTTPS 分发，迁移前应向现有客户端发布支持新地址的过渡版本。

## 用户操作与安全边界

“连接与设置 → 版本与更新”提供当前版本和架构、说明、检查、下载、进度、取消、重试及重启安装。其他页面显示新版本或下载状态提示。

- 默认启动 15 秒后检查，此后每 6 小时检查；上次检查时间持久保存，频繁重启不会重复请求。关闭自动检查后仍可手动检查。
- 检查不会下载，下载完成不会退出，普通退出不会安装。“跳过此版本提醒”仅隐藏该版本的全局提醒，设置页仍可查看和下载。
- 只接受递增的稳定 `x.y.z` 版本，拒绝降级、预发布及构建后缀。开发模式不联网；未签名打包版本可以检查和打开固定发布页，但不能在应用内下载安装。
- 下载由官方更新器校验 SHA512，安装使用系统签名验证。校验失败后必须重新检查，不能直接安装该包；支持取消、缓存复用和后续重试。
- 安装前必须完成或停止排队/运行任务，并保存编辑内容。确认后暂停队列，等待笔记导出，保存一致性数据库快照，再启动安装器；期间禁止新业务操作。失败则恢复工作台。
- [macOS 必须签名并提供 ZIP 更新包](https://www.electron.build/v26/docs/features/auto-update/)，只有 DMG 无法自动更新。Windows 使用完整 NSIS 安装器，关闭 web installer，并核验发布者签名。

## 首次办理签名

没有签名证书时可以继续开发和构建联调包，但不能执行本项目的签名、公证正式发布。安装包仍托管在 GitHub Releases；办理签名不需要自建服务器。

### macOS

1. 先确定以个人还是组织名义发行，再通过 [Apple Developer Program 官方入口](https://developer.apple.com/programs/enroll/)办理标准会员。官方年费为 99 美元，按地区显示当地价格；无需 Enterprise Program，也无需将应用上架 Mac App Store。身份核验、协议确认和付款由申请主体本人完成。
2. 会员生效后，由 Account Holder 在开发者账户或 Xcode 创建 **Developer ID Application** 证书。它用于 Mac App Store 之外的应用发行；`Apple Development`、自签名证书及 `Developer ID Installer` 都不能替代本项目的应用发行证书。参见 [Apple 的证书创建说明](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)。
3. 在生成私钥的 Mac 上，将证书及其私钥导出为有密码保护的 `.p12`。仅下载 `.cer` 文件不包含私钥，无法供 CI 签名。将 `.p12` 的 base64 内容和导出密码分别写入下表中的 Mac Secrets。
4. 通过 [Apple 账户](https://account.apple.com/)创建用于公证的应用专用密码，准备 Apple ID 和 Team ID，分别写入下表对应 Secrets。不得将 Apple 账户登录密码当作公证密码。
5. 凭据齐备后，CI 才能签名、提交 Apple 公证并装订公证票据；发布校验会检查签名及票据，成功后才上传发行草稿。

### Windows

先确定申请主体（个人或组织）、真实所在国家或地区，以及服务是否支持 GitHub Actions 中的非交互签名，再选择证书。不要以“必须拿到可导出的 PFX”为购买条件。

- 新签发的公开信任代码签名证书要求私钥受合规硬件或 HSM 保护，可选择硬件令牌或符合要求的云签名服务。参见 [DigiCert 对私钥保护要求的说明](https://knowledge.digicert.com/general-information/new-private-key-storage-requirement-for-standard-code-signing-certificates-november-2022)。硬件令牌不能直接连接 GitHub 托管 runner，需要自己的签名机器或服务。
- Microsoft Artifact Signing 的 Public Trust 有主体和地区限制。截至 2026-10-16，个人仅支持美国和加拿大；组织支持的地区也有限，不能假定中国大陆主体可申请。Private Trust 或测试证书不能替代面向公众的签名。办理前查看 [Microsoft 官方申请条件](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)。
- 当前仓库的 Windows 正式工作流仅接入 `WIN_CSC_LINK` 证书文件模式，尚未接入云签名或硬件签名器。若新办证书采用这些方式，必须先按提供方文档完成签名器接入和实际验证；不能只填入 `.cer`、关闭签名检查或将联调包当作正式包上传。

Apple 会员和 Windows 证书是两项独立资质。申请审核通过后仍需配置凭据及完成安装、升级验收，不能把申请成功当作发布完成。证书私钥、导出密码、公证密码和云签名密钥应通过本机安全存储或 GitHub Secrets 配置，不发送到聊天，不提交到仓库。

## 首次配置

建立并初始化一个长期保留的**公开**发行仓库，例如 `your-account/panxu-releases`。不要删除、改名或转移更新仓库；客户端会持续使用构建时固化的地址。在项目根目录设置：

```json
{ "repository": "your-account/panxu-releases" }
```

文件名为 `update.config.json`。构建环境变量 `PANXU_UPDATE_REPOSITORY` 可覆盖该值。只接受 `owner/repo`，不接受 URL 或凭据；界面不能任意更换更新源。未配置时显示明确状态。

在**源码仓库**的 Actions Variables 配置：

| 变量 | 内容 |
| --- | --- |
| `PANXU_UPDATE_REPOSITORY` | 公开发行仓库 `owner/repo`；留空使用配置文件 |
| `PANXU_WINDOWS_PUBLISHER` | Windows 证书主体名称（CN），与历史版本保持一致 |

在源码仓库的 Actions Secrets 配置：

| Secret | 用途 |
| --- | --- |
| `MAC_CSC_LINK` | Developer ID Application 的 base64 `.p12` 证书 |
| `MAC_CSC_KEY_PASSWORD` | 证书密码 |
| `APPLE_ID` | Apple 公证账号 |
| `APPLE_APP_SPECIFIC_PASSWORD` | Apple 应用专用密码 |
| `APPLE_TEAM_ID` | Apple 开发者团队 ID |
| `WIN_CSC_LINK` | 可供 CI 导入的 Windows 代码签名证书（base64 `.p12/.pfx`） |
| `WIN_CSC_KEY_PASSWORD` | 证书密码 |
| `RELEASE_TOKEN` | 仅授予发行仓库 Contents 读写权限的 fine-grained Token |

同仓库分发可用 Actions 默认 Token；跨仓库必须配置 `RELEASE_TOKEN`。令牌只用于最后的草稿上传任务，不进入客户端或打包配置。若 Windows 证书只能通过硬件/云签名使用，需要按证书提供方接入签名器，当前流程使用可导入证书。

正式流程设置 `PANXU_REQUIRE_SIGNING=1`，缺失仓库、签名、公证凭据或版本说明时直接失败，不会自动降级为无签名更新。

## 发布流程

0.0.1 的历史例外：用户明确要求不等待 Apple 公证，该版本发布时使用同一 Developer ID 签名的 DMG/ZIP，并在说明中标注未公证、首次打开可能出现系统安全提示。`verify-release.mjs --allow-unnotarized` 仅跳过公证票据及 Gatekeeper 验收，仍强制验证签名和包内容；更新签名与哈希检查不变。默认发布入口及 CI 继续要求公证，0.0.2 已完成公证，不沿用该例外。

1. 本机单平台发行可直接运行下述 `release:full` 或 `release:differential`，自动升版、构建、推送并正式发布。手动固定版本或多平台流程才需要先统一版本与说明；只使用稳定 `x.y.z`。
2. 完成检查并提交，推送与源码一致的 `v<version>` 标签。需要云端构建时手动触发 `.github/workflows/release-desktop.yml` 并选择对应标签，选择分支会被阻止；推送标签不会自动上传私钥或触发未配置凭据的构建。
3. `release.config.json` 声明本次发行的平台，CI 据此生成矩阵。当前发行计划仅发布 macOS Apple Silicon ARM64 签名公证 DMG 与 ZIP，不发布 Intel Mac 包；Windows x64 在签名齐备后加入后续版本。0.0.1 的未公证交付属于上述历史例外。
4. 全部已启用平台成功后，核对版本、架构、文件大小、SHA512、ZIP、blockmap，再生成统一的 `SHA256SUMS.txt`。最终检查拒绝缺少已启用平台，也拒绝混入未启用平台的清单或安装包。
5. 上传到公开仓库的**草稿 Release**，确认所有附件均存在。已公开的同版本不会覆盖；失败后可重跑同一草稿。
6. 维护者下载验收后，在 GitHub 正式发布草稿并设为最新版本，客户端才会看到更新。不要设为 prerelease。

当前 macOS ARM64 发行必须保留的附件：

```text
Panxu-Studio-<version>-mac-arm64.dmg / .zip
对应的 *.blockmap
latest-mac.yml
SHA256SUMS.txt
```

输出按版本隔离在 `release/<version>/`，不会混入旧文件。最终草稿只由一个任务上传。Actions 临时 artifact（保留 14 天）用于构建与验收，不能充当客户端更新地址。[发布配置约定](https://www.electron.build/v26/docs/publish/)说明了包与清单的关系。

## 0.0.5 一键发布记录

2026-10-31 已通过 `release:differential` 正式发布 [0.0.5](https://github.com/minimissile/drive-tools/releases/tag/v0.0.5)，设为最新稳定版本。复用已有签名公证产物，自动提交及推送源码和 `v0.0.5` 标签，核对六个远端附件的集合、大小和 SHA256 后公开；续跑期间目标版本保持 0.0.5。构建对应提交为 `4908f8d30d3d15ed30d5f69e18da23c8ccb3f22b`。

本轮实际完成包内 31 个生产包及 39 项必需依赖入口、签名、公证票据、Gatekeeper、更新清单及远端摘要核验；未运行功能自动化测试或本机安装重启验收。草稿查询按发行 ID 读取，重试复用摘要一致的远端附件。

## 本地发布脚本

日常发行只需点击两个命令之一，无须另行修改版本、提交代码、创建标签或运行上传命令：

```sh
# 全量发行：自动递增次版本，例如 0.0.4 → 0.1.0
npm run release:full
# 差分更新：自动递增补丁版本，例如 0.0.4 → 0.0.5
npm run release:differential
```

命令依次完成版本同步、缺失说明生成、当前工作区源码提交、签名公证与打包、产物校验、当前分支及版本标签推送、GitHub 附件上传与远端 SHA256 核验，最后正式公开为最新稳定版本。正式发布成功后，客户端即可检查到更新；不会自动运行功能测试。

自动提交包含当前工作区全部未忽略改动。版本标签固定对应构建时的源码提交；构建期间源码变化会停止发布，重新点击同一命令会对同一目标版本重新构建。不会重置工作区、强制推送分支或覆盖已有版本标签；已公开版本只允许核对相同附件后完成续跑，不会替换附件。

### 首次配置与平台范围

本机须准备已登录且有仓库写入权限的 GitHub CLI、Git 提交身份以及对应平台的签名公证凭据。仓库取自 `update.config.json`，`origin` 必须指向同一仓库。若没有显式设置 `GH_TOKEN` / `GITHUB_TOKEN`，优先使用 gh 中已保存的仓库所有者凭据，不切换全局活动账号；已有代理环境变量或 Git 的 `http.proxy` 会继续使用。

默认按本机系统选择平台、按发行配置选择架构，可显式指定 `--platform mac --arch arm64`。自动入口要求 `release.config.json` 只启用一个平台；多平台可使用下述固定版本流程。差分准备目前支持 macOS ARM64，实际签名须在对应系统执行。

### 失败续跑与历史任务接续

命令通过运行锁避免同一工作区并发发行，并在忽略目录 `release-evidence/auto-release.json` 记录目标版本、构建提交、产物目录及发布进度。签名、网络、推送或上传失败后，重新点击同一命令会继续同一版本，不再次升版。只有正式发布成功后的下一次运行才继续递增版本，即使源码没有变化也会生成下一版本。

旧版命令已经打包完成但尚未发布的任务会先续发当前目标，不跳到新版本。仅文档、发布工具或版本脚本变化时可核验并复用旧产物；应用源码、依赖或构建输入改变时重建同一版本。若远端标签已经推送，则继续与该标签绑定的构建和附件，后续源码改动保留到下一版。

### 差分基线与交付内容

差分基线自动使用升版前版本，依次查找当前工作树 `release/<旧版本>/`、`release-evidence/baselines/<旧版本>/` 及 Git 主检出目录中的发行包；续跑优先复用记录目录。缺失时通过 gh 从官方 GitHub Release 下载同版本 ZIP、ZIP blockmap 与清单，核对清单版本、ZIP 大小和 SHA512、blockmap 结构及覆盖范围后缓存。

可选 `--from-dir /path/to/release/0.0.4` 指定单个旧版本目录，显式目录不合格时停止，不换用其他来源。新版输出默认在 `release/<新版本>/`，可用 `PANXU_RELEASE_DIR` 指定；续跑不能更换输出目录。

两种命令均交付完整签名安装包、更新包、blockmap 和清单。`full` 不强制客户端下载完整 ZIP；`differential` 先准备旧版基线，不生成独立 patch 或单功能包。客户端按缓存与网络条件优先差分，失败时回退全量；安装需要重启。

### 只查看计划

```sh
npm run release:full -- --dry-run
npm run release:differential -- --dry-run
```

预览仅读取本地版本及任务记录，不升版、不写文件、不联网、不提交、打包、上传或运行测试；输出不代表基线、凭据或产物已通过核验。

### 可选草稿与手动固定版本流程

`release:draft` 是可选的兼容入口：自动接续已记录任务并完成源码提交、标签推送及草稿上传，保留草稿；不额外升版。随后点击对应的 `release:full` / `release:differential` 即可正式公开同一版本。日常使用两个主命令时不需要这一额外步骤。

`release:mac` / `release:win` 仍按当前固定版本签名打包，不自动升版、提交或发布。多平台须先统一版本与说明，再分别构建；全部产物齐全后通过 `verify:updates:all` 核对。底层 `node scripts/package-release.mjs --mode differential --platform mac --arch arm64 --from <旧版本>` 可准备固定版本差分基线，不自动下载缺失基线。

CI 使用 `node scripts/draft-release.mjs` 上传草稿，继续强制校验 `GITHUB_REF=refs/tags/v<当前版本>`，独立于本机自动升版流程。

只有用户明确要求差分专项时才执行以下命令，发布流程不会自动调用：

```sh
npm run test:updates:differential -- <旧版本> <新版本>
# 两个版本位于其他共同发行根目录时
PANXU_RELEASE_ROOT=/path/to/release npm run test:updates:differential -- <旧版本> <新版本>
```

专项使用本机回环服务核对下载、重建、摘要与回退，写入报告，不执行原生安装或桌面界面操作。`PANXU_RELEASE_ROOT` 是包含两个版本子目录的共同根目录，与单个旧版本的 `--from-dir` 不同。

## 全量、差分与独立功能更新

当前应用使用完整版本安装：新版代码、界面和运行时作为同一份签名应用交付，用户确认后重启安装。发布端始终保留完整 ZIP、对应 blockmap 和更新清单。

当前 `electron-updater` 默认允许差分下载。macOS 在缓存中存在上次更新的 `update.zip` 时，结合新旧 blockmap 尝试只下载变化的数据块，再重建完整 ZIP。没有旧缓存、差分请求失败或无法完成重建时，会转为下载完整 ZIP。首次安装后第一次应用内升级不保证能使用差分；附件中存在 blockmap 也不能证明某次升级实际采用了差分。0.0.1 → 0.0.2 已通过隔离下载链的五个差分、校验和回退场景，ZIP 数据与 blockmap 合计约 10.83 MiB，较完整 ZIP 减少约 92.28%；公开 blockmap 和单区间 206 响应也已核对。该专项没有执行原生安装重启，详见[历史差分下载记录](releases/0.0.2-differential.md)。

0.0.2 → 0.0.4 已完成五个隔离场景，以及真实生产版的公网差分下载、SHA512 核对、原生安装和重启。隔离成功场景含两个 blockmap 共约 9.12 MiB；本机在预先准备官方 0.0.2 缓存后，网络进程接收量增量约 8.97 MiB，两个数字的统计范围不同，不承诺固定节省比例。安装后版本、签名、公证票据、原工作空间与图标均已核对，见[0.0.4 发布与升级记录](releases/0.0.4-readiness.md)。

差分下载减少的是网络传输量，不等于独立更新某个功能或免重启。当前没有独立功能包的版本、兼容性、验签及回退机制，也不会直接覆盖已签名应用内的 ASAR 或脚本。

若后续需要更细粒度更新，可以将模板、提示词、纯数据规则及素材等不执行代码的内容设计为独立资源包，经清单验签、内容校验和兼容性检查后切换生效；运行逻辑和数据库迁移继续随应用发行。此资源包更新机制尚未实现。完整安装包、blockmap 及未来的签名资源清单均可通过静态 GitHub Releases 托管，无需自建服务器。

## 安装包语言资源

从 0.0.3 起，发行包只保留简体中文的 Electron 语言资源。macOS 的 `.lproj` 目录使用 `zh_CN`，连同现有简体中文语法变体一起保留；主应用的 `CFBundleDevelopmentRegion` 和 `CFBundleLocalizations` 同时声明简体中文，确保系统选择与包内资源一致。Windows 的 `.pak` 文件使用 `zh-CN`。分别通过各平台的 `electronLanguages` 配置裁剪，保留浏览器引擎及字符编码、字体渲染所需的核心资源。升级 Electron 时应复核实际简体中文资源名称。

0.0.4 最终签名公证 ZIP 实测为 134,277,556 字节（约 128.06 MiB），0.0.2 为 147,082,667 字节（约 140.27 MiB），完整发行包减少约 12.21 MiB；两版也包含业务代码变化，不能将全部差值归因于语言裁剪。既有 0.0.2 附件保持原样。0.0.3 因遗漏传递依赖已撤回稳定通道，其体积不作为可用发行包的优化基准。

正式发布入口要求项目拥有真实 `node_modules` 目录，拒绝符号链接结构。`verify-release` 在签名和源码检查外，递归核对 ASAR 中的必需依赖以及 `main`、解包入口文件；缺包时阻止验收。签名、公证及更新哈希校验只能证明完整性和发行身份，不能代替依赖或实际启动检查。

## 本地验证

以下自动化测试入口仅在用户明确要求时按授权范围执行；发布编译、签名、公证及附件完整性检查不等同于功能测试。每版实际执行范围单独记录，不能沿用历史测试结果宣称通过。

```sh
npm test
npm run build
npm run test:e2e
npm run test:e2e:updates
npm run package:mac
npm run package:win
npm run verify:release
npm run verify:updates
npm run test:e2e:packaged
# 所有已启用平台产物准备完毕后
npm run verify:updates:all
# 仅验收本机构建时，可显式限定架构；正式发布禁止缩小范围
node scripts/verify-updates.mjs --arch=arm64
```

`PANXU_RELEASE_DIR` 可指定检查/验收目录。更新交互测试使用真实 Electron、预加载桥和控制器，只替换网络/系统安装端口，不操作真实工作空间。业务回归使用临时数据库并关闭其自动更新检查。

## 故障与回退

- 断网、尚未发布、磁盘不足、权限不足、哈希/签名异常分别提示，原版本继续可用。
- 公开后不要删除附件或覆盖同名包。问题版本先撤回，再以**更高的补丁版本**发布修复；已更新客户端不会自动降级。
- 安装快照在当前数据目录 `updates/backups/`，最多保留最近三份。快照含本机加密凭据，设置为本机私有文件，不能当作可共享备份；封面和登录目录原位保留。
- 数据库已有迁移前备份和未来版本保护，旧安装包不能强行打开更高版本数据库。确需回退时先关闭应用、完整复制数据目录，再使用匹配版本的快照；便携恢复继续使用设置页的备份导出/预检流程。
- 日志在当前数据目录 `logs/updater.log`，512 KiB 轮转一份，只记录版本、阶段、错误代码，不记录凭据、响应正文或临时下载链接。
- 旧内部联调 0.3.1 及更早的内部版本没有更新入口，首次需手动安装具备此功能的版本。正式 0.0.1 及后续版本已包含更新入口。真实系统升级验收需要两份使用相同发行仓库、同一签名身份的安装包，在对应发行平台执行“旧版本 → 新版本”。控制器和界面测试不能替代此验收。

## 0.0.1 正式版起点（2026-10-20）

内部联调版本历史已归档，正式版本从 0.0.1 开始。旧版无法通过自动更新降级，首次手动安装；自动更新继续只接受更高稳定版本，不修改安全边界。

开发默认使用独立的“盘序开发”工作空间，正式版继续使用“盘序”。安装包不包含任何开发数据、密钥或账号；原有数据不因重置版本号被删除。生产禁用 DevTools，也不会加载开发环境 URL。

本机 macOS 可直接使用钥匙串中的 Developer ID Application 证书，无需为本机构建导出私钥。先在交互终端运行：

```sh
npm run release:setup:mac
```

输入 Apple ID、应用专用密码和证书对应的 Team ID 后，凭据保存在本机钥匙串。随后运行：

```sh
APPLE_KEYCHAIN_PROFILE=panxu-notary npm run release:mac
```

`release:mac` 未显式指定其他公证认证方式时，会自动使用本机钥匙串 `panxu-notary`，只制作 Apple Silicon ARM64 包。`npm run test:e2e:production` 检查全新用户状态与设置恢复；首次基线可运行 `PANXU_NATIVE_UPDATE_TEST=1 CSC_NAME="你的 Developer ID 签名身份" node scripts/e2e-native-update.mjs`，使用独立应用副本和临时数据真实执行 0.0.0→0.0.1 安装重启。此演练不代表正式 GitHub 更新源已验收。

`release:mac` 与 `release:win` 强制检查签名、公证、辅助程序及版本说明，缺项立即退出。仅有 Apple Developer 会员不能签名 Windows；Windows 未办理代码签名时不能宣称已验收安全自动更新。正式签名需要稳定的同一发行主体，不应在不同版本随意更换。

0.0.1 已发布到 [GitHub](https://github.com/minimissile/drive-tools/releases/tag/v0.0.1)，附件与更新清单的远端 SHA256 均已核对。公开源在本机有成功版本识别和下载启动记录，也出现匿名 403 与慢速下载超时；完整公开下载未标为验收通过。更换可访问 GitHub 的网络后可重试，应用不会将网络失败伪报为最新版本。隔离的本机完整安装重启演练与正式安装副本验收已通过。

0.0.1 的历史状态见 [0.0.1 验收记录](releases/0.0.1-readiness.md)及[目录清理记录](releases/0.0.1-cleanup.md)。

## 0.0.4 已发布并完成本机升级（2026-10-29）

[0.0.4 正式发布页](https://github.com/minimissile/drive-tools/releases/tag/v0.0.4)是当前稳定版本，提供签名公证的 macOS ARM64 DMG、更新 ZIP、blockmap 和更新清单。六个远端附件的大小及 SHA256 与本地一致，匿名 latest 清单已核对。

0.0.3 的真实升级暴露传递依赖遗漏后，先撤回稳定通道并恢复本机 0.0.2；补齐依赖、加入包内闭包检查并手动确认候选包可启动后，正式发布 0.0.4，再从 0.0.2 完成实际差分升级。安装后主窗口正常，原有 6 份资源、6 个副本及已保存配置可读取，“拆分为多个链接”的图标已补齐。升级前快照保留在原工作空间的 `updates/backups`，没有清理工作空间或真实网盘内容。未扩展执行其他功能自动化或付费请求，详见[0.0.4 记录](releases/0.0.4-readiness.md)和[0.0.3 故障记录](releases/0.0.3-readiness.md)。

## 0.0.2 已发布（2026-10-28）

[0.0.2 正式发布页](https://github.com/minimissile/drive-tools/releases/tag/v0.0.2)提供 macOS Apple Silicon ARM64 安装包和更新 ZIP，沿用原有 Developer ID 发行主体。Apple 公证返回 Accepted，应用票据和 Gatekeeper 检查通过；6 个远端附件的大小及 SHA256 与本地一致，已设为最新稳定版本。

发布时没有运行自动化功能测试、真实安装或 0.0.1 → 0.0.2 升级演练，不能将附件和签名校验视为全量功能验收。其后按用户明确授权完成了上述差分下载专项，仍未执行实际安装重启。发行标签固定后的并行开发改动未混入本版。具体提交、公证标识、发布时间及检查范围见 [0.0.2 发布记录](releases/0.0.2-readiness.md)。
