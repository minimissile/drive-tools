import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeWechatImageReceipt,
  describeWechatImageReceipt,
  wechatDraftCoverFields,
  WechatImageReceiptError,
} from "../desktop/wechat-upload-receipt";

const image = "https://mmbiz.qpic.cn/mmbiz_png/uploaded/0?wx_fmt=png";

test("decodes explicit CDN URL and numeric material ID", () => {
  assert.deepEqual(
    decodeWechatImageReceipt({
      base_resp: { ret: 0 },
      cdn_url: image,
      file_id: 123456,
    }),
    { url: image, id: "123456" },
  );
});

test("accepts the official content URL shape and nested explicit material fields", () => {
  assert.deepEqual(
    decodeWechatImageReceipt({
      base_resp: { ret: 0 },
      content: image,
      file_id: "123456",
    }),
    { url: image, id: "123456" },
  );
  assert.deepEqual(
    decodeWechatImageReceipt({
      base_resp: { ret: "0" },
      data: { content: { url: image, fileid: "123456" } },
    }),
    { url: image, id: "123456" },
  );
  assert.deepEqual(
    decodeWechatImageReceipt({
      base_resp: { ret: 0 },
      content: image.replace("https:", "http:"),
      data: { file_id: "123456" },
    }),
    { url: image, id: "123456" },
  );
});

test("modern URL receipts preserve the trusted image without requiring a material ID", () => {
  const observed = {
    base_resp: { ret: 0, err_msg: "ok" },
    location: "bizfile",
    type: "image",
    content: image.replace("https:", "http:"),
    cdn_url: image,
    ai_status: 0,
  };
  assert.deepEqual(decodeWechatImageReceipt(observed), { url: image });
  assert.deepEqual(
    decodeWechatImageReceipt({ ...observed, location: "123456", type: "2" }),
    { url: image },
  );
  assert.deepEqual(wechatDraftCoverFields(decodeWechatImageReceipt(observed)), {
    cdn_url0: image,
  });
  assert.deepEqual(wechatDraftCoverFields({ url: image, id: "123456" }), {
    cdn_url0: image,
    fileid0: "123456",
  });
});

test("optional IDs never come from location, URLs, generic or invalid identifier fields", () => {
  for (const extra of [
    { location: "123456", type: "2" },
    { location: image },
    { id: "123456" },
    { file_id: 0 },
    { file_id: Number.MAX_SAFE_INTEGER + 1 },
    { file_id: "invalid-id" },
  ]) {
    assert.deepEqual(
      decodeWechatImageReceipt({
        base_resp: { ret: 0 },
        cdn_url: image,
        ...extra,
      }),
      { url: image },
    );
  }
  assert.throws(
    () =>
      decodeWechatImageReceipt({
        base_resp: { ret: 0 },
        cdn_url: image,
        file_id: "123456",
        data: { fileid: "654321" },
      }),
    /存在冲突/,
  );
});

test("safe diagnostics retain short lowercase upload enums without arbitrary marker values", () => {
  const diagnostic = describeWechatImageReceipt({
    base_resp: { ret: 0 },
    location: "bizfile",
    type: "image",
    content: image,
  });
  assert.deepEqual(diagnostic.location, {
    isNumeric: false,
    length: 7,
    enum: "bizfile",
  });
  assert.equal(diagnostic.typeEnum, "image");
  const privateShape = describeWechatImageReceipt({
    base_resp: { ret: 0 },
    location: "private-value",
    type: "private-token-value",
    content: image,
  });
  assert.deepEqual(privateShape.location, { isNumeric: false, length: 13 });
  for (const secret of ["private-value", "private-token-value", image])
    assert.ok(!JSON.stringify(privateShape).includes(secret));
});

test("ret zero alone, IDs without a trusted URL and conflicting receipts never mean success", () => {
  for (const response of [
    { base_resp: { ret: 0 } },
    { base_resp: { ret: 0 }, id: "123456" },
    { base_resp: { ret: 0 }, file_id: 0 },
    {
      base_resp: { ret: 0 },
      file_id: Number.MAX_SAFE_INTEGER + 1,
    },
    {
      base_resp: { ret: 0 },
      content: image,
      file_id: "123456",
      data: { file_id: "654321" },
    },
    { base_resp: { ret: 200003 }, content: image, file_id: "123456" },
    { content: image, file_id: "123456" },
  ])
    assert.throws(
      () => decodeWechatImageReceipt(response),
      WechatImageReceiptError,
    );
});

test("rejects non-WeChat hosts, credentials, ports and non-web protocols", () => {
  for (const address of [
    "https://example.com/image.png",
    "https://user:secret@mmbiz.qpic.cn/image.png",
    "https://mmbiz.qpic.cn:8443/image.png",
    "ftp://mmbiz.qpic.cn/image.png",
  ]) {
    assert.throws(
      () =>
        decodeWechatImageReceipt({
          base_resp: { ret: 0 },
          content: address,
          file_id: "123456",
        }),
      /缺少有效图片地址/,
    );
  }
});

test("failure diagnostic contains only bounded field names and types, never response values", () => {
  let failure: WechatImageReceiptError | undefined;
  try {
    decodeWechatImageReceipt({
      base_resp: { ret: 0 },
      content: "private-response-value",
      token: "sensitive-token-value",
      cookie: "sensitive-cookie-value",
      data: { message: "private-response-value" },
    });
  } catch (error) {
    assert.ok(error instanceof WechatImageReceiptError);
    failure = error;
  }
  assert.ok(failure);
  assert.match(failure.message, /缺少有效图片地址/);
  const log = JSON.stringify(failure.diagnostic);
  assert.match(log, /content:string/);
  assert.match(log, /data.message:string/);
  for (const privateValue of [
    image,
    "sensitive-token-value",
    "sensitive-cookie-value",
    "private-response-value",
  ])
    assert.ok(!log.includes(privateValue));
  assert.deepEqual(failure.diagnostic.missing, ["image_address"]);
});
