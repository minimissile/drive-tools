export const contentFormats = {
  text: "文字",
  image: "AI 图片",
  carousel: "图文组图",
  video: "AI 动态视频",
} as const;
export const studioRatios = ["3:4", "1:1", "9:16", "16:9", "4:5"] as const;
export const builtinCreativeTemplates = [
  {
    id: "resource-guide",
    name: "资料推荐",
    description: "适合人群 → 资料亮点 → 使用场景",
    style: "明亮的编辑式设计，留白清晰，蓝色重点，资料展示真实克制",
    instruction:
      "围绕资料的已知内容、适合人群、具体使用场景和适用边界组织推荐，不捏造亲测体验。",
    accent: "#3567cf",
    builtin: true,
  },
  {
    id: "steps",
    name: "步骤教学",
    description: "提出问题 → 分步讲解 → 操作提醒",
    style: "清楚的步骤编号，简洁示意，浅色背景，青绿色点缀",
    instruction:
      "用清楚的顺序介绍学习或使用方法。没有实际操作依据的步骤须标注待验证，不能伪造软件截图。",
    accent: "#278473",
    builtin: true,
  },
  {
    id: "checklist",
    name: "清单合集",
    description: "分类梳理 → 重点清单 → 选择建议",
    style: "整齐的清单和分类卡片，暖白底色，橘色强调，信息易读",
    instruction:
      "把已知资料要点组织成清单，控制每页信息密度，给出明确的选择条件。",
    accent: "#b97a36",
    builtin: true,
  },
  {
    id: "question",
    name: "问题解答",
    description: "常见困惑 → 直接回答 → 依据与限制",
    style: "问答式编辑排版，深蓝与白色，关键答案突出",
    instruction:
      "以目标受众真实的问题开场，直接回答并说明依据和不确定项，不制造焦虑。",
    accent: "#263e70",
    builtin: true,
  },
  {
    id: "scenario",
    name: "场景故事",
    description: "情境引入 → 资料用途 → 下一步",
    style: "自然光，可信的生活或工作场景，柔和绿色，细腻的景深",
    instruction:
      "用明确标为示例的场景说明资料如何帮助完成任务，不把虚构人物经历写成真实用户反馈。",
    accent: "#637e57",
    builtin: true,
  },
  {
    id: "cinematic",
    name: "动态展示",
    description: "视觉开场 → 主题镜头 → 简洁收尾",
    style:
      "有质感的实景或概念化画面，柔和光线，缓慢推进与自然镜头运动，画面统一",
    instruction:
      "用真正的动态画面表达资源主题和使用情境，明确主体、动作、镜头运动与转场；不要把静态轮播描述成动态视频。",
    accent: "#795d80",
    builtin: true,
  },
] as const;
