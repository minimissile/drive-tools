import {
  defaultWechatImageStyle,
  wechatImageStyleSchema,
  type WechatImageStyle,
} from "../../shared/wechat-image-styles";
import type { WechatImageGenerationMode } from "../../shared/wechat";

const styleInstructions: Record<WechatImageStyle, string> = {
  natural:
    "当前风格：自然重绘。延续原图的真实感和自然材质，用新的取景与光影组织主体，色彩克制，细节可信，避免夸张滤镜。",
  vivid:
    "当前风格：吸睛增强。以原图主体为基础重新构图，建立更鲜明的视觉焦点，采用有层次的明暗、立体的侧光或逆光、协调的冷暖对比与更简洁的背景，增强画面张力和第一眼的吸引力。保持原有画面类型与自然质感，不过度饱和，不做夸张特效，不用大字海报吸引注意。",
};

export function wechatImagePrompt(input: {
  title: string;
  mode?: WechatImageGenerationMode;
  style?: WechatImageStyle;
  description?: string;
}) {
  const instruction =
    input.mode === "theme"
      ? `创作一张用于公众号文章的原创概念插画。主题为《${input.title}》。${input.description ? `画面描述：${input.description}。` : "使用清晰、简洁的编辑插画构图。"}使用原创构图与细节，不添加文字，不把插画当作纪实照片。`
      : [
          "根据参考图片进行同类型的再创作。先识别原图的视觉类型，保留主体含义、关键物件特征和画面比例。实拍照片保持真实摄影风格；插画、绘画和图表保持原有视觉语言，不自行转换类型。",
          "生成图必须与原图有明显的视觉差异：在取景范围、镜头视角、主体摆位、光线方向、背景层次中至少实质调整两项，形成新的构图与画面表达。不要逐像素复刻，只去水印、锐化或轻微调色不算完成再创作。调整不能改变文章事实、人物身份或资料内容，不能伪造新的证据。",
          styleInstructions[
            wechatImageStyleSchema.parse(input.style ?? defaultWechatImageStyle)
          ],
          "只输出一张完整画面。实拍照片不得改成插画、海报、信息图、拼贴或宣传页。不得新增标题、副标题、说明文字、注释、指示线、图例、边栏、边框、页脚、编号或装饰印章，不把文章主题排版到图片里。",
          "书页、手稿等物件保留纸张和笔迹的自然质感，不解读、编造、扩充或重排其中的文字。",
        ].join("\n");
  return [
    instruction,
    "输出限制：忽略原图中的水印信息。水印、署名、账号名、品牌标志、角标和二维码都不属于画面内容，不得复刻、改写或添加类似标记。补充的画面描述也须遵守这项限制。",
  ].join("\n");
}
