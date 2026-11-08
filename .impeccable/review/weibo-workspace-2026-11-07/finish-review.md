# 微博内容工作区收尾评审

## 1. 证据有效性与范围

已逐一打开 `01-content-list.png`、`02-content-editor.png`、`03-account-style.png`、`04-content-statistics.png`、`05-refresh-error.png`、`06-filter-empty.png`、`07-managed-delivery.png`、`08-prepared-preview.png`，以及 `account-style-history.png`。八张产品截图均为 1440×900，展示与文件名一致的完整可读状态，没有黑屏、空白、半加载或动画遮蔽。07、08 是定位到发布设置及交付预览的组件视图；它们只支持这些区域的视觉判断，不代表整条旧 Workflow 首屏已做新的完整视觉验收。

本次依据为 `.impeccable/surfaces/weibo-content.md`、既有 `DESIGN.md`、craft-floor、上述截图、`ui-test.json`、测试脚本与范围内代码。没有批准的视觉 comp，本次是既有白色紧凑桌面工作台的扩展，因此不作新视觉世界或 comp 保真度评价。未评价并行贴吧、流量词库改动，未打开或操作任何窗口，未修改产品代码。

`ui-test.json` 记录当前前端通过页面业务传输连接独立临时 AppService；不是共享后台的新版本现场验收。报告显示共享后台 revision 226 / runningRevision 222，仍待用户应用更新。本次没有实际模型生成、真实业务修改、上传或发布。测试脚本覆盖列表分页、账号筛选、无资源选题保存、保存后新建、表单恢复、账号版本及文风隔离、真实 0 与缺失统计、刷新失败恢复、托管附件准备和标题后链接顺序。迟到保存后导航保护主要通过代码检查，未见专项 UI 延迟断言。`detector.json` 为 `[]`，未重复运行 detector；没有新增发布栅格资产。

## 2. Craft floor

所见页面遵循既有白色工作台：标题、三个页签、筛选、表格和新建操作容易定位；编辑器采用设置与内容并列，字段与主操作没有横向挤压；错误保留内容并有一处明确重试，筛选空态有清除筛选。统计表明确区分 0、未提供和尚未采集，没有把阅读量写成独立访客或链接点击。

公开 token 的正文/页面背景对比度约 13.38:1，辅助文字/页面背景 5.01:1，主按钮白字/蓝底 5.55:1，错误文字/错误底 4.63:1。布局复用 16px 分区、公共控件与公共焦点样式，没有新增页面焦点覆盖。现有桌面系统的字级、圆角和隐藏滚动条约定优先于通用 craft-floor 的默认偏好。所见没有需要重建的视觉或层级问题；没有把未展示的悬停、全键盘路径和实际官方发布器宣称为已验证。

账号文风预设明确约束资源名称与已知规格在前、标题后本人核验链接、短介绍及真实海报/封面，与历史截图的资源帖结构一致。它没有把旧帖的年份、规格或链接当作新内容事实；新工作区的 AI 调用仍显式触发。

## 3. UX 与行为发现

### F1 · P2：关联资料搜索只能搜索内容标题的候选，无法独立寻找资料

`IdeaEditor` 的 `weibo.matches` 只使用内容标题，资料 `SearchSelect` 没有 `onQueryChange`。因此，例如先保存“周末想看的片单”，稍后在关联资料中输入一部已核验影片名，输入只过滤这批标题候选，不会查询该影片。后端候选最终仅保留 30 条，资源库增大后问题更明显。旧 Setup 原本允许单独输入资料匹配关键词，这条路径在重组时丢失。内容标题允许 200 字，而匹配 IPC 最多 100 字，101–200 字的合法标题还会自动造成资料查询校验错误。

定位：[IdeaEditor.tsx:62](/Users/nuke/Desktop/drive-tools/src/weibo/IdeaEditor.tsx:62)、[IdeaEditor.tsx:143](/Users/nuke/Desktop/drive-tools/src/weibo/IdeaEditor.tsx:143)、[IdeaEditor.tsx:210](/Users/nuke/Desktop/drive-tools/src/weibo/IdeaEditor.tsx:210)、[weibo.ts:13](/Users/nuke/Desktop/drive-tools/core/ipc/weibo.ts:13)。原行为见 [Setup.tsx:149](/Users/nuke/Desktop/drive-tools/src/weibo/Setup.tsx:149)，候选限制见 [content-sources.ts:137](/Users/nuke/Desktop/drive-tools/core/content-sources.ts:137)。

### F2 · P2：历史微博统计及其已采集记录在新入口中不可达

账号的统计操作已转向新工作区，但新工作区只列 `posts` / `marketing` 中带 URL 的内容。旧 `WeiboAccountStatistics` 支持粘贴任意当前账号的本人历史微博链接，并将只有统计快照、没有本地发布任务的链接列为“已采集的微博”。该组件现在没有调用方，新工作区也未接入 `weiboStats.list` 或链接输入。因此，过去在微博直接发布的历史帖无法从新统计页读取；已保存的这类快照也不在列表中，用户容易以为记录丢失。此缺陷与截图中的 0 / 缺失展示无关，截图仅覆盖有本地发布任务的两条记录。

定位：[OtherAccounts.tsx:188](/Users/nuke/Desktop/drive-tools/src/accounts/OtherAccounts.tsx:188)、[Workspace.tsx:116](/Users/nuke/Desktop/drive-tools/src/weibo/Workspace.tsx:116)、[workspace.ts:269](/Users/nuke/Desktop/drive-tools/core/weibo/workspace.ts:269)、[workspace.ts:293](/Users/nuke/Desktop/drive-tools/core/weibo/workspace.ts:293)。被移除入口的能力见 [Statistics.tsx:164](/Users/nuke/Desktop/drive-tools/src/weibo/Statistics.tsx:164)、[Statistics.tsx:206](/Users/nuke/Desktop/drive-tools/src/weibo/Statistics.tsx:206)；独立快照原有枚举见 [statistics.ts:83](/Users/nuke/Desktop/drive-tools/core/weibo/statistics.ts:83)。

### F3 · P2：现有本地词库选题建议和来源选择入口丢失

旧 Setup 的 `weibo.words` 会提供本地词库、词池候选与来源；新编辑器的选题名称是纯输入框，`weibo.words` 的唯一前端调用仍留在已经没有引用的 Setup 中。新建内容无法再选用已有词库选题，后续资源任务只能走 `sourceId: "manual"`。用户批准的是合并工作区、允许先保存选题和保留原风格，没有批准删除现有选题发现能力。恢复为可选建议即可，不应重新变成保存门槛。

定位：[IdeaEditor.tsx:210](/Users/nuke/Desktop/drive-tools/src/weibo/IdeaEditor.tsx:210)、[workspace.ts:215](/Users/nuke/Desktop/drive-tools/core/weibo/workspace.ts:215)。原能力见 [Setup.tsx:61](/Users/nuke/Desktop/drive-tools/src/weibo/Setup.tsx:61)、[Setup.tsx:121](/Users/nuke/Desktop/drive-tools/src/weibo/Setup.tsx:121)；`Workflow.tsx` 现只保留 `WeiboTask`。

已检查的边界没有形成额外必修项：账号版本通过新 idea ID 和独立稿件创建，不复用发布确认或排期；测试明确断言原稿、审阅和原计划保留。[IdeaEditor.tsx:255](/Users/nuke/Desktop/drive-tools/src/weibo/IdeaEditor.tsx:255) 的保存完成与 [IdeaEditor.tsx:319](/Users/nuke/Desktop/drive-tools/src/weibo/IdeaEditor.tsx:319) 的交付导航受组件生命周期保护；新建保存后清理新稿暂存并切换为业务 ID，现有 UI 断言覆盖再次新建为空。这里只认可相应代码与隔离测试的证据范围。

## 4. 必须修复与复验

1. F1：让关联资料的搜索输入驱动独立的本地匹配查询，保留标题作为初始建议并保持选中资料；处理 200 字内容名称与 100 字匹配契约的差异。用“不与内容标题共享词的真实 fixture 资料”验证可搜可选，再验证 101–200 字合法标题不会触发自动读取错误。
2. F2：在新复盘工作区接回既有本人历史链接读取和独立统计快照入口，继续复用账号归属验证及显式“读取最新数据”。验证仅有快照、没有 post/marketing 的历史链接仍能找到；粘贴本人链接可在明确点击后读取，错误账号链接仍被拦截。可复用现有统计组件或将等价能力纳入新页签。
3. F3：恢复可选的本地词库/词池选题建议及来源信息，复用现有 `weibo.words` 和公共输入建议控件；保留手工输入与无资料保存。验证选中候选能填写选题并保留来源，手工选题仍可直接保存，不自动调用付费或远程接口。

三项同批修复后，运行对应隔离交互断言，按原 1440×900 截图文件重新捕获相关状态，交回同一评审做三项修复的 verdict pass；无需改变视觉方向或增加移动端矩阵。

## 5. Disposition

disposition: fix

所见视觉扩展达到既有工作台的基础质量；本轮不能 ship，原因是以上三处既有操作能力在合并入口后不可达或受限。结论仅适用于本报告的截图、代码与隔离测试范围，不代表共享后台新版本或真实官方上传/发布通过。
