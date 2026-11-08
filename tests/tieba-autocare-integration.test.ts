import test from "node:test";
import assert from "node:assert/strict";
import { Database } from "../core/database";
import { join } from "node:path";
import { fixture } from "./helpers";
import { TiebaAutocareStore } from "../core/tieba-autocare/store";

test("贴吧组合入口：快照不触发网站核验，IPC校验输入，导出备份撤销自动执行意图", async () => {
  const f = await fixture();
  try {
    let checks = 0;
    f.ports.websiteSessions = {
      isOpen: () => false,
      login: async () => {},
      clear: async () => {},
      invalidate: async () => {},
      status: async () => {
        checks++;
        throw new Error("快照不应调用网站状态接口");
      },
    };
    const snapshot = (await f.app.invoke(
      "tieba.autocare.snapshot",
    )) as import("../shared/tieba-autocare").TiebaAutocareSnapshot;
    assert.equal(snapshot.enabled, false);
    assert.deepEqual(snapshot.targets, []);
    assert.equal(checks, 0);
    const participation = (await f.app.invoke(
      "tieba.participation.snapshot",
    )) as import("../shared/tieba-participation").TiebaParticipationSnapshot;
    assert.deepEqual(participation.candidates, []);
    assert.deepEqual(participation.drafts, []);
    assert.equal(checks, 0);
    const automation = (await f.app.invoke(
      "tieba.automation.snapshot",
    )) as import("../shared/tieba-automation").TiebaAutomationSnapshot;
    const topics = (await f.app.invoke(
      "tieba.topics.snapshot",
    )) as import("../shared/tieba-topics").TiebaTopicsSnapshot;
    const insights = (await f.app.invoke(
      "tieba.insights.snapshot",
    )) as import("../shared/tieba-insights").TiebaInsightsSnapshot;
    assert.equal(automation.enabled, false);
    assert.deepEqual(automation.tasks, []);
    assert.deepEqual(topics.drafts, []);
    assert.equal(insights.settings.autoReview, false);
    assert.deepEqual(insights.publications, []);
    assert.equal(checks, 0);
    await assert.rejects(
      f.app.invoke("tieba.automation.toggle", {
        revision: 1,
        enabled: true,
        confirmed: false,
      }),
    );
    await assert.rejects(
      f.app.invoke("tieba.topics.submit", {
        id: "tiebatopic_fixture",
        version: 1,
        confirmed: true,
        rightsConfirmed: false,
      }),
    );
    for (const input of [
      { accountId: "web_observe_fixture", forumNames: [] },
      {
        accountId: "web_observe_fixture",
        forumNames: ["https://example.com/f?kw=资料"],
      },
      { accountId: "web_observe_fixture", forumNames: ["资料\n办公"] },
      {
        accountId: "web_observe_fixture",
        forumNames: ["1", "2", "3", "4", "5", "6"],
      },
    ]) {
      await assert.rejects(
        f.app.invoke("tieba.autocare.observe", input),
        (error: unknown) => error instanceof Error && error.name === "ZodError",
      );
    }
    assert.equal(checks, 0, "观察入口校验失败时不访问官网");
    for (const input of [
      { accountId: "web_add_fixture", forumNames: ["资料"], revision: 1 },
      {
        accountId: "web_add_fixture",
        forumNames: ["资料"],
        revision: 1,
        confirmed: false,
      },
      {
        accountId: "web_add_fixture",
        forumNames: ["1", "2", "3", "4", "5", "6"],
        revision: 1,
        confirmed: true,
      },
    ])
      await assert.rejects(
        f.app.invoke("tieba.autocare.add", input),
        (error: unknown) => error instanceof Error && error.name === "ZodError",
      );
    for (const keyword of ["", "查找\n词", "x".repeat(81)])
      await assert.rejects(
        f.app.invoke("tieba.autocare.findForums", {
          accountId: "web_find_fixture",
          keyword,
        }),
        (error: unknown) => error instanceof Error && error.name === "ZodError",
      );
    assert.equal(
      checks,
      0,
      "添加和查找校验失败不访问官网，也不继承观察的写入授权",
    );
    await assert.rejects(
      f.app.invoke("tieba.participation.generate", {
        candidateId: "tiebacandidate_fixture",
        confirmed: false,
      }),
    );
    await assert.rejects(
      f.app.invoke("tieba.participation.submit", {
        draftId: "tiebareply_fixture",
        version: 1,
        confirmed: false,
      }),
    );
    await assert.rejects(
      f.app.invoke("tieba.autocare.toggle", {
        enabled: true,
        revision: 1,
        confirmed: false,
      }),
    );
    await assert.rejects(
      f.app.invoke("tieba.autocare.save", {
        revision: 0,
        config: { targetIds: [] },
      }),
    );
    const store = new TiebaAutocareStore(f.app.db);
    store.saveState({ ...store.state(), enabled: true });
    f.app.tiebaAutomation.store.saveState({
      ...f.app.tiebaAutomation.store.state(),
      enabled: true,
    });
    f.app.tiebaInsights.save({ revision: 1, autoReview: true });
    f.ports.chooseDirectory = async () => f.dir;
    const folder = await f.app.backup();
    assert.ok(folder);
    const backup = new Database(join(folder, "panxu.db"));
    try {
      const state = new TiebaAutocareStore(backup).state();
      assert.equal(state.enabled, false);
      assert.deepEqual(state.authorities, []);
      assert.equal(
        backup.setting("tiebaAutomation:v1", { enabled: true }).enabled,
        false,
      );
      assert.equal(
        backup.setting("tiebaInsights:v1", { autoReview: true }).autoReview,
        false,
      );
      assert.equal(store.state().enabled, true, "仅撤销副本，原空间意图保留");
    } finally {
      backup.close();
    }
  } finally {
    await f.cleanup();
  }
});
