import test from "node:test";
import assert from "node:assert/strict";
import { fixture, file } from "./helpers";
import { BaiduProvider } from "../core/providers/baidu";
import type { ProviderTransport } from "../core/providers/provider";

test("新分享在满100条的首页出现时停止翻页，仍核对提取码、文件和有效期", async () => {
  const f = await fixture();
  let pages = 0,
    created = 0,
    inspected = 0;
  const own = { ...file, id: "12345" };
  const record = {
    shareId: 9988,
    fsIds: [12345],
    shortlink: "https://pan.baidu.com/s/1fresh",
    status: 0,
    expiredTime: 0,
    period: 0,
  };
  const transport: ProviderTransport = {
    text: async () =>
      'locals.mset({"shareid":9988,"share_uk":777,"loginstate":1});',
    setCookie: async () => {},
    json: async (_id, raw, init) => {
      const url = new URL(raw);
      if (url.pathname === "/api/gettemplatevariable")
        return { errno: 0, result: { uk: 777, bdstoken: "token" } };
      if (url.pathname === "/share/set") {
        created++;
        return { errno: 0, shareid: 9988, link: record.shortlink };
      }
      if (url.pathname === "/share/record") {
        pages++;
        assert.equal(
          url.searchParams.get("page"),
          "1",
          "找到目标后不应再读旧页",
        );
        return {
          errno: 0,
          list: [
            record,
            ...Array.from({ length: 99 }, (_, i) => ({
              ...record,
              shareId: i + 1,
            })),
          ],
        };
      }
      if (url.pathname === "/share/verify") {
        assert.equal(
          new URLSearchParams(String(init?.body)).get("pwd"),
          "abcd",
        );
        return { errno: 0, randsk: "fixture" };
      }
      if (url.pathname === "/share/list") {
        inspected++;
        return {
          errno: 0,
          list: [
            { fs_id: 12345, server_filename: own.name, isdir: 0, size: 120 },
          ],
        };
      }
      throw new Error(`unexpected ${url.pathname}`);
    },
  };
  try {
    const provider = new BaiduProvider(transport);
    const share = await provider.createShareWithOptions(
      f.account,
      [own],
      "资料",
      { expiresInDays: 0, extractionCode: "abcd" },
    );
    assert.equal(share.url, record.shortlink);
    assert.equal(created, 1);
    assert.equal(inspected, 1);
    assert.equal(await provider.verifyShare(f.account, "9988", [own]), true);
    assert.equal(pages, 2);
    const direct = await provider.createShareWithOptions(
      f.account,
      [own],
      "资料",
      { expiresInDays: 0, extractionCode: "abcd" },
      undefined,
      "receipt",
    );
    assert.equal(direct.url, record.shortlink);
    assert.equal(created, 2);
    assert.equal(pages, 2, "额外分享不应读取本人分享记录");
    assert.equal(inspected, 1, "额外分享不应再读取链接或比对文件");
    assert.equal(
      await provider.verifyShare(f.account, "9988", [
        { ...own, id: "different" },
      ]),
      false,
    );
  } finally {
    await f.cleanup();
  }
});
test("目标分享位于第二页时继续读取，找到即停；失效记录仍拒绝", async () => {
  const f = await fixture();
  let pages: number[] = [];
  let invalid = false;
  const provider = new BaiduProvider({
    text: async () => "",
    json: async (_id, raw) => {
      const page = Number(new URL(raw).searchParams.get("page"));
      pages.push(page);
      const list = Array.from({ length: 100 }, (_, i) => ({
        shareid: page === 2 && i === 0 ? "target" : `old-${page}-${i}`,
        fsIds: [file.id],
        status: invalid ? 1 : 0,
      }));
      return { errno: 0, list };
    },
  });
  try {
    assert.equal(await provider.verifyShare(f.account, "target", [file]), true);
    assert.deepEqual(pages, [1, 2]);
    pages = [];
    invalid = true;
    assert.equal(
      await provider.verifyShare(f.account, "target", [file]),
      false,
    );
    assert.deepEqual(pages, [1, 2]);
  } finally {
    await f.cleanup();
  }
});
