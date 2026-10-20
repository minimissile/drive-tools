# 百度营销流量发现集成

入口为 **账号管理 → 网站账号** 与 **流量发现 → 百度营销**。网站账号统一负责登录、身份识别、备注、状态检查和移除，各工作空间、各本地账号使用独立 Electron 会话。登录无需用户ID，账号身份从百度官方页面与会话中自动识别。Codex内置浏览器与盘序会话独立。

## 功能范围与原站核对

2026-10-20 在百度原站实际检查了关键词入口、种子词/关键词生成切换、落地页和业务拓词、关键词榜单、关键词分组、流量查询、海量拓词任务列表；同时核对了百度公开前端模块的真实请求与字段。之前版本只覆盖种子词检索，本次扩展为六个工具。

| 工具 | 当前源码能力 |
| --- | --- |
| 关键词拓词 | 种子词、业务描述、落地页和推广业务四种方式；业务目录搜索选择；关键词与关键词组合；地域/设备、包含/排除、最低搜索量、竞争度、特色、排序；核心/设备/预估/特色/自定义列；筛选、分页、多选、词池保存和全部结果CSV导出 |
| 关键词榜单 | 高消费、高转化、热搜三榜；推广业务目录、地域、已购词过滤、更新时间；结果选择后送往拓词或流量查询；保存词池和导出 |
| 关键词分组 | 第一列关键词的XLSX上传；地域、业务、词性及自定义维度；最多7维、每维20词根；百度模板读取/套用/保存；提交、手动读取任务、下载；文本和大附件按工作空间与账号暂存，恢复不会自动上传 |
| 流量查询 | 最多1000词、每词40字；参考出价、匹配模式、地域和设备；实际返回指标、分页、筛选、词池保存与导出；符合月搜索量规则的结果自动收录 |
| 海量拓词 | 最多1000种子词、100排除词根；地域词与已购词设置；显式提交、手动读取任务状态、完成结果下载与本地收录；同表单提交后阻止连续重复提交 |
| 行业流量洞察 | 观星盘独立产品会话；行业/推广业务及下级业务目录；日期、设备；热搜/新增/激增词与增长率；行业搜索趋势图和地域设置；候选词带入拓词/流量查询、保存词池与导出 |

每个工具保留“打开对应官方工具”，使用所选账号的同一隔离会话进入对应页面。原站更细的业务操作仍可在官方窗口执行。盘序面向找词与流量研究，广告计划、投放单元的写入由官方页面处理。

全部外部请求均由按钮触发。切换入口、账号状态轮询、本地缓存重读及表单恢复不发起外部查询。异步任务不在后台持续轮询；提交成功与任务列表读取分别处理，列表读取失败时保留成功提交的状态。查看本地结果不要求会话仍有效，但身份必须与记录一致。

## 本地词库与更新

成功拓词、流量查询，以及用户点击任务“收录到本地词库”后，只有明确包含 `averageMonthPv > 10` 的新词进入长期知识库。任务XLSX/CSV必须包含“关键词”和“月均搜索量”列；数值10、缺失、不可解析、搜索指数和增长率均不代替月搜索量。榜单和行业词可先保存候选词池，带入后续查询补充月搜索量。

同来源、归一化词语、平台合并展示最新指标，保留首次收录、最近采集和历史观察。跨账号同来源同词不重复建逻辑词条。新结果即使降至10以下或导出值为“<5”，仍更新已收录词的旧指标，保留原始“<5”，不虚构精确值。旧结果不覆盖较新数据；重复读取同一次结果、重复收录相同任务文件不会增加重复观察。

归档在 `traffic_queries` / `traffic_items`，独立于30天 `api_cache`。查询缓存失效、移除账号不会删除已收录词。任务文件按内容摘要、账号和任务编号分批幂等收录。未在新结果出现的词保留原采集时间。更新由后续手动查询或收录触发，不安排自动付费查询。

## 接口与实现依据

凤巢请求入口为 `POST https://fengchao.baidu.com/hairuo/request.ajax`，观星盘为 `POST https://cdp.baidu.com/hairuo/request.ajax`。表单包含 `reqid`、自动识别的 `userid`、主进程会话令牌、固定 `path` 和JSON参数。分组文件使用同一官方文件服务的multipart请求及MD5文件摘要。

- [工具模块入口](https://tuiguang-s3.bdstatic.com/toolsCenter/toolsCenter.js)
- [关键词、流量与海量任务接口](https://tuiguang-s3.bdstatic.com/toolsCenter/static/js/6154.9d67580e.chunk.js)
- [榜单接口与指标](https://tuiguang-s3.bdstatic.com/toolsCenter/static/js/1485.77fe2910.chunk.js)
- [分组、模板、海量任务页面](https://tuiguang-s3.bdstatic.com/toolsCenter/static/js/5933.d9fb2b54.chunk.js)
- [业务选择器](https://tuiguang-s3.bdstatic.com/commonLibs/static/js/77112.e4132c83.chunk.js)
- [观星盘行业洞察](https://cdp.baidu.com/static/main/static/js/77.69d541f8.chunk.js)
- [观星盘服务契约](https://cdp.baidu.com/static/main/static/js/108.eff1a7a2.chunk.js)

| 功能 | 固定服务方法 |
| --- | --- |
| 四种拓词/组合 | `lightning/GET/KeywordSuggestService/getKeywordRecommendPassive` |
| 业务搜索 | `thunder/GET/BusinessPointService/getBusinessPointList` |
| 榜单目录/更新时间/结果 | `aigc-boost/GET/KeywordsRankService/{getBusinessPointList,getReadyDate,getKeywordList}` |
| 流量查询 | `puppet/GET/PvSearchFunction/getPvSearch` |
| 海量提交/列表 | `lightning/GET/KeywordSuggestAsynTaskService/{addKeywordSuggestAsynTask,getKeywordSuggestAsynTask}` |
| 分组文件 | `aigc-boost/GET/FileService/uploadBosFile` |
| 分组任务 | `aigc-boost/MOD/KeywordGroupAsyncService/{submitKeywordGroupTask,getKeywordGroupAsync}` |
| 分组模板 | `aigc-boost/MOD/KeywordGroupTemplateService/{getTemplateList,getTemplateDetail,addTemplate}` |
| 行业目录/下级业务/趋势/搜索词 | `xinghe-insight/POST/IndustryTrafficService/{getTradeNodeListV2,getSubTradeNodeListV2,getSearchTrend,getSearchWord}` |

拓词来源编码为种子词181、落地页182、业务183、描述生成154。关键词组合去除分页参数。竞争程度1/2/3显示高/中/低，保留原始编码；搜索量低于5按原站显示“<5”；未返回字段显示“—”。榜单 `pay/cv/pv` 分别为消费/转化/搜索指数，行业 `firstTrend/searchRate` 为趋势与增长率，均不映射为月均搜索量。来源更新时间未知时保持空值，实际采集时间单独记录。

`shared/baidu-keywords.ts`、`shared/baidu-research.ts` 提供类型与入口校验；`core/baidu-*.ts` 构造固定请求、检查响应和任务表格；`core/ipc/baidu-*.ts` 负责用例、账号锁、缓存与收录；`desktop/website-sessions.ts` 负责平台会话与传输。渲染进程不能传入任意接口路径。领域表单、附件、请求状态、结果表格分别位于 `src/traffic/baidu`。

凭据只保存在专用浏览器会话和主进程内存。凤巢使用 `CPTK_3` / `__cas__st__3`，观星盘使用 `CPTK_590`；两套请求头分别管理。令牌、Cookie、`ds/tk` 不返回渲染进程、不进入检索记录。官方窗口按已验证域名限制导航，文件下载限制HTTPS官方域名、不携带会话凭据且拒绝重定向。认证、网络、格式失败不伪装为空结果、不覆盖旧成功记录、不自动重试。

## 验证状态

已获授权并执行的真实查询仍只有一次：账号94200132，种子“网盘”，返回1472词，其中376词符合月搜索量大于10；已验证分页、跨页选择、2词词池及长期入库。本次扩展没有新增真实关键词查询或远端任务提交。

新功能的参数和返回字段依据上述官方公开模块。单元测试覆盖输入边界、固定请求、指标区分、失败保留结果、账号隔离、阈值、同词更新、低值更新和幂等任务收录。界面测试使用源码开发窗口、临时数据库、模拟官方会话与响应，拦截全部真实外部请求，覆盖六入口、目录选择、跨入口带词、提交与状态读取、下载、模板、附件恢复和1440/840px视觉检查。

新增接口尚未逐项执行真实账号查询/提交，不能把模拟验收等同于全部远端实测通过。真实联调需由用户明确触发对应查询或任务。第三方私有网页接口可能变化；结构不符时应更新契约并重新验证，不放宽校验或伪造结果。
