import type { WechatTemplate } from "./wechat-templates";

/** Only escaped, app-generated block markup reaches this layout. Headings are
 * top-level siblings; code and quoted markup are already escaped by articleHtml. */
export function layoutWechatTemplate(
  html: string,
  layout: NonNullable<WechatTemplate["sectionLayout"]>,
) {
  const panel = (content: string, style: string) =>
    content.trim()
      ? `<section style="${style}">${content.trim()}</section>`
      : "";
  const arrows = (reverse = false) =>
    [...(reverse ? [...layout.chevrons].reverse() : layout.chevrons)]
      .map(
        (color) =>
          `<span aria-hidden="true" style="display:inline-block;width:0;height:0;margin:0 2px;vertical-align:middle;border-top:6px solid transparent;border-bottom:6px solid transparent;border-${reverse ? "right" : "left"}:6px solid ${color};"></span>`,
      )
      .join("");
  let result = "",
    offset = 0,
    hasHeading = false;
  for (const match of html.matchAll(/<h([23])\b[^>]*>([\s\S]*?)<\/h\1>/g)) {
    result += panel(
      html.slice(offset, match.index),
      hasHeading ? layout.panel : layout.intro,
    );
    // Links in a heading must remain readable on its blue label.
    const content = match[2].replace(
      /(<a\b[^>]*?) style="[^"]*"/g,
      '$1 style="color:inherit;text-decoration:underline;word-break:break-all;letter-spacing:0;"',
    );
    result += `<h${match[1]} style="${layout.heading}">${arrows()}<span style="${layout.headingLabel}">${content}</span>${arrows(true)}</h${match[1]}>`;
    offset = match.index! + match[0].length;
    hasHeading = true;
  }
  return (
    result + panel(html.slice(offset), hasHeading ? layout.panel : layout.intro)
  );
}
