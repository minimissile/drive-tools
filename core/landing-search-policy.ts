import type { LandingSource } from "../shared/resource-landing";

export { landingSearchPolicyVersion } from "../shared/resource-landing";

export const landingSearchInstruction = `
搜索与AI引用的编辑要求（盘序中文资源站）：
先明确资源身份、一个主要查找意图与材料能回答的实际问题，再写正文。searchBrief只描述已知资料和候选意图，不是搜索量或排名研究，不要把候选问题全部扩写成章节。
首段应直接解释这份资料是什么、包含什么、适合哪种需求；避免先写情绪引子或主题百科。标题、摘要、首段及正文必须兑现同一内容承诺。下载、内容预览与使用建议是不同意图，不能用泛化攻略替代文件介绍。
每个事实段落应能在保持资源名称、适用条件、限制及引用的情况下单独被理解。代词不清时补明对象；必要条件紧跟结论，避免AI抽取后把局限变成确定承诺。优先清楚自然的中文，不强求40–60英文单词、固定问句、表格、三步法或FAQ。
使用实际正文中的章节、条目、例子和可定位主题解释此资源的独有价值。只有证据支持时才写数量、版本、作者或比较；不为了GEO塞入无关统计、专家语录、外部权威包装或虚构实测。引用仅使用已提供的evidenceIds，不生成链接。
信息不足、正文抽样、文件格式与获取限制应在相关判断处交代。不要把抽样中未见的内容写成全书不存在；不声称已验证下载效果或全部观点正确。不重复模板已有的按钮、登录说明、更新日期与免责声明。
已有内容能准确满足需求时做最小必要修改，不为了“新鲜度”重写或改日期。不承诺AI引用、收录、排名或流量，不把llms.txt、FAQ标记、关键词密度或内部评分当作流量保证。`;

export const landingSearchReviewInstruction = `
搜索与AI引用检查必须影响intent、specificity、readability与trust：
1. 标题和摘要的承诺是否在正文兑现，首段是否准确识别资源与适用需求；只有点击诱因但资源身份不清，应修订。
2. 内容是否帮助决定是否需要这份资料，并能定位实际内容；大部分换个同类资源名称仍成立，specificity不能达标。
3. 可被摘取的关键结论是否带着对象、必要条件、适用范围和正确依据；脱离上下文就误导的断言应修订，不要求每页都写问答。
4. 数字、作者、效果、比较、版权、版本与获取承诺是否有证据；缺少证据列入unsupportedClaims，不允许靠“权威口吻”通过。
不把FAQ、表格、固定字数、训练爬虫放行或AI专用文件当作通过条件。评分仅是内部内容审阅，不评价实际搜索收录或流量。`;

export function landingSearchBrief(source: LandingSource) {
  const formats = [
    ...new Set(
      source.files
        .filter((f) => !f.directory)
        .map((f) => f.name.match(/\.([a-z0-9]+)$/i)?.[1].toUpperCase())
        .filter(Boolean),
    ),
  ];
  return {
    resource: source.resourceTitle,
    category: source.category,
    formats,
    topics: source.tags,
    primaryIntent: "先判断资源内容与适用性，再决定是否前往网盘获取",
    readerNeeds: [
      "具体包含哪些内容",
      "什么需求适合使用，哪些需求不适合",
      "有哪些可定位的内容及真实获取限制",
    ],
    readingScope: (source.documents ?? []).map((d) => ({
      file: d.name,
      sampled: d.sampled,
      extractedSegments: d.pages.length,
      ...(d.name.toLowerCase().endsWith(".pdf")
        ? { physicalPages: d.pageCount }
        : {}),
    })),
    demandEvidence: "尚无此资源的搜索量数据；不能标为高流量或保证需求",
  };
}
