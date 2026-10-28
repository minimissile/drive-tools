# 公共皮皮虾采集

Mode: Operate。将既有采集工作区独立到工作台通用内容操作，继承白色桌面系统。

## Direction contract

THESIS：一次采集、多渠道草稿各自编辑；来源记录与渠道交付状态明确分离。

OWN-WORLD：沿用系统中文字体、白色 Panel、蓝色主操作、语义状态，以及 tokens.css、form-controls.css、Select、CheckboxField、Pagination 和 QueryError 的规格。

STORY：用户先采集并挑选原帖图文、评论，再指定渠道及必要的账号；保存后打开已有渠道编辑器，不自动填写或发布。重复采集保留各渠道编辑成果。

FIRST VIEWPORT：独立“皮皮虾采集”标题；左侧“获取数据列表／分享链接”两个采集方式及采集历史，右侧内容预览及挑选。新用户默认本地知识库，可切图文搜索／推荐／作者／话题；Key 统一在“连接与设置 → 内容数据源”维护，采集页只显示状态与跳转。批量采集操作位于候选列表上方，不必滚过全部帖子。渠道去向、字数提示、草稿操作与交付记录位于内容之后。工作区纵向滚动覆盖 1440×900 与 1366×768。知乎和微博页面提供公共采集快捷入口。

SETTINGS EXTENSION：沿用 SecretField、Panel、Field、Status、Notice、table 及 settings.css；只新增“内容数据源”分区和折叠的容量实测。参数回传与返回量效果分开，实测结果只报告当前关键词和接口的最大观察值，不宣称全局上限。知识库按接口整页入库，选择上限与本地显示分页不截断归档。

FORM：既有双列工作区，新增去向选择与交付记录；seed: none (unavailable)。测试图片标明本地模拟，不是发布素材或装饰资产。

FINISH：unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Documentation boundary

普通业务结构调整，不新增视觉系统或公共 token。当前根目录没有 PRODUCT.md、DESIGN.md，不补写全项目规范。复核仅记录现有控件、样式和截图的符合性，保留先前知乎采集的历史验收记录。
