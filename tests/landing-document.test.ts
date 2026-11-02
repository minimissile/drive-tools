import test from "node:test";
import assert from "node:assert/strict";
import {
  documentPages,
  extractLandingDocument,
} from "../core/landing-document";
import { documentDownloadAllowed } from "../desktop/resource-document-network";
import { article, source, review } from "./resource-landing-fixture";
import { landingQuality, landingDraftSchema } from "../shared/resource-landing";

test("正文与评分是发布前提，模型总分不能掩盖单项薄弱，短而具体可以通过", () => {
  const s = source(),
    a = article();
  assert(landingDraftSchema.safeParse(a).success);
  assert.equal(a.faq.length, 0);
  assert(landingQuality(a, s, review).eligible);
  assert(
    !landingQuality(
      { ...a, description: "这是一个还没有完成的句子，目录从第" },
      s,
      review,
    ).eligible,
  );
  assert.equal(landingQuality(a, s, review).score, 92);
  assert(!landingQuality(a, { ...s, documents: [] }, review).eligible);
  assert(
    !landingQuality(a, s, { ...review, dimensions: undefined, score: 100 })
      .eligible,
  );
  assert(
    !landingQuality(a, s, {
      ...review,
      score: 100,
      dimensions: {
        evidence: 25,
        intent: 25,
        specificity: 8,
        readability: 15,
        trust: 15,
      },
    }).eligible,
  );
  a.sections[0].evidenceIds = ["doc-1-p999"];
  assert(!landingQuality(a, s, review).eligible);
});
test("文件名与宣传资料不能发起付费写作，旧版schema仍可读取但不通过新发布标准", () => {
  const a = article(),
    s = source();
  delete s.documents;
  assert(!landingQuality(a, s, review).eligible);
});
test("文本提取保留原文件指纹，拒绝格式/乱码/文字不足，抽样跨越全文", async () => {
  const bytes = Buffer.from(
    "这一段为实际文本资料，用于核验输入内容，不是根据文件名推测。".repeat(10),
  );
  const r = await extractLandingDocument("资料.md", bytes);
  assert.equal(r.pageCount, 1);
  assert.equal(r.sampled, false);
  assert.equal(r.pages[0].text, bytes.toString());
  assert.equal(r.sha256.length, 64);
  await assert.rejects(extractLandingDocument("假文件.pdf", bytes), {
    code: "DOCUMENT_INVALID",
  });
  await assert.rejects(extractLandingDocument("空.txt", Buffer.from("空白")), {
    code: "DOCUMENT_NO_TEXT",
  });
  await assert.rejects(extractLandingDocument("原文件.docx", bytes), {
    code: "DOCUMENT_FORMAT",
  });
  const pages = documentPages(104);
  assert(
    pages.includes(1) &&
      pages.includes(104) &&
      pages.some((p) => p > 45 && p < 60),
  );
  assert(pages.length <= 48);
  assert.equal(new Set(pages).size, pages.length);
});
test("签名下载只访问网盘CDN，拒绝跨账号提供方、凭据、仿冒域名与非HTTPS", () => {
  assert(
    documentDownloadAllowed(
      "quark",
      "https://dl-pc-sz.drive.quark.cn/a?signature=private",
    ),
  );
  assert(documentDownloadAllowed("quark", "https://dl-pc-zb.pds.quark.cn/a"));
  for (const url of [
    "http://dl-pc-sz.drive.quark.cn/a",
    "https://user:password@dl-pc-sz.drive.quark.cn/a",
    "https://dl-pc-sz.drive.quark.cn.evil.test/a",
    "https://127.0.0.1/a",
    "https://dl-pc-sz.drive.quark.cn:444/a",
  ])
    assert(!documentDownloadAllowed("quark", url));
  assert(
    !documentDownloadAllowed("baidu", "https://dl-pc-sz.drive.quark.cn/a"),
  );
});

function tinyPdf(value: string) {
  const stream = `BT /F1 3 Tf 50 700 Td (${value}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let data = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(data));
    data += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const start = Buffer.byteLength(data);
  data += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((o) => String(o).padStart(10, "0") + " 00000 n ")
    .join(
      "\n",
    )}\ntrailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(data);
}
test("PDF解析器提取实际文字与物理页数，空白PDF不能伪装成已读正文", async () => {
  const value =
    "This document contains a practical example of scope and responsibility. ".repeat(
      4,
    );
  const doc = await extractLandingDocument("source.pdf", tinyPdf(value));
  assert.equal(doc.pageCount, 1);
  assert(doc.pages[0].text.includes("scope and responsibility"));
  await assert.rejects(extractLandingDocument("blank.pdf", tinyPdf("")), {
    code: "DOCUMENT_NO_TEXT",
  });
});
