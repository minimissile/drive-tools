import type { Platform, Resource } from "../shared/types";
const clean = (s: string) =>
  s
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/(?:提取码|访问码|密码)\s*[:：]?\s*[a-zA-Z0-9]{4,8}/g, "")
    .trim();
export function localTemplate(resource: Resource, platform: Platform) {
  const facts =
    clean(resource.summary) || "【请填写可核实的资源内容、适合人群与使用条件】";
  const sections: Record<Platform, string[]> = {
    xiaohongshu: [
      "我想解决的问题",
      "这份资料包含什么",
      "我的实际使用记录",
      "适合谁与注意事项",
    ],
    douyin: [
      "开场（0—3秒）：【一句话说明问题】",
      "演示分镜：【填写实录步骤和画面】",
      "关键提醒：【填写已核实的限制】",
      "收尾：【总结本条视频的实际收获】",
    ],
    kuaishou: [
      "开场：【用真实问题引入】",
      "操作演示：【填写画面、口播和步骤】",
      "使用结果：【填写亲自验证的结果】",
      "提醒：【说明适用条件】",
    ],
    wechat: [
      "为什么整理这份资料",
      "资料内容与适合人群",
      "使用步骤与示例",
      "限制与常见问题",
      "参考资料",
    ],
    weibo: ["一个值得记录的发现", "资料要点", "我的实测与提醒"],
    tieba: ["问题背景", "我整理的资料", "实际尝试过程", "欢迎围绕具体问题讨论"],
    douban: ["与本组主题的关系", "个人体验与资料说明", "可讨论的问题与限制"],
    x: ["要解决的问题", "最有用的一个要点", "实际验证与补充"],
    zhihu: ["先回答问题", "依据与适用条件", "可复现的步骤", "实际结果与局限"],
    csdn: [
      "环境与前置条件",
      "资料说明",
      "可复现操作步骤",
      "验证结果",
      "常见问题与参考资料",
    ],
  };
  return {
    title: clean(resource.title),
    body: `资料说明（仅依据已录入信息）：\n${facts}\n\n${sections[platform].map((s) => `## ${s}\n【请填写经核实的具体内容】`).join("\n\n")}`,
    tags: resource.tags.filter((t) => !/https?:/i.test(t)),
    coverText: "",
  };
}
