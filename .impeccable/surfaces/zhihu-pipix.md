# 知乎运营：皮皮虾采集

Mode: Operate。普通业务扩展，沿用现有白色工作台，不替换视觉系统。

## Direction contract

THESIS：从分享链接进入可核对的素材，明确区分采集、挑选、导入和审核。成功与失败逐条可见，原帖只产生一份素材。

OWN-WORLD：复用 `src/styles/tokens.css`、白色 Panel、蓝色主操作、语义 Status、统一表单焦点、Select、CheckboxField、Pagination 与 QueryError。系统中文字体和现有桌面密度。

STORY：用户粘贴分享文案，查看本地图片和页面评论，勾选后进入现有知乎素材审核。每步保留来源与状态；界面不展示任意私有接口细节。

FIRST VIEWPORT：知乎工作流五个页签；采集页左侧为链接表单和已采集列表，右侧为正文、图片与评论；导入位于选择之后。1366×768 和 1440×900 通过工作区纵向滚动访问操作。

FORM：既有工作台双列业务布局；seed: none (unavailable)。测试图片明确写明本地模拟，不是发布素材或装饰资产。

FINISH：unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Documentation boundary

保留既有视觉规范文件与 token；本扩展不新增设计系统。当前根目录没有 PRODUCT.md、DESIGN.md，不为了业务扩展补写全项目规范。检查依据为 tokens.css、form-controls.css、Tabs、Select、Panel、Pagination 和 QueryError 的现有实现。
