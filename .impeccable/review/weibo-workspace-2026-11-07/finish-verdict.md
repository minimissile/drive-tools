# 微博内容工作区修复判定

## 1. 证据与范围

本轮仅对原 `finish-review.md` 的 F1、F2、F3 评分，没有重新进行全表面缺陷搜索，没有打开 UI，没有修改产品代码，也没有运行第二次 detector。

已打开最新 1440×900 的 `02-content-editor.png`、`04-content-statistics.png`、`09-independent-resource-search.png`、`10-keyword-source.png`、`11-historical-statistics.png`。画面可读、状态与文件名一致；10 现在展示完整“来源：词池：模拟·本地选题 · 手工录入”，不是此前紧邻选择时的暂态来源。

三项首次修复判定使用窗口 `1baa7fcf-6874-424c-91ed-5e52587ff87f` 的成功证据，15 项检查完成、`errors: []`，当轮共享后台 revision/runningRevision 为 242、pending=false。F1、F2 保留该轮的 resolved 判定。

随后只对 F3 的“同词多个来源时显示与保存一致”补核对。当前 `ui-test.json` 为窗口 `5137edfa-162b-48a6-84a7-1203a0bbab21`，16 项检查完成，新增 `duplicate keyword keeps the displayed source identity`，`errors: []`；已打开该轮更新后的 `10-keyword-source.png`。该轮共享后台 revision 245 / runningRevision 243、pending=true，不将先前后台已加载的状态延伸到当前暂存更新。

两轮界面业务传输均连接独立临时 AppService；`generatedDuringUi: 0`、`realBusinessMutations: 0`、`uploadOrPublish: 0`。后台状态不是隔离业务断言的真实数据验收。构建线程另报告 27 项微博业务测试和 `npx tsc --noEmit` 通过，本评审未重复运行。

## 2. F1：独立资料搜索与长标题契约

**resolved**

[IdeaEditor.tsx:62](/Users/nuke/Desktop/drive-tools/src/weibo/IdeaEditor.tsx:62) 维护独立 `resourceQuery`，[IdeaEditor.tsx:171](/Users/nuke/Desktop/drive-tools/src/weibo/IdeaEditor.tsx:171) 将 `SearchSelect.onQueryChange` 接入它；匹配读取按 `(resourceQuery || v.title).slice(0, 100)` 请求，保留 200 字内容标题本身。

09 显示“周末想看的片单”成功关联“Python 入门练习资料”。[qa-weibo-workspace.mjs:207](/Users/nuke/Desktop/drive-tools/scripts/qa-weibo-workspace.mjs:207) 的断言检查超过 100 字标题请求被限制到 100 字，随后检查独立 Python 查询实际发送并可选中资源。原来只能过滤标题候选和长标题导致匹配读取失败的问题已解决。

## 3. F2：本人历史微博与独立统计快照入口

**resolved**

[Workspace.tsx:309](/Users/nuke/Desktop/drive-tools/src/weibo/Workspace.tsx:309) 在数据复盘页选择账号后接回 `WeiboAccountStatistics`，保留 `weiboStats.list` 的独立快照枚举、本人链接输入和显式读取操作。全部账号视图提供清晰提示，见 04；账号内展开的历史链接、已采集目标和实际快照见 11。

[qa-weibo-workspace.mjs:367](/Users/nuke/Desktop/drive-tools/scripts/qa-weibo-workspace.mjs:367) 选择没有本地 post/marketing 的“已采集的微博”，确认链接与历史样本可见，并确认仅打开历史记录未触发 `weiboStats.refresh`；随后验证错误作者被拦截，再对本人历史链接显式点击并完成模拟读取。原有历史查询入口及已有快照的可达性已恢复，归属校验和显式读取边界保留。

## 4. F3：本地选题建议与来源保留

**resolved**

[IdeaEditor.tsx:63](/Users/nuke/Desktop/drive-tools/src/weibo/IdeaEditor.tsx:63) 读取 `weibo.words`，[IdeaEditor.tsx:223](/Users/nuke/Desktop/drive-tools/src/weibo/IdeaEditor.tsx:223) 复用公共 `TextSuggestions`，候选显示词与来源并保存对应 `sourceId`。10 中完整词池来源可见，未选择账号或资料时“保存选题”仍可用。

[shared/weibo-workspace.ts:17](/Users/nuke/Desktop/drive-tools/shared/weibo-workspace.ts:17) 保留来源字段，[core/weibo/workspace.ts:217](/Users/nuke/Desktop/drive-tools/core/weibo/workspace.ts:217) 将它传入营销任务。[qa-weibo-workspace.mjs:252](/Users/nuke/Desktop/drive-tools/scripts/qa-weibo-workspace.mjs:252) 选择本地候选并检查保存后的来源 ID；[weibo-workspace.test.ts:9](/Users/nuke/Desktop/drive-tools/tests/weibo-workspace.test.ts:9) 检查关联资料交付继续保留原来源记录。原本不可达的本地选题与来源路径已恢复，仍可手工输入和无资料保存。

**双来源补核对：resolved。** [IdeaEditor.tsx:69](/Users/nuke/Desktop/drive-tools/src/weibo/IdeaEditor.tsx:69) 建立同一 `keywordSuggestions` Map，[IdeaEditor.tsx:229](/Users/nuke/Desktop/drive-tools/src/weibo/IdeaEditor.tsx:229) 的候选展示和 [IdeaEditor.tsx:236](/Users/nuke/Desktop/drive-tools/src/weibo/IdeaEditor.tsx:236) 的 `sourceId` 查询均使用这份映射，消除了“显示最后来源、保存第一来源”的不一致。[qa-weibo-workspace.mjs:41](/Users/nuke/Desktop/drive-tools/scripts/qa-weibo-workspace.mjs:41) 创建两词池同词夹具并明确断言至少两个来源；[qa-weibo-workspace.mjs:252](/Users/nuke/Desktop/drive-tools/scripts/qa-weibo-workspace.mjs:252) 按实际显示的词与来源选择候选，[qa-weibo-workspace.mjs:276](/Users/nuke/Desktop/drive-tools/scripts/qa-weibo-workspace.mjs:276) 断言保存的 `sourceId` 等于该显示候选的 ID。最新截图显示完整词池来源，当前成功报告包含该断言，F3 保持 resolved。

## 5. Disposition

disposition: ship

| 原发现 | 判定 |
| --- | --- |
| F1 独立资料搜索与长标题契约 | resolved |
| F2 历史链接与独立统计快照入口 | resolved |
| F3 本地选题建议与来源保留（含同词双来源一致性补核对） | resolved |

三项必修均已解决，本轮没有剩余修复项。此 `ship` 仅表示本次 verdict pass 将原三项评分为 resolved；不将其扩大为一次新的全表面无缺陷结论，也不代表实际官方统计页面、上传或发布通过验收。
