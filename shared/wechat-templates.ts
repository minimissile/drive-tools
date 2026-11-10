import { z } from "zod";

export const wechatTemplateIds = ["classic", "minimal", "ice-blue"] as const;
export const wechatTemplateSchema = z.enum(wechatTemplateIds);
export type WechatTemplateId = z.infer<typeof wechatTemplateSchema>;
export const defaultWechatTemplate: WechatTemplateId = "classic";
export interface WechatResourceAppearance {
  container: string;
  title: string;
  address: string;
  code: string;
  help: string;
}
export interface WechatTemplate {
  id: WechatTemplateId;
  name: string;
  description: string;
  bodyStyle: string;
  styles: Record<string, string>;
  resource: WechatResourceAppearance;
  sectionLayout?: {
    intro: string;
    panel: string;
    heading: string;
    headingLabel: string;
    chevrons: readonly string[];
  };
}

const classicBodyStyle =
  "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;font-size:16px;line-height:1.85;color:#283245;text-align:left;text-align-last:left;letter-spacing:0;word-break:normal;overflow-wrap:break-word;";
const classicStyles: Record<string, string> = {
  p: "margin:0 0 18px;padding:0;line-height:1.85;text-align:left;text-align-last:left;letter-spacing:0;",
  h2: "margin:28px 0 14px;font-size:22px;font-weight:700;line-height:1.5;color:#1d293d;",
  h3: "margin:26px 0 12px;font-size:20px;font-weight:700;line-height:1.5;color:#1d293d;",
  h4: "margin:22px 0 10px;font-size:18px;font-weight:600;line-height:1.5;color:#1d293d;",
  h5: "margin:20px 0 10px;font-size:17px;font-weight:600;line-height:1.5;color:#1d293d;",
  h6: "margin:20px 0 10px;font-size:16px;font-weight:600;line-height:1.5;color:#1d293d;",
  strong: "font-weight:700;color:#1d293d;",
  blockquote:
    "margin:20px 0;padding:12px 16px;background-color:#f5f7fb;color:#52627a;line-height:1.8;text-align:left;",
  ul: "margin:0 0 20px;padding-left:1.5em;list-style-type:disc;",
  ol: "margin:0 0 20px;padding-left:1.5em;list-style-type:decimal;",
  li: "margin:0 0 8px;padding-left:2px;line-height:1.85;text-align:left;",
  a: "color:#2d5edb;text-decoration:underline;word-break:break-all;letter-spacing:0;",
  img: "display:block;max-width:100%;height:auto;margin:20px auto;",
  hr: "margin:28px 0;border:0;border-top:1px solid #e0e6ef;",
  pre: "margin:20px 0;padding:14px 16px;background-color:#f5f7fb;white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:1.7;",
  code: "font-family:Menlo,Consolas,monospace;font-size:0.9em;",
};

const classicResource: WechatResourceAppearance = {
  container:
    "margin:22px 0;padding:16px 18px;border:1px solid #e0e6ef;border-radius:12px;background-color:#f7f9fc;text-align:left;text-align-last:left;letter-spacing:0;",
  title:
    "margin:0 0 10px;font-size:16px;font-weight:600;line-height:1.5;color:#1d293d;",
  address:
    "margin:0 0 10px;font-size:14px;line-height:1.7;text-align:left;text-align-last:left;letter-spacing:0;word-break:break-all;overflow-wrap:anywhere;",
  code: "margin:0 0 8px;font-size:14px;line-height:1.6;color:#52627a;",
  help: "margin:0;font-size:13px;line-height:1.6;color:#52627a;",
};

/** Stable built-in definitions. Add future templates here; selection never changes the manuscript. */
export const wechatTemplates: readonly WechatTemplate[] = [
  {
    id: "classic",
    name: "清爽卡片",
    description: "当前样式，清晰标题与浅色资源卡片。",
    bodyStyle: classicBodyStyle,
    styles: classicStyles,
    resource: classicResource,
  },
  {
    id: "minimal",
    name: "简约阅读",
    description: "黑白文字、舒展段落与简洁资源分区。",
    bodyStyle:
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;font-size:17px;line-height:1.95;color:#30343b;text-align:left;text-align-last:left;letter-spacing:0;word-break:normal;overflow-wrap:break-word;",
    styles: {
      ...classicStyles,
      p: "margin:0 0 22px;padding:0;line-height:1.95;text-align:left;text-align-last:left;letter-spacing:0;",
      h2: "margin:34px 0 18px;font-size:24px;font-weight:600;line-height:1.5;color:#20242b;",
      h3: "margin:30px 0 16px;font-size:21px;font-weight:600;line-height:1.5;color:#20242b;",
      h4: "margin:26px 0 14px;font-size:19px;font-weight:600;line-height:1.5;color:#20242b;",
      strong: "font-weight:600;color:#20242b;",
      blockquote:
        "margin:24px 0;padding:0 16px;border-left:1px solid #d8dde5;color:#59616d;line-height:1.9;text-align:left;",
      hr: "margin:32px 0;border:0;border-top:1px solid #e4e7ec;",
      ul: "margin:0 0 24px;padding-left:1.5em;list-style-type:disc;",
      ol: "margin:0 0 24px;padding-left:1.5em;list-style-type:decimal;",
      li: "margin:0 0 10px;padding-left:2px;line-height:1.95;text-align:left;",
    },
    resource: {
      ...classicResource,
      container:
        "margin:26px 0;padding:18px 0;border-top:1px solid #dfe3e9;border-bottom:1px solid #dfe3e9;background-color:#fff;text-align:left;text-align-last:left;letter-spacing:0;",
      title:
        "margin:0 0 12px;font-size:17px;font-weight:600;line-height:1.6;color:#20242b;",
      help: "margin:0;font-size:13px;line-height:1.7;color:#59616d;",
    },
  },
  {
    id: "ice-blue",
    name: "冰蓝图文",
    description: "冰蓝底色、蓝色居中标题、细线内容框与对角圆角导语。",
    bodyStyle:
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;font-size:14px;line-height:2;color:#3e3e3e;background-color:#f6fcff;padding:20px 0 1px;text-align:left;text-align-last:left;letter-spacing:2px;word-break:normal;overflow-wrap:break-word;box-sizing:border-box;",
    styles: {
      ...classicStyles,
      p: "margin:0 0 16px;padding:0;font-size:14px;line-height:2;text-align:left;text-align-last:left;letter-spacing:2px;",
      h2: "margin:26px 0 18px;font-size:18px;line-height:1.6;color:#2d699c;",
      h3: "margin:26px 0 18px;font-size:18px;line-height:1.6;color:#2d699c;",
      h4: "margin:22px 0 12px;font-size:16px;font-weight:700;line-height:1.7;color:#2d699c;",
      h5: "margin:20px 0 10px;font-size:15px;font-weight:700;line-height:1.7;color:#2d699c;",
      h6: "margin:18px 0 10px;font-size:14px;font-weight:700;line-height:1.7;color:#2d699c;",
      strong: "font-weight:700;color:inherit;",
      blockquote:
        "margin:16px 0;padding:12px 15px;background-color:#f6fcff;color:#2d699c;font-size:13px;line-height:1.9;text-align:left;letter-spacing:1px;",
      ul: "margin:0 0 16px;padding-left:1.5em;list-style-type:disc;",
      ol: "margin:0 0 16px;padding-left:1.5em;list-style-type:decimal;",
      li: "margin:0 0 10px;padding:10px 12px;background-color:#f6fcff;font-size:14px;line-height:2;text-align:left;letter-spacing:1px;",
      a: "color:#2d699c;text-decoration:underline;word-break:break-all;overflow-wrap:anywhere;letter-spacing:0;",
      img: "display:block;max-width:100%;height:auto;margin:14px auto;",
      hr: "width:95%;margin:24px auto;border:0;border-top:1px solid #6ca1c3;",
      pre: "margin:16px 0;padding:12px 15px;background-color:#f6fcff;white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.8;letter-spacing:0;",
    },
    resource: {
      container:
        "margin:18px 0 0;padding:15px;background-color:#f6fcff;text-align:left;text-align-last:left;letter-spacing:0;box-sizing:border-box;",
      title:
        "margin:0 0 10px;font-size:15px;font-weight:700;line-height:1.7;color:#2d699c;letter-spacing:1px;",
      address:
        "margin:0 0 10px;font-size:14px;line-height:1.9;text-align:left;text-align-last:left;letter-spacing:0;word-break:break-all;overflow-wrap:anywhere;",
      code: "margin:0 0 8px;font-size:13px;line-height:1.8;color:#3e3e3e;letter-spacing:0;",
      help: "margin:0;font-size:13px;line-height:1.8;color:#2d699c;letter-spacing:0;",
    },
    sectionLayout: {
      intro:
        "width:95%;margin:0 auto 24px;padding:15px;border:1px solid #6ca1c3;border-radius:20px 0;background-color:#fff;box-sizing:border-box;",
      panel:
        "width:95%;margin:0 auto 24px;padding:15px;border:1px solid #6ca1c3;background-color:#fff;box-sizing:border-box;",
      heading:
        "width:95%;margin:24px auto 20px;padding:0;font-size:18px;font-weight:700;line-height:1.6;text-align:center;text-align-last:center;letter-spacing:0;",
      headingLabel:
        "display:inline-block;max-width:calc(100% - 76px);margin:0 6px;padding:5px 16px;vertical-align:middle;background-color:#2d699c;color:#fff;font-size:18px;font-weight:700;line-height:1.6;letter-spacing:2px;overflow-wrap:anywhere;box-sizing:border-box;",
      chevrons: ["#dbeaf2", "#a9cde2", "#6ca1c3"],
    },
  },
];
export function getWechatTemplate(
  id: WechatTemplateId = defaultWechatTemplate,
) {
  return (
    wechatTemplates.find((template) => template.id === id) ?? wechatTemplates[0]
  );
}
