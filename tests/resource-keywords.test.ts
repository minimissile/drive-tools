import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Database } from "../core/database";
import { AppError } from "../core/errors";
import { fixture } from "./helpers";
import {
  lookupResourceKeywords,
  checkKeywordSources,
} from "../core/resource-keywords";
import { discoveryWordKey } from "../shared/baidu-discovery";
import {
  keywordLookupSchema,
  mergeKeywordCandidates,
  parseImportedResourceKeywords,
  parseResourceKeywordSeeds,
  parseResourceKeywordText,
} from "../shared/resource-keywords";
import type { KeywordLookup } from "../shared/resource-keywords";
import type { Resource } from "../shared/types";
import type {
  WebsiteAccount,
  WebsiteAccountView,
} from "../shared/website-accounts";

test("intake lookup merges duplicate words and keeps partial results with source details", async () => {
  const lookup = await lookupResourceKeywords(["ＡＢＣ", "abc"], {
    baiduDiscovery: {
      read: async (source, seed) => {
        assert.equal(source, "suggest");
        assert.equal(seed.toLowerCase(), "abc");
        return ["ＡＢＣ 模板", "入门教材"];
      },
      readSearchWords: async () => ({
        related: ["abc 模板"],
        people: ["ABC 问答"],
      }),
      open: async () => {},
      close: () => {},
      isOpen: () => false,
    },
    read5118PublicKeywords: async () => {
      throw new AppError("KEYWORD_5118_LOGIN_REQUIRED", "5118 要求登录");
    },
  });
  const common = lookup.candidates.find(
    (item) => discoveryWordKey(item.word) === "abc 模板",
  );
  assert.deepEqual(common?.sources, ["suggest", "related"]);
  assert.ok(lookup.candidates.some((item) => item.sources.includes("people")));
  assert.deepEqual(
    lookup.issues.map(({ channel, code }) => ({ channel, code })),
    [{ channel: "5118", code: "login_required" }],
  );
  const imported = parseImportedResourceKeywords(
    "关键词\t流量\nＡＢＣ 模板\t80\n入门问题，入门练习\nhttps://www.baidu.com/",
  );
  assert.deepEqual(imported, ["ABC 模板", "入门问题", "入门练习"]);
  const merged = mergeKeywordCandidates(
    lookup.candidates,
    imported.map((word) => ({ word, sources: ["manual"], seeds: ["ABC"] })),
  );
  assert.deepEqual(merged.find((item) => item.word === common?.word)?.sources, [
    "suggest",
    "related",
    "manual",
  ]);
  assert.deepEqual(parseResourceKeywordSeeds("办公教程；专项训练\n办公教程"), [
    "办公教程",
    "专项训练",
  ]);
  assert.deepEqual(
    parseResourceKeywordText(" Ｗｏｒｄ 模板 \r\nword 模板\nWord, Excel 教程"),
    ["Word 模板", "Word, Excel 教程"],
  );
  await assert.rejects(lookupResourceKeywords(["https://example.com/"], {}), {
    code: "KEYWORD_SEEDS",
  });
});

test("resource keyword lookup accepts five search terms and rejects a sixth", async () => {
  const seeds = ["流量词", "长尾词", "教程", "实战", "进阶"];
  assert.equal(keywordLookupSchema.safeParse({ seeds }).success, true);
  const extra = [...seeds, "示例"];
  assert.equal(keywordLookupSchema.safeParse({ seeds: extra }).success, false);
  await assert.rejects(lookupResourceKeywords(extra, {}), {
    code: "KEYWORD_SEEDS",
    message: "一次最多检索 5 个搜索词。",
  });
});

test("来源检查复用已登录账号，只检查页面，登录失败保留其他来源状态", async () => {
  const f = await fixture();
  let marketingReady = true,
    longtailReady = true,
    checks = 0;
  f.ports.websiteSessions = {
    isOpen: () => false,
    login: async () => assert.fail("重复登录"),
    clear: async () => {},
    invalidate: async () => {},
    status: async () => ({
      hasSession: marketingReady,
      uid: "12345",
      windowOpen: false,
      error: null,
    }),
  };
  f.ports.baiduKeywords = {
    query: async () => {
      throw new Error("来源检查不能查询关键词");
    },
  };
  f.ports.baiduDiscovery = {
    check: async () => {
      checks++;
    },
    read: async () => {
      throw new Error("来源检查不能采集词语");
    },
    open: async () => {},
    close: () => {},
    isOpen: () => false,
  };
  f.ports.keywordWebBrowser = {
    check: async () => {
      checks++;
      if (!longtailReady)
        throw new AppError("KEYWORD_5118_LOGIN_REQUIRED", "5118需登录");
    },
    open: async () => {},
    close: () => {},
    isOpen: () => false,
  };
  try {
    const account = (await f.app.invoke("websiteAccounts.add", {
      provider: "baidu-marketing",
    })) as WebsiteAccount;
    await f.app.invoke("websiteAccounts.check", { id: account.id });
    const run = () =>
      f.app.invoke("resource.keywordCheckSources", {
        baiduAccountId: account.id,
      }) as Promise<import("../shared/resource-keywords").KeywordSourcesCheck>;
    const ready = await run();
    assert.ok(
      Object.values(ready.sources).every(({ status }) => status === "ready"),
    );
    marketingReady = false;
    longtailReady = false;
    const expired = await run();
    assert.equal(expired.sources["baidu-marketing"].status, "login_required");
    assert.equal(expired.sources["5118"].status, "login_required");
    assert.equal(expired.sources.baidu.status, "ready");
    assert.equal(checks, 4);
    const missing = await checkKeywordSources({});
    assert.ok(
      Object.values(missing.sources).every(
        ({ status }) => status === "unconfigured",
      ),
    );
  } finally {
    await f.cleanup();
  }
});

test("intake reuses the website login, keeps public results on expiry and opens no login window", async () => {
  const f = await fixture();
  let hasSession = true;
  let rejectSession = false;
  let queryCount = 0;
  f.ports.websiteSessions = {
    isOpen: () => false,
    login: async () => assert.fail("intake must use the existing login"),
    clear: async () => {},
    invalidate: async () => {
      hasSession = false;
    },
    status: async ({ provider }) => {
      assert.equal(provider, "baidu-marketing");
      return { hasSession, uid: "12345", windowOpen: false, error: null };
    },
  };
  f.ports.read5118PublicKeywords = async () => ["入门资料"];
  try {
    await f.app.invoke("websiteAccounts.add", { provider: "tieba" });
    const account = (await f.app.invoke("websiteAccounts.add", {
      provider: "baidu-marketing",
    })) as WebsiteAccount;
    await f.app.invoke("websiteAccounts.check", { id: account.id });
    f.ports.baiduKeywords = {
      query: async (used, input) => {
        queryCount++;
        assert.equal(used.id, account.id);
        assert.equal(input.accountId, used.id);
        assert.deepEqual(input.seeds, ["入门"]);
        return {
          status: rejectSession ? 403 : 200,
          userId: "12345",
          body: JSON.stringify({
            status: 0,
            data: {
              totalCount: 2,
              keywordRecommendItems: [
                { keyword: "入门资料" },
                { keyword: "入门教程" },
              ],
            },
          }),
        };
      },
    };
    const accounts = (await f.app.invoke("websiteAccounts.list", {
      provider: "baidu-marketing",
    })) as WebsiteAccountView[];
    assert.deepEqual(
      accounts.map(({ id, status }) => ({ id, status })),
      [{ id: account.id, status: "connected" }],
    );
    assert.equal(queryCount, 0);
    const lookup = () =>
      f.app.invoke("resource.keywordLookup", {
        seeds: ["入门"],
        baiduAccountId: account.id,
      }) as Promise<KeywordLookup>;
    const result = await lookup();
    assert.equal(queryCount, 1);
    assert.deepEqual(
      result.candidates.map(({ word, sources }) => [word, sources]),
      [
        ["入门资料", ["baidu-marketing", "5118"]],
        ["入门教程", ["baidu-marketing"]],
      ],
    );
    assert.equal(
      await f.app.invoke("baiduKeywords.latest", { accountId: account.id }),
      null,
    );
    rejectSession = true;
    const expired = await lookup();
    assert.equal(hasSession, false);
    assert.equal(
      expired.issues.find(({ channel }) => channel === "baidu-marketing")?.code,
      "login_required",
    );
    assert.deepEqual(
      expired.candidates.map(({ word }) => word),
      ["入门资料"],
    );
    const unavailable = await lookup();
    assert.equal(queryCount, 2);
    assert.equal(
      unavailable.issues.find(({ channel }) => channel === "baidu-marketing")
        ?.code,
      "login_required",
    );
  } finally {
    await f.cleanup();
  }
});

test("selected keywords persist independently of tags and legacy saves do not clear them", async () => {
  const f = await fixture();
  try {
    const input = {
      title: "词条实训材料",
      sourceText: "https://pan.quark.cn/s/keywordfixture",
      category: "训练",
      tags: ["分类标签"],
      summary: "",
      accountId: f.account.id,
      directory: "/",
      isOwnResource: true,
      enqueue: false,
    };
    const saved = (await f.app.invoke("resource.save", {
      ...input,
      searchKeywords: [" Ｗｏｒｄ 模板 ", "word 模板", "入门资料"],
    })) as { resourceId: string; copyId: string; jobId: string | null };
    assert.equal(saved.jobId, null);
    const get = () =>
      f.app.invoke("resource.get", {
        id: saved.resourceId,
      }) as Promise<Resource>;
    assert.deepEqual((await get()).searchKeywords, ["Word 模板", "入门资料"]);
    assert.deepEqual((await get()).tags, ["分类标签"]);
    const edit = {
      ...input,
      id: saved.resourceId,
      copyId: saved.copyId,
      summary: "已有记录的普通编辑",
    };
    await f.app.invoke("resource.save", edit);
    assert.deepEqual((await get()).searchKeywords, ["Word 模板", "入门资料"]);
    await f.app.invoke("resource.save", { ...edit, searchKeywords: [] });
    assert.deepEqual((await get()).searchKeywords, []);
    assert.equal(f.provider.transfers, 0);
  } finally {
    await f.cleanup();
  }
});

test("v42 migration preserves existing resources with an empty keyword list", () => {
  const folder = mkdtempSync(join(tmpdir(), "panxu-keywords-schema-"));
  const path = join(folder, "workspace.db");
  try {
    const initial = new Database(path);
    initial.close();
    const legacy = new DatabaseSync(path);
    legacy.exec(
      "ALTER TABLE resources DROP COLUMN search_keywords; PRAGMA user_version=42;",
    );
    legacy
      .prepare(
        "INSERT INTO resources(id,title,source_url,source_key,provider,category,tags,summary,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        "legacy",
        "历史文档",
        "https://pan.quark.cn/s/legacystuff",
        "legacystuff",
        "quark",
        "学习资料",
        "[]",
        "已有正文",
        "2026-10-10",
        "2026-10-10",
      );
    legacy.close();
    const migrated = new Database(path);
    try {
      assert.equal(
        migrated.get<{ user_version: number }>("PRAGMA user_version")
          ?.user_version,
        43,
      );
      const row = migrated.get<{
        title: string;
        summary: string;
        search_keywords: string;
      }>(
        "SELECT title,summary,search_keywords FROM resources WHERE id='legacy'",
      );
      assert.deepEqual(
        { ...row },
        { title: "历史文档", summary: "已有正文", search_keywords: "[]" },
      );
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
