import {
  defaultWechatCoverVariant,
  defaultWechatImageStyle,
  wechatImageStyleSchema,
  wechatUnifiedCover,
  type WechatCoverVariant,
  type WechatImageStyle,
} from "../../shared/wechat-image-styles";
import type { WechatImageGenerationMode } from "../../shared/wechat";

const styleInstructions: Record<WechatImageStyle, string> = {
  natural:
    "当前风格：自然重绘。延续原图的真实感和自然材质，用新的取景与光影组织主体，色彩克制，细节可信，避免夸张滤镜。",
  vivid:
    "当前风格：吸睛增强。以原图主体为基础重新构图，建立更鲜明的视觉焦点，采用有层次的明暗、立体的侧光或逆光、协调的冷暖对比与更简洁的背景，增强画面张力和第一眼的吸引力。保持原有画面类型与自然质感，不过度饱和，不做夸张特效，不用大字海报吸引注意。",
};

const coverArtDirection: Record<WechatCoverVariant, string> = {
  "cream-stationery":
    "奶油手账：温暖奶油白 #FFF7E3 作底，有轻微纸纹和叠层的浅黄、浅蓝剪纸。标题采用亮黄字面和蓝描边，投下柔和短阴影。右侧主图是带浅蓝贴纸边的立体手账插画，日光柔和，质感偏陶瓷或纸卡，装饰少量点缀。",
  "sky-blue":
    "晴空蓝：明亮晴空蓝 #2EBDEF 作主背景，白色弧形和轻薄云朵只在边缘留白处。标题第一行用浅暖黄，第二行用奶白，两行都有同样的深钴蓝描边和短立体投影。右侧是带清晰反光的蓝色或半透明浅蓝立体主图，点缀极少量亮黄，用清爽的日光表现质感。",
  "lemon-pop":
    "亮黄波普：柠檬黄 #FFDA19 作大底，右侧用饱和钴蓝圆形衬托主图。标题字面亮黄，深蓝描边和较厚的立体投影，行间紧凑但字形清楚。右侧的蓝黄物件采用稍倾斜的立体构图。边角可点缀细网点或星芒，远离标题和主图。",
};

const watermarkInstruction =
  "输出限制：忽略原图中的水印信息。水印、署名、账号名、品牌标志、角标和二维码都不属于画面内容，不得复刻、改写或添加类似标记。补充的画面描述也须遵守这项限制。";

export function wechatImagePrompt(input: {
  title: string;
  mode?: WechatImageGenerationMode;
  style?: WechatImageStyle;
  coverVariant?: WechatCoverVariant;
  description?: string;
}) {
  if (input.mode === wechatUnifiedCover.id) {
    const { width, height } = wechatUnifiedCover.size;
    return [
      `创作公众号系列封面，一张 ${width} × ${height} 像素头条横图（约 2.35:1）。文章主题为《${input.title}》。`,
      input.description ? `主体补充：${input.description}。` : "",
      "参考样稿只提供版式、色板、字体质感、描边厚度、插画材质和光线。保持样稿里文字与插画的面积、位置和视觉层级。根据本篇主题重新绘制标题和物件。不要引用样稿里的旧标题、数字、物件、账号或标志。",
      "固定左文右图。左侧约六成排醒目的大标题，右侧放一组与文章直接相关的立体主图。轮廓饱满，四周至少留约 4% 安全边距。背景和主图的明暗保持轻快通透，不用大面积深蓝渐变，也不模拟一张屏幕截图。",
      coverArtDirection[input.coverVariant ?? defaultWechatCoverVariant],
      "从文章标题中提炼一个封面短标题，优先保留主题名和最关键的词，避免整句照抄。用醒目的简体中文粗圆字，一到两行，每行尽量不超过七个汉字。所有文字都必须依据文章标题。白色胶囊最多写一条简短补充，且只写主标题没有表达过的信息。没有必要的补充就留空，不添加副标题、促销话术或虚构日期。",
      "右侧选择一个最能说明主题的物件，必要时加一个靠拢的配角。用有圆角、厚度、亮面和柔和落影的 3D 插画，同一组只保留一个视觉重点。画面右侧不出现文字、日期、菜单、软件窗口、指针或仿制界面。主图轮廓完整，留出裁成 1:1 方形缩略图所需的余量。",
      watermarkInstruction,
    ]
      .filter(Boolean)
      .join("\n");
  }
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
  return [instruction, watermarkInstruction].join("\n");
}
