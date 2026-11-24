# 资源清单导出公众号 · 2026-11-24

原资源清单具备Excel/Markdown导出、站点发布、飞书/腾讯文档/石墨交接，本轮新增本地公众号草稿导入，复用WechatArticles的存储、稿件家族、编辑及后续送稿能力。没有新增微信远端适配器或自动发送动作。

## 实现

- 独立 `resourceCatalog.exportWechat` 命令在入口校验ID/revision/hash，按清单互斥读取完整有效本人分享快照。拒绝陈旧内容与空清单，不使用前端传入的正文或UI分页结果。
- AppService通过窄回调组装到WechatArticles，公众号域的catalog-draft负责Markdown、标题/摘要长度、唯一链接100条及20万字符限制；超限先拒绝再写入。
- 本地稿件ID由catalogId+公开hash生成，家族键使用同一语义。重试与重复导出打开原稿，不覆盖正文、stage、remote或历史；新内容另建，常规“再发一篇”继承清单来源。
- 保留准确公开分享及提取码，使用现有manual链接模型，不带含糊的copyId/resourceId去误定位总副本；拆分分享不会在同步中被替换成总链接。导出后的实时核验不是这条路径的能力，来源警告明确后续不会自动跟随资源库。默认阅读原文继续使用现有正文首条网盘入口规则，没有把清单页伪装为公众号文章来源。
- 前端复用selectSavedWechatDraft的窗口级handoff，成功后打开新/已有稿；离开原清单后完成不会跳走。创建成功但定位暂存失败用warning保留本地成功，不诱导重复创建。文字按钮使用现有带边框样式。

## 验证

`tests/resource-catalog-wechat.test.ts`、`tests/wechat.test.ts` 和 `tests/wechat-article-groups.test.ts` 合计98项通过。覆盖准确多分享/提取码、100/101链接、正文上限与无半稿、长标题、导入/去重/保留编辑、新hash新稿、过期revision/hash及空清单拒绝；原公众号导入、模板、再发一篇、手动链接与送稿回执回归继续通过。测试使用独立临时数据库和既有模拟端口，没有付费AI或真实微信写入。类型与本轮差异静态检查通过。

`scripts/qa-resource-catalog-wechat.mjs` 在1440×900专属窗口验证了入口、失败恢复、处理中禁用、草稿标题定位、页面跳转及空清单禁用。真实源码页面仅只读截图，导出交互在无Electron preload、无真实IPC的页面内存iframe中完成。初轮测试误定位普通草稿不展示的内部message，改为检查实际文章标题编辑器后通过，不将失败当成功。关键截图位于 `test-results/resource-catalog-wechat/source-entry.png` 与 `local-draft-handoff.png`，已查看实际入口密度和交接编辑器。

初轮窗口 `c476dbb4-6538-4738-b190-808797e3032b` 与通过窗口 `44fde213-0e55-4a2e-ada2-dcf40c50c448` 均由test:session按ID关闭。其他任务的自动化窗口不操作、不关闭。未操作主窗口业务、重启共享后台或应用新后端；本轮后端仍待用户手动应用。没有在真实工作区创建草稿或发送到微信，因此不将隔离测试记作真实微信草稿保存结果。

## 用户应用后真实导出

用户随后明确确认已应用更新，并要求导出“求职与个人成长资源清单”查看实际效果。通过真实清单入口完成本地导出，当前清单revision 3，44项可访问资源、44个分享入口已进入本地草稿；16项未通过清单公开条件的资源未纳入。草稿ID为 `wechat_catalog_a04919bc566d459a7d58597370faf4b8ab360ba7`，正文3654字符，来源快照条目数与清单一致。

已在实际公众号草稿编辑器核对标题，并打开排版预览查看标题、介绍、条目及资源卡片；截图保存于 `/private/tmp/panxu-catalog-wechat-live-20261124/draft-preview.png`。草稿stage为editing、remote为空，没有选择公众号、上传素材、调用AI、保存到微信或发表。真实任务窗口 `ab9c868a-67ce-4958-8ab9-08d764f3335a` 已按ID自动关闭，窗口列表仅保留原main，并切回主工作台。
