import test from "node:test";
import assert from "node:assert/strict";
import {
  formatWechatRewriteBody,
  prepareWechatRewriteLayout,
  wechatRewriteLayout,
} from "../core/wechat/rewrite-layout";

const paragraphs = [
  "这是用于了解自己特质的**人格测试**，结果只呈现参与者填写问卷时的选择，可结合自己的实际情况阅读，不需要把结果当作固定结论。",
  "不同的人可能对同一份结果有不同的理解。阅读介绍时，先了解资料说明，再决定是否体验，保留原文列出的条件与限制。",
  "获取方法如下：",
  "复制上方链接后，打开对应的网盘应用查阅。按页面给出的说明操作，保留原有注意事项，不把文章介绍当作结果保证。",
];
test("短文轻排版，多段正文和长文分别要求真实层次与局部重点", () => {
  assert.deepEqual(wechatRewriteLayout([{ id: 0, text: "简短的资料说明。" }]), {
    minHeadings: 0,
    minEmphasis: 0,
  });
  assert.equal(
    wechatRewriteLayout(paragraphs.map((text, id) => ({ id, text })))
      .minHeadings,
    1,
  );
  assert.equal(
    wechatRewriteLayout([{ id: 0, text: paragraphs.join("\n\n").repeat(4) }])
      .minHeadings,
    2,
  );
});
test("已有引导语自动转为小标题，不添加事实、移动图链或误改代码", () => {
  const body =
    paragraphs.slice(0, 3).join("\n\n") +
    "\n\n入口链接🔗：[查看资源](https://pan.quark.cn/s/first)\n\n" +
    paragraphs[3] +
    "\n\n![图](https://example.com/a.png)\n\n```\n说明：\n<br>\n```\n\n`<br>`";
  const formatted = formatWechatRewriteBody(body);
  assert.match(formatted, /## 获取方法如下/);
  assert.equal(formatted.replace("## 获取方法如下", "获取方法如下："), body);
  assert.equal(formatWechatRewriteBody(formatted), formatted);
});
test("只有加粗或代码里的Markdown不算正文完成分节", () => {
  const sections = paragraphs
    .filter((text) => !text.endsWith("："))
    .map((text, id) => ({ id, text }));
  const layout = wechatRewriteLayout(sections);
  assert.match(
    prepareWechatRewriteLayout(sections, layout).issues.join(""),
    /小标题/,
  );
  const withCode = [
    ...sections,
    { id: 99, text: "```\n## 代码中的标题\n**代码中的重点**\n```" },
  ];
  assert.match(
    prepareWechatRewriteLayout(withCode, layout).issues.join(""),
    /小标题/,
  );
});
