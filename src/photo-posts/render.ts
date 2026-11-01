import { photoRetrievalSteps, type PhotoForm } from "../../shared/photo-posts";
import { arrow, fillBox, imageContain, paintText, type Box } from "./canvas";

const width = 1080,
  height = 1440;
const palettes = {
  blue: {
    ground: "#203FE8",
    ink: "#FFFFFF",
    accent: "#F0FF76",
    onAccent: "#172C98",
    paper: "#F5F4EC",
    body: "#17234E",
    muted: "#C7D2FF",
  },
  warm: {
    ground: "#FFF2D8",
    ink: "#26241E",
    accent: "#BC2F23",
    onAccent: "#FFF2D8",
    paper: "#FFFAEF",
    body: "#352820",
    muted: "#735A47",
  },
};

/** The same canvases are previewed and exported; resource claims and phrases stay user-authored. */
export function renderPhotoCard(
  canvas: HTMLCanvasElement,
  index: number,
  form: PhotoForm,
  drive: string,
  cover?: HTMLImageElement | null,
) {
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw Error("当前环境无法绘制图片，请重启工作台后重试。");
  const colors = palettes[form.theme];
  const problems: string[] = [];
  const draw = (
    text: string,
    box: Box,
    options: Parameters<typeof paintText>[3],
    label: string,
  ) => {
    if (!paintText(ctx, text, box, options))
      problems.push(`${label}过长，请精简文字或调整换行后导出`);
  };
  const footer = (text: string, color: string) => {
    paintText(
      ctx,
      text,
      { x: 64, y: 1360, width: 780, height: 44 },
      { size: 26, color },
    );
    paintText(
      ctx,
      `${index + 1} / 3`,
      { x: 926, y: 1360, width: 100, height: 44 },
      { size: 26, color },
    );
  };
  fillBox(ctx, { x: 0, y: 0, width, height }, colors.ground);

  if (index === 0) {
    const title = form.title || "在这里写下\n资源的亮点";
    const emphasis = form.emphasis?.trim();
    if (emphasis && !form.title.includes(emphasis))
      problems.push("封面重点词需与标题中的原文一致");
    const poster = !!cover && form.coverStyle !== "type";
    if (poster) {
      const portrait = cover.naturalWidth / cover.naturalHeight < 0.95;
      imageContain(
        ctx,
        cover,
        portrait
          ? { x: 0, y: 0, width: 720, height: 1120 }
          : { x: 0, y: 0, width, height: 870 },
      );
      draw(
        title,
        portrait
          ? { x: 760, y: 64, width: 256, height: 1040 }
          : { x: 64, y: 910, width: 952, height: 240 },
        {
          size: portrait ? 206 : 132,
          min: 64,
          leading: 1.12,
          headline: true,
          color: colors.ink,
          centerY: true,
          emphasis,
          highlight: colors.accent,
          highlightLast: true,
        },
        "封面标题",
      );
      fillBox(ctx, { x: 64, y: 1184, width: 952, height: 120 }, colors.accent);
      draw(
        form.subtitle || "内容清单与获取方式，见后两页",
        { x: 92, y: 1204, width: 896, height: 82 },
        {
          size: 40,
          min: 26,
          leading: 1.25,
          weight: 600,
          color: colors.onAccent,
        },
        "封面亮点",
      );
    } else {
      draw(
        title,
        { x: 64, y: 104, width: 952, height: 726 },
        {
          size: 280,
          min: 84,
          leading: 1.12,
          headline: true,
          color: colors.ink,
          centerY: true,
          emphasis,
          highlight: colors.accent,
          highlightLast: true,
        },
        "封面标题",
      );
      fillBox(ctx, { x: 64, y: 888, width: 952, height: 226 }, colors.accent);
      draw(
        form.subtitle || "内容清单与获取方式\n往后翻，一次看明白",
        { x: 100, y: 922, width: 880, height: 164 },
        {
          size: 56,
          min: 30,
          leading: 1.3,
          weight: 600,
          color: colors.onAccent,
        },
        "封面亮点",
      );
      if (form.audience)
        draw(
          `适合 ${form.audience}`,
          { x: 68, y: 1150, width: 944, height: 108 },
          {
            size: 34,
            min: 24,
            leading: 1.35,
            color: colors.ink,
          },
          "适合人群",
        );
      paintText(
        ctx,
        "向左滑，看内容与领取方式",
        { x: 68, y: 1284, width: 836, height: 52 },
        { size: 34, weight: 600, color: colors.ink },
      );
      arrow(ctx, 946, 1306, colors.ink);
    }
    footer(`${drive} · 资源分享`, colors.muted);
  } else if (index === 1) {
    fillBox(ctx, { x: 0, y: 0, width, height }, colors.paper);
    draw(
      "这份资源\n包含什么？",
      { x: 64, y: 72, width: 952, height: 282 },
      {
        size: 120,
        leading: 1.08,
        headline: true,
        color: colors.body,
        emphasis: "包含什么？",
        highlight: form.theme === "blue" ? colors.ground : colors.accent,
      },
      "详情标题",
    );
    const entries = (
      form.details || "请填写已核实的内容清单、格式、版本与用途。"
    )
      .split(/\n+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (entries.length >= 2 && entries.length <= 6) {
      const rowHeight = Math.min(230, 804 / entries.length);
      entries.forEach((entry, i) => {
        const y = 416 + i * rowHeight;
        fillBox(
          ctx,
          { x: 64, y: y - 16, width: 952, height: 2 },
          form.theme === "blue" ? "#CFD3E0" : "#DDCBB8",
        );
        paintText(
          ctx,
          String(i + 1).padStart(2, "0"),
          { x: 64, y: y + 6, width: 84, height: 80 },
          {
            size: 52,
            headline: true,
            color: form.theme === "blue" ? colors.ground : colors.accent,
          },
        );
        draw(
          entry,
          { x: 184, y: y + 8, width: 832, height: rowHeight - 42 },
          {
            size: 52,
            min: 26,
            leading: 1.45,
            weight: 600,
            color: colors.body,
          },
          `第${i + 1}项资源详情`,
        );
      });
    } else {
      draw(
        form.details || entries[0],
        { x: 64, y: 414, width: 952, height: 806 },
        {
          size: 48,
          min: 24,
          leading: 1.48,
          color: colors.body,
        },
        "资源详情",
      );
    }
    if (form.audience)
      draw(
        `适合 ${form.audience}`,
        { x: 64, y: 1260, width: 952, height: 82 },
        {
          size: 30,
          min: 22,
          leading: 1.3,
          color: colors.body,
        },
        "适合人群",
      );
    footer("下一页，查看领取方式", colors.body);
  } else {
    draw(
      "资源这样领",
      { x: 64, y: 92, width: 952, height: 190 },
      {
        size: 156,
        leading: 1.12,
        headline: true,
        color: colors.ink,
      },
      "获取标题",
    );
    paintText(
      ctx,
      `在${drive} App 中领取`,
      { x: 68, y: 280, width: 944, height: 65 },
      { size: 42, color: colors.ink },
    );
    fillBox(ctx, { x: 56, y: 390, width: 968, height: 616 }, colors.paper);
    const steps = photoRetrievalSteps(form, drive);
    if (form.retrieval === "search") steps[1] = "在搜索框输入下方完整口令";
    const headings =
      form.retrieval === "search"
        ? ["打开网盘", "搜索口令", "确认并保存"]
        : ["分享作品", "复制链接", "打开网盘"];
    steps.forEach((step, i) => {
      const y = 430 + i * 190;
      const accent = form.theme === "blue" ? colors.ground : colors.accent;
      paintText(
        ctx,
        String(i + 1).padStart(2, "0"),
        { x: 88, y, width: 94, height: 100 },
        { size: 64, headline: true, color: accent },
      );
      draw(
        headings[i],
        { x: 220, y, width: 760, height: 80 },
        { size: 54, weight: 700, color: colors.body },
        `第${i + 1}步标题`,
      );
      draw(
        step,
        { x: 220, y: y + 83, width: 750, height: 100 },
        { size: 34, min: 26, leading: 1.4, color: colors.body },
        `第${i + 1}步`,
      );
    });
    fillBox(ctx, { x: 56, y: 1046, width: 968, height: 238 }, colors.accent);
    paintText(
      ctx,
      form.retrieval === "search"
        ? "中文口令 · 原样输入"
        : "文案领取口令 · 完整保留",
      { x: 92, y: 1075, width: 896, height: 45 },
      { size: 28, color: colors.onAccent },
    );
    draw(
      form.passphrase || "待填写中文口令",
      { x: 92, y: 1135, width: 896, height: 124 },
      { size: 68, min: 24, leading: 1.25, weight: 700, color: colors.onAccent },
      "中文口令",
    );
    footer("请先核对资源名称，再保存到自己的网盘", colors.muted);
  }
  return problems;
}
