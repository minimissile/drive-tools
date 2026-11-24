import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ZhihuProgress } from "../shared/zhihu";
import { ZhihuCreatorProgress } from "../src/zhihu/CreatorProgress";
import { zhihuFixture } from "./zhihu-fixture";

const score: ZhihuProgress = {
  source: "official",
  creator: true,
  level: 4,
  score: 3855,
  nextLevelScore: 9500,
  scoreUpdatedOn: "2026-11-04",
  checkedAt: new Date().toISOString(),
  note: "模拟官方创作分",
};

test("知乎：创作分部分读取保留同账号原样本，不把旧分数当作新等级的分数", async () => {
  const f = await zhihuFixture();
  try {
    const account = await f.addAccount();
    f.ports.zhihu!.progress = async () => score;
    await f.service.checkProgress(account.id);
    const partial = {
      ...score,
      level: 5,
      score: null,
      nextLevelScore: null,
      scoreUpdatedOn: null,
    };
    f.ports.zhihu!.progress = async () => partial;
    assert.deepEqual(await f.service.checkProgress(account.id), partial);
    const plan = f.service.plan(account.id);
    assert.deepEqual(plan.lastOfficialScore, score);
    assert.deepEqual(plan.progress, partial);
    assert.ok(f.service.logs.read({ search: "progress.partial" }).items.length);

    const accountView = { ...account, plan };
    const panel = renderToStaticMarkup(
      createElement(ZhihuCreatorProgress, { account: accountView }),
    );
    assert.match(panel, /Lv\.5/);
    assert.match(panel, /上次官方创作分.*3,855/);
    assert.match(panel, /官方分数日期 2026-11-04/);
    assert.doesNotMatch(panel, /<progress/);
    const otherAccount = renderToStaticMarkup(
      createElement(ZhihuCreatorProgress, {
        account: { ...accountView, uid: "different-identity" },
      }),
    );
    assert.doesNotMatch(otherAccount, /3,855/);
  } finally {
    await f.close();
  }
});

test("知乎：读取失败不覆盖已记录的创作分，确认最新官方分数后解除待刷新", async () => {
  const f = await zhihuFixture();
  try {
    const account = await f.addAccount();
    f.ports.zhihu!.progress = async () => score;
    await f.service.checkProgress(account.id);
    f.ports.zhihu!.progress = async () => {
      throw new Error("模拟创作中心不可访问");
    };
    await assert.rejects(
      f.service.checkProgress(account.id),
      /创作中心不可访问/,
    );
    const prior = f.service.plan(account.id);
    assert.ok(prior.officialProgressFailedAt);
    assert.deepEqual(prior.progress, score);
    assert.match(
      renderToStaticMarkup(
        createElement(ZhihuCreatorProgress, {
          account: { ...account, plan: prior },
        }),
      ),
      /待刷新/,
    );
    const fresh = { ...score, score: 3900 };
    f.ports.zhihu!.progress = async () => fresh;
    assert.deepEqual(await f.service.checkProgress(account.id), fresh);
    const plan = f.service.plan(account.id);
    assert.equal(plan.officialProgressFailedAt, undefined);
    assert.deepEqual(plan.lastOfficialScore, fresh);
    const panel = renderToStaticMarkup(
      createElement(ZhihuCreatorProgress, { account: { ...account, plan } }),
    );
    assert.match(panel, /<progress.*3,900/);
    assert.doesNotMatch(panel, /待刷新/);
  } finally {
    await f.close();
  }
});
