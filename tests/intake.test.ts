import test from "node:test";
import assert from "node:assert/strict";
import { fixture, file } from "./helpers";
import {
  chooseIntakeAccount,
  intakeDestination,
} from "../src/resources/intake-share";
import type { Account, ShareInput } from "../shared/types";
import type { IntakeOptions } from "../shared/intake";
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
