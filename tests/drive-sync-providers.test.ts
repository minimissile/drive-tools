import test from "node:test";
import assert from "node:assert/strict";
import { QuarkProvider } from "../core/providers/quark";
import { UcProvider } from "../core/providers/uc";
import { BaiduProvider } from "../core/providers/baidu";
import { XunleiProvider } from "../core/providers/xunlei";
import { PikPakProvider } from "../core/providers/pikpak";
import { GuangyaProvider } from "../core/providers/guangya";
import type { ProviderTransport } from "../core/providers/provider";
import type { Account } from "../shared/types";

test("六家网盘整盘读取统一分页、保留父目录和账号传输，读完才终止", async () => {
  const calls: { account: string; url: URL; init?: RequestInit }[] = [];
  const transport: ProviderTransport = {
    text: async () => "",
    authHeaders: async () => ({ authorization: "Bearer fixture" }),
    json: async (account, address, init) => {
      const url = new URL(address);
      calls.push({ account, url, init });
      if (url.pathname.endsWith("file/sort")) {
        const page = Number(url.searchParams.get("_page"));
        return {
          code: 0,
          metadata: { _total: 101 },
          data: {
            list: Array.from({ length: page === 1 ? 100 : 1 }, (_, i) => ({
              fid: `${page}-${i}`,
              file_name: `${page}-${i}`,
              dir: 0,
              size: 1,
            })),
          },
        };
      }
      if (url.pathname === "/api/list") {
        const page = Number(url.searchParams.get("page"));
        return {
          errno: 0,
          list: Array.from({ length: page === 1 ? 100 : 1 }, (_, i) => ({
            fs_id: `${page}-${i}`,
            server_filename: `${page}-${i}`,
            isdir: 0,
          })),
        };
      }
      if (url.pathname.endsWith("/files")) {
        const cursor = url.searchParams.get("page_token");
        return {
          files: [
            {
              id: cursor ? "second" : "first",
              name: "文件",
              kind: "drive#file",
              size: "1",
            },
          ],
          next_page_token: cursor ? "" : "next-page",
        };
      }
      if (url.pathname.endsWith("get_file_list")) {
        const body = JSON.parse(String(init?.body));
        return {
          code: 0,
          data: {
            list: body.page
              ? []
              : [{ fileId: "a", fileName: "文件", resType: 1, fileSize: 2 }],
          },
        };
      }
      throw Error(`Unexpected ${url.pathname}`);
    },
  };
  for (const provider of [
    new QuarkProvider(transport),
    new UcProvider(transport),
    new BaiduProvider(transport),
    new XunleiProvider(transport),
    new PikPakProvider(transport),
    new GuangyaProvider(transport),
  ]) {
    const account = { id: provider.id, provider: provider.id } as Account;
    const first = await provider.listPage(
      account,
      provider.id === "baidu" ? "/资料" : "folder",
    );
    assert.ok(first.next);
    assert.ok(first.files.length);
    assert.equal(
      first.files[0].parentId,
      provider.id === "baidu" ? "/资料" : "folder",
    );
    const second = await provider.listPage(account, "folder", first.next!);
    assert.equal(second.next, null);
    assert.equal(calls.at(-1)!.account, account.id);
  }
  assert.equal(calls.length, 12);
  assert.ok(
    calls.every((c) => !/share|upload|delete|transfer/.test(c.url.pathname)),
  );
});

test("分页格式变化或空页仍声明更多内容时，拒绝静默完成", async () => {
  const account = { id: "a", provider: "quark" } as Account;
  for (const result of [
    { code: 0, data: {} },
    { code: 0, metadata: { _total: 200 }, data: { list: [] } },
  ]) {
    const provider = new QuarkProvider({
      text: async () => "",
      json: async () => result,
    });
    await assert.rejects(provider.listPage(account, "0"), /格式|分页/);
  }
});
