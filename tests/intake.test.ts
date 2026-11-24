import test from "node:test";
import assert from "node:assert/strict";
import { fixture, file } from "./helpers";
import {
  chooseIntakeAccount,
  intakeDestination,
} from "../src/resources/intake-share";
import type { Account, ShareInput } from "../shared/types";
import type { IntakeOptions } from "../shared/intake";
import type { IpcValue } from "../shared/ipc";
const accounts = [
  {
    id: "q",
    provider: "quark",
    enabled: true,
    isDefault: true,
    defaultDirectory: "/夸克资料",
  },
  {
    id: "b1",
    provider: "baidu",
    enabled: true,
    isDefault: true,
    defaultDirectory: "/百度主号",
  },
  {
    id: "b2",
    provider: "baidu",
    enabled: true,
    isDefault: false,
    defaultDirectory: "/百度备用",
  },
] as Account[];
const share = {
  provider: "baidu",
  url: "https://pan.baidu.com/s/example",
  shareKey: "example",
  code: "1234",
} as ShareInput;
test("link detection uses the active matching account, then default, and retains a matching manual destination", () => {
  assert.equal(chooseIntakeAccount(accounts, { baidu: "q" }, "baidu"), "b1");
  const input = {
    provider: "quark" as const,
    accountId: "q",
    directory: "/自定义夸克目录",
  };
  assert.deepEqual(intakeDestination(share, input, accounts, { baidu: "b2" }), {
    provider: "baidu",
    accountId: "b2",
    directory: "/百度备用",
  });
  assert.deepEqual(
    intakeDestination(
      share,
      { provider: "baidu", accountId: "b1", directory: "/我的选择" },
      accounts,
      {},
    ),
    { provider: "baidu", accountId: "b1", directory: "/我的选择" },
  );
  assert.equal(
    intakeDestination({ ...share, provider: "uc" }, input, accounts, {})
      .accountId,
    "",
  );
});
test("custom categories and per-account directories persist, deduplicate and reject invalid values", async () => {
  const f = await fixture();
  try {
    const other = (await f.app.invoke("account.add", {
      provider: "baidu",
      alias: "百度本人",
    })) as Account;
    await f.app.invoke("resource.addIntakeOption", {
      kind: "category",
      value: "创作素材",
    });
    await f.app.invoke("resource.addIntakeOption", {
      kind: "category",
      value: "创作素材",
    });
    await f.app.invoke("resource.addIntakeOption", {
      kind: "directory",
      accountId: f.account.id,
      value: "引流资料/素材",
    });
    const first = (await f.app.invoke("resource.intakeOptions", {
      accountId: f.account.id,
    })) as IntakeOptions;
    assert.equal(first.categories.filter((v) => v === "创作素材").length, 1);
    assert.ok(first.directories.includes("/引流资料/素材"));
    const second = (await f.app.invoke("resource.intakeOptions", {
      accountId: other.id,
    })) as IntakeOptions;
    assert.ok(second.categories.includes("创作素材"));
    assert.ok(!second.directories.includes("/引流资料/素材"));
    await assert.rejects(
      f.app.invoke("resource.addIntakeOption", {
        kind: "directory",
        accountId: f.account.id,
        value: "/a/../b",
      }),
      { code: "INVALID_DIRECTORY" },
    );
    await assert.rejects(
      f.app.invoke("resource.addIntakeOption", {
        kind: "directory",
        value: "/资料",
      }),
      { code: "ACCOUNT_REQUIRED" },
    );
    await assert.rejects(
      f.app.invoke("resource.addIntakeOption", {
        kind: "category",
        value: "x".repeat(61),
      }),
    );
  } finally {
    await f.cleanup();
  }
});
test("resource intake does not require legacy rights consent, but still requires a file selection to enqueue", async () => {
  const f = await fixture();
  try {
    const input = {
      title: "无勾选项的资源",
      sourceText: "https://pan.quark.cn/s/intaketest",
      category: "分类",
      tags: [],
      summary: "",
      accountId: f.account.id,
      directory: "/资料",
      enqueue: true,
    };
    await assert.rejects(f.app.invoke("resource.save", input), {
      code: "SELECTION_REQUIRED",
    });
    const saved = (await f.app.invoke("resource.save", {
      ...input,
      selectedFiles: [file],
    })) as { jobId: string };
    assert.ok(saved.jobId);
    assert.equal(f.provider.transfers, 0);
  } finally {
    await f.cleanup();
  }
});

test("本地资料草稿跳过已启用的固定入口，常规录入仍同步入口", async () => {
  const requests: { pathname: string; method?: string }[] = [];
  const f = await fixture(
    {},
    {
      resourceLinksFetch: async (url, { method }) => {
        requests.push({ pathname: new URL(url).pathname, method });
        return Response.json({ error: "fixture only" }, { status: 400 });
      },
    },
  );
  try {
    f.app.db.setSetting("resource-links:settings", {
      enabled: true,
      baseUrl: "https://panxu.example.com",
    });
    await f.app.secrets.set("resource-links:token", "x".repeat(32));
    const settings = await f.app.resourceLinks.settings();
    assert.equal(settings.enabled, true);
    assert.equal(settings.configured, true);
    const input = {
      title: "第三方资料甲",
      sourceText: "https://pan.quark.cn/s/fixture-local?pwd=abcd",
      accountId: f.account.id,
      category: "键盘皮肤",
      directory: "",
      summary: "保留原始出处",
      tags: [],
    };
    for (const flags of [
      { enqueue: true },
      { isOwnResource: true },
      { id: "existing" },
      { copyId: "existing-copy" },
    ])
      await assert.rejects(
        f.app.invoke("resource.saveLocalDraft", { ...input, ...flags }),
      );
    assert.equal(f.app.repo.resourceTotals().resources, 0);
    const saved = (await f.app.invoke(
      "resource.saveLocalDraft",
      input,
    )) as IpcValue<"resource.saveLocalDraft">;
    assert.equal(saved.jobId, null);
    const resource = f.app.repo.getResource(saved.resourceId);
    assert.equal(resource.sourceKind, "share");
    assert.equal(resource.copies[0].status, "draft");
    assert.equal(resource.copies[0].shareUrl, null);
    assert.equal(await f.app.secrets.get("source:" + saved.resourceId), "abcd");
    assert.equal(
      f.app.db.get(
        "SELECT id FROM resource_links WHERE resource_id=?",
        saved.resourceId,
      ),
      undefined,
    );
    assert.equal(requests.slice().length, 0);
    await assert.rejects(f.app.invoke("resource.saveLocalDraft", input), {
      code: "RESOURCE_PROVIDER_EXISTS",
    });
    await f.app.invoke("resource.save", {
      ...input,
      title: "第三方资料乙",
      sourceText: "https://pan.quark.cn/s/fixture-regular",
      enqueue: false,
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "PUT");
    assert.match(requests[0].pathname, /^\/api\/links\//);
    assert.equal(f.provider.transfers, 0);
    assert.equal(f.provider.shares, 0);
  } finally {
    await f.cleanup();
  }
});

test("百度分享浏览复用链接检查的读取器，打开官方页不触发额外目录读取", async () => {
  const f = await fixture();
  let reads = 0,
    opened = 0;
  try {
    const account = (await f.app.invoke("account.add", {
      provider: "baidu",
      alias: "百度资料",
    })) as Account;
    f.ports.openAccountPage = async () => assert.fail("应复用分享读取窗口");
    f.ports.baiduShareReader = {
      inspect: async (source, parentId, page) => {
        reads++;
        assert.equal(source.shareKey, "1autofiles");
        assert.equal(source.code, "abcd");
        return {
          shareKey: source.shareKey,
          title: "目录资料",
          parentId,
          page,
          hasMore: false,
          files: [file],
        };
      },
      open: async (source) => {
        opened++;
        assert.equal(source?.shareKey, "1autofiles");
      },
      isOpen: () => false,
      close: () => {},
    };
    const input = {
      accountId: account.id,
      sourceText: "https://pan.baidu.com/s/1autofiles?pwd=abcd",
    };
    const result = (await f.app.invoke(
      "share.inspect",
      input,
    )) as IpcValue<"share.inspect">;
    assert.equal(result.files[0].name, file.name);
    assert.equal(reads, 1);
    await f.app.invoke("share.open", input);
    await f.app.invoke("share.open", input);
    assert.equal(opened, 2);
    assert.equal(reads, 1);
    await assert.rejects(
      f.app.invoke("share.inspect", { ...input, accountId: f.account.id }),
      { code: "CROSS_PROVIDER_UNSUPPORTED" },
    );
  } finally {
    await f.cleanup();
  }
});
