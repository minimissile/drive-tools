import test from "node:test";
import assert from "node:assert/strict";
import { decodeWechatDraftReceipt } from "../desktop/wechat-draft-receipt";

test("微信保存成功回执和有效草稿编号即为完成依据", () => {
  for (const key of ["appMsgId", "appmsgid", "appmsg_id"]) {
    for (const value of ["100000035", 100000035]) {
      const receipt = decodeWechatDraftReceipt({
        base_resp: { ret: 0 },
        [key]: value,
      });
      assert.equal(receipt.draftId, "100000035");
      const url = new URL(receipt.url);
      assert.equal(url.origin, "https://mp.weixin.qq.com");
      assert.equal(url.searchParams.get("appmsgid"), "100000035");
      assert.equal(url.searchParams.has("token"), false);
    }
  }
  assert.equal(
    decodeWechatDraftReceipt({ base_resp: { ret: 0 } }, "100000035").draftId,
    "100000035",
    "更新原稿时，成功回执可沿用本次请求的原草稿编号",
  );
  const longId = "123456789012345678901234567890";
  assert.equal(
    decodeWechatDraftReceipt({ base_resp: { ret: 0 }, appMsgId: longId })
      .draftId,
    longId,
  );
});

test("只有编号、错误状态、无编号和更新错稿均不能冒充保存成功", () => {
  for (const response of [
    { appMsgId: "100000035" },
    { base_resp: { ret: -1 }, appMsgId: "100000035" },
    { base_resp: { ret: "0" }, appMsgId: "100000035" },
    { base_resp: { ret: 0 } },
    ...["", "0", "-1", "1.5", "x100", "1".repeat(31), {}, true, 1e20].map(
      (appMsgId) => ({ base_resp: { ret: 0 }, appMsgId }),
    ),
  ])
    assert.throws(() => decodeWechatDraftReceipt(response), {
      code: "WECHAT_DRAFT_UNCERTAIN",
    });
  assert.throws(
    () =>
      decodeWechatDraftReceipt(
        { base_resp: { ret: 0 }, appMsgId: "100000036" },
        "100000035",
      ),
    { code: "WECHAT_DRAFT_UNCERTAIN" },
  );
  assert.throws(
    () => decodeWechatDraftReceipt({ base_resp: { ret: -1 } }, "100000035"),
    { code: "WECHAT_DRAFT_UNCERTAIN" },
  );
});
