import type { Endpoint, Platform } from "./types";
export const providers = { quark: "夸克", baidu: "百度" } as const;
export const platformSpecs: {
  id: Platform;
  name: string;
  glyph: string;
  format: string;
  defaultUrl: string;
  hosts: string[];
  linkMode: "conditional" | "review" | "blocked";
  rule: string;
  ruleUrl: string;
}[] = [
  {
    id: "xiaohongshu",
    name: "小红书",
    glyph: "红",
    format: "图文笔记",
    defaultUrl: "https://creator.xiaohongshu.com/",
    hosts: ["creator.xiaohongshu.com"],
    linkMode: "blocked",
    rule: "默认不附网盘链接、提取码、私信口令或二维码；使用账号获准的官方组件。",
    ruleUrl: "https://school.xiaohongshu.com/",
  },
  {
    id: "douyin",
    name: "抖音",
    glyph: "抖",
    format: "口播与分镜脚本",
    defaultUrl: "https://creator.douyin.com/",
    hosts: ["creator.douyin.com"],
    linkMode: "blocked",
    rule: "先提供实用内容；资源获取只使用账号获准的站内组件。",
    ruleUrl: "https://developer.open-douyin.com/",
  },
  {
    id: "kuaishou",
    name: "快手",
    glyph: "快",
    format: "短视频脚本",
    defaultUrl: "https://cp.kuaishou.com/",
    hosts: ["cp.kuaishou.com"],
    linkMode: "blocked",
    rule: "不将评论、谐音或私信当作绕开导流规则的入口。",
    ruleUrl: "https://www2.kuaishou.com/norm?tab=community",
  },
  {
    id: "wechat",
    name: "公众号",
    glyph: "微",
    format: "教程文章",
    defaultUrl: "https://mp.weixin.qq.com/",
    hosts: ["mp.weixin.qq.com"],
    linkMode: "review",
    rule: "分别核实正文链接、阅读原文及回复能力；不得诱导转发或强制关注。",
    ruleUrl:
      "https://weixin.qq.com/agreement/weixin_external_links_content_management_specification",
  },
  {
    id: "weibo",
    name: "微博",
    glyph: "博",
    format: "短文与话题",
    defaultUrl: "https://weibo.com/",
    hosts: ["weibo.com", "www.weibo.com"],
    linkMode: "conditional",
    rule: "相关链接仍受域名审核和营销规则限制；避免重复灌链接。",
    ruleUrl: "https://m.weibo.cn/outlink_rules.html",
  },
  {
    id: "tieba",
    name: "百度贴吧",
    glyph: "贴",
    format: "主题讨论帖",
    defaultUrl: "https://tieba.baidu.com/",
    hosts: ["tieba.baidu.com"],
    linkMode: "review",
    rule: "先确认具体吧规、主题及发布区，未核实不附网盘链接。",
    ruleUrl: "https://tieba.baidu.com/tb/zt/notice.html",
  },
  {
    id: "douban",
    name: "豆瓣",
    glyph: "豆",
    format: "主题讨论",
    defaultUrl: "https://www.douban.com/group/",
    hosts: ["www.douban.com", "douban.com"],
    linkMode: "blocked",
    rule: "默认关闭营销式导流；真实讨论须遵守小组和社区规则。",
    ruleUrl: "https://www.douban.com/about/guideline",
  },
  {
    id: "x",
    name: "X / Twitter",
    glyph: "𝕏",
    format: "短帖或线程",
    defaultUrl: "https://x.com/compose/post",
    hosts: ["x.com"],
    linkMode: "conditional",
    rule: "只使用相关、安全的资源链接；不得重复刷屏或诱骗跳转。",
    ruleUrl: "https://help.x.com/en/rules-and-policies/authenticity",
  },
  {
    id: "zhihu",
    name: "知乎",
    glyph: "知",
    format: "回答或文章",
    defaultUrl: "https://zhuanlan.zhihu.com/",
    hosts: ["zhuanlan.zhihu.com", "www.zhihu.com"],
    linkMode: "review",
    rule: "完整回答问题，区分参考引用与资源营销，确认账号场景权限。",
    ruleUrl: "https://www.zhihu.com/knowledge-plan/manual",
  },
  {
    id: "csdn",
    name: "CSDN",
    glyph: "C",
    format: "技术教程",
    defaultUrl: "https://editor.csdn.net/",
    hosts: ["editor.csdn.net"],
    linkMode: "review",
    rule: "正文提供可复现步骤；推广使用获准功能，不强塞第三方营销链接。",
    ruleUrl: "https://blog.csdn.net/blogdevteam",
  },
];
export const endpointSpecs: Record<
  Endpoint,
  { name: string; path: string; unit: string; referenceUrl: string }
> = {
  longtail: {
    name: "海量长尾词 v2",
    path: "/keyword/word/v2",
    unit: "关键词 × 页",
    referenceUrl:
      "https://www.5118.com/apistore/detail/8cf3d6ed-2b12-ed11-8da8-e43d1a103141/-1",
  },
  suggest: {
    name: "下拉联想词",
    path: "/suggest/list",
    unit: "关键词 × 平台",
    referenceUrl:
      "https://www.5118.com/apistore/detail/597e2193-9490-eb11-8daf-e4434bdf6706/-1",
  },
  metrics: {
    name: "关键词搜索量 v2",
    path: "/keywordparam/v2",
    unit: "关键词",
    referenceUrl:
      "https://www.5118.com/apistore/detail/90f3d6ed-2b12-ed11-8da8-e43d1a103141/-1",
  },
  radar: {
    name: "热点雷达",
    path: "/radar",
    unit: "每页最多 10 条",
    referenceUrl:
      "https://www.5118.com/apistore/detail/2b74bf4d-1750-e811-80c9-1866da4dbcc0/-1",
  },
};
