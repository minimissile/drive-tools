import test from "node:test";
import assert from "node:assert/strict";
import {
  initialWechatIdentity,
  staleWechatIdentity,
} from "../desktop/wechat-login-state";
import {
  assertWechatImagePixels,
  wechatComparisonImageBytes,
} from "../desktop/wechat-image-content";
import type { WebsiteAccount } from "../shared/website-accounts";
const account: WebsiteAccount = {
  id: "web_cached",
  provider: "wechat",
  alias: "公众号",
  nickname: "已登录账号",
  uid: "gh_cached123",
  status: "connected",
  createdAt: "2026-11-08",
  updatedAt: "2026-11-08",
};
test("应用重开和Cookie轮换只要求后台核验身份，不误判已保存登录过期", () => {
  const initial = initialWechatIdentity(account);
  assert.equal(initial.unverified, true);
  assert.equal(initial.hasSession, false);
  assert.notEqual(initial.expired, true);
  const refreshed = staleWechatIdentity({
    hasSession: true,
    uid: account.uid,
    nickname: account.nickname,
    checkedAt: "known",
    windowOpen: false,
    error: null,
  });
  assert.equal(refreshed.unverified, true);
  assert.notEqual(refreshed.expired, true);
  assert.equal(refreshed.nickname, account.nickname);
  assert.equal(refreshed.checkedAt, "known");
  assert.equal(
    initialWechatIdentity({ ...account, status: "expired" }).expired,
    true,
  );
  assert.notEqual(
    initialWechatIdentity({ ...account, uid: null, status: "disconnected" })
      .unverified,
    true,
  );
});
test("封面CDN迁移只有在尺寸和解码像素完全一致时通过", () => {
  const image = (data: number[], width = 1, height = 1) => ({
    isEmpty: () => !data.length,
    getSize: () => ({ width, height }),
    toBitmap: () => Buffer.from(data),
  });
  assert.doesNotThrow(() =>
    assertWechatImagePixels(image([1, 2, 3, 255]), image([1, 2, 3, 255])),
  );
  for (const changed of [
    image([1, 2, 4, 255]),
    image([1, 2, 3, 255], 2),
    image([]),
  ])
    assert.throws(
      () => assertWechatImagePixels(image([1, 2, 3, 255]), changed),
      { code: "WECHAT_IMAGE_MISMATCH" },
    );
  assert.throws(
    () =>
      assertWechatImagePixels(
        {
          ...image([1]),
          getSize: () => ({ width: 10000, height: 10000 }),
          toBitmap: () => {
            throw Error("不应解码超大图");
          },
        },
        image([1]),
      ),
    { code: "WECHAT_IMAGE_MISMATCH" },
  );
});

test("PNG比较仅排除色彩解释元数据，保留图像数据和方向信息", () => {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunk = (type: string, data = Buffer.alloc(0)) => {
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    return Buffer.concat([size, Buffer.from(type), data, Buffer.alloc(4)]);
  };
  const header = chunk("IHDR", Buffer.alloc(13)),
    pixels = chunk("IDAT", Buffer.from("image-pixels")),
    orientation = chunk("orNT", Buffer.from([0])),
    end = chunk("IEND");
  const image = Buffer.concat([
    signature,
    header,
    chunk("gAMA", Buffer.from([1, 2, 3, 4])),
    chunk("cHRM", Buffer.alloc(32)),
    orientation,
    pixels,
    end,
  ]);
  assert.deepEqual(
    wechatComparisonImageBytes(image),
    Buffer.concat([signature, header, orientation, pixels, end]),
  );
  assert.deepEqual(
    wechatComparisonImageBytes(Buffer.from("jpeg")),
    Buffer.from("jpeg"),
  );
  const truncated = image.subarray(0, image.length - 4);
  assert.deepEqual(wechatComparisonImageBytes(truncated), truncated);
});
