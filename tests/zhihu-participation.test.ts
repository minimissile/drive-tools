import test from "node:test";
import assert from "node:assert/strict";
import { zhihuFixture } from "./zhihu-fixture";
import { ZhihuParticipation } from "../core/zhihu-participation/service";
import {
  readParticipationState,
  zhihuParticipationStateKey,
} from "../core/zhihu-participation/state";
import {
  canonicalZhihuParticipationUrl,
  type ZhihuResearchHit,
  type ZhihuResearchDocument,
} from "../shared/zhihu-participation";

const question = "https://www.zhihu.com/question/123456789";
const hit: ZhihuResearchHit = {
  kind: "question",
  url: question,
  title: "怎样建立生活观察记录？",
  excerpt: "问题的可见摘要，不代表完整上下文。",
};
const document = (): ZhihuResearchDocument => ({
  kind: "question",
  url: question,
  title: hit.title,
  text: "问题正文：如何区分事实和自己的推测，并写出具体观察记录？\n问题补充：希望有可以尝试的步骤。",
  observedAt: new Date().toISOString(),
  related: [],
});
async function participationFixture() {
  const f = await zhihuFixture(),
    account = await f.addAccount();
  let searches = 0,
    inspections = 0,
    current = document(),
    failure = false,
    delay: (() => Promise<void>) | undefined;
  f.ports.zhihuParticipation = {
    discover: async (_account, input) => {
      searches++;
      assert.equal(input.limit, 10);
      await delay?.();
      if (failure) throw new Error("模拟网络读取失败");
      return [hit, hit];
    },
    inspect: async (_account, input) => {
      inspections++;
      assert.equal(input.url, question);
      await delay?.();
      if (failure) throw new Error("模拟网络读取失败");
      return structuredClone(current);
    },
  };
  const service = new ZhihuParticipation({
    db: f.db,
    accounts: f.accounts,
    ports: f.ports,
    zhihu: f.service,
    dataPath: f.dir,
    changed() {},
  });
  return {
    ...f,
    participation: service,
    account,
    get searches() {
      return searches;
    },
    get inspections() {
      return inspections;
    },
    discover: () =>
      service.discover({
        accountId: account.id,
        query: "生活观察",
        kind: "question",
      }),
    setDocument: (value: ZhihuResearchDocument) => {
      current = value;
    },
    setFailure: (value: boolean) => {
      failure = value;
    },
    setDelay: (value?: () => Promise<void>) => {
      delay = value;
    },
    expire: () => {
      const state = readParticipationState(f.db);
      for (const candidate of state.candidates)
        if (candidate.document)
          candidate.document.observedAt = "2020-01-01T00:00:00.000Z";
      for (const entry of state.discoveryCache)
        entry.observedAt = "2020-01-01T00:00:00.000Z";
      f.db.setSetting(zhihuParticipationStateKey, state);
    },
    close: async () => {
      service.close();
      await f.close();
    },
  };
}

test("日常参与URL仅准官方规范资源路径，无凭据、查询、片段、端口或混淆路径", () => {
  assert.equal(
    canonicalZhihuParticipationUrl("https://zhihu.com/question/123/"),
    "https://www.zhihu.com/question/123",
  );
  assert.equal(
    canonicalZhihuParticipationUrl(
      "https://www.zhihu.com/question/123/answer/456",
    ),
    "https://www.zhihu.com/question/123/answer/456",
  );
  assert.equal(
    canonicalZhihuParticipationUrl("https://zhuanlan.zhihu.com/p/123"),
    "https://zhuanlan.zhihu.com/p/123",
  );
  assert.equal(
    canonicalZhihuParticipationUrl(
      "https://www.zhihu.com/people/some-author_123",
    ),
    "https://www.zhihu.com/people/some-author_123",
  );
  for (const value of [
    "http://www.zhihu.com/question/123",
    "https://evil.com/question/123",
    "https://www.zhihu.com.evil.com/question/123",
    "https://a@www.zhihu.com/question/123",
    "https://www.zhihu.com:443/question/123",
    "https://www.zhihu.com/question/123?",
    "https://www.zhihu.com/question/123?token=abc",
    "https://www.zhihu.com/question/123#",
    "https://www.zhihu.com/a/../question/123",
    "https://www.zhihu.com/a/%2e%2e/question/123",
    "https://www.zhihu.com/people/a/activities",
    "https://www.zhihu.com/api/v4/me",
  ])
    assert.equal(canonicalZhihuParticipationUrl(value), null, value);
});

test("发现和完整上下文本地持久化、按账号去重，TTL重复不触网、不使任务版本失效", async () => {
  const f = await participationFixture();
  try {
    assert.deepEqual(f.participation.snapshot().candidates, []);
    const first = (await f.discover())[0];
    assert.equal(f.searches, 1);
    assert.equal(f.participation.snapshot().candidates.length, 1);
    assert.equal((await f.discover())[0].version, first.version);
    assert.equal(f.searches, 1);
    f.setDocument({
      ...document(),
      related: [
        {
          kind: "answer",
          url: `${question}/answer/987654321`,
          title: "一个相关回答",
          excerpt: "相关回答摘录，仍需单独读取完整上下文。",
          author: "模拟回答作者",
        },
      ],
    });
    const inspected = await f.participation.inspect({
      accountId: f.account.id,
      candidateId: first.id,
      version: first.version,
    });
    assert.ok(inspected.document);
    assert.equal(f.inspections, 1);
    const related = f.participation
      .snapshot()
      .candidates.find((item) => item.kind === "answer")!;
    assert.ok(related);
    assert.equal(related.accountId, f.account.id);
    assert.equal(related.document, null);
    assert.throws(
      () =>
        f.participation.plan({
          accountId: f.account.id,
          candidateId: related.id,
          version: related.version,
          kind: "like",
          reason: "候选仍需完整阅读后才可判断是否赞同。",
        }),
      /完整上下文/,
    );
    assert.equal(
      (
        await f.participation.inspect({
          accountId: f.account.id,
          candidateId: first.id,
          version: inspected.version,
        })
      ).version,
      inspected.version,
    );
    assert.equal(f.inspections, 1);
    f.expire();
    const searched = (await f.discover())[0];
    assert.equal(searched.version, inspected.version);
    assert.equal(f.searches, 2);
    const reread = await f.participation.inspect({
      accountId: f.account.id,
      candidateId: first.id,
      version: inspected.version,
    });
    assert.equal(
      reread.version,
      inspected.version,
      "Only observedAt changed; exact context stays the same",
    );
    assert.equal(f.inspections, 2);
    assert.equal(
      f.participation
        .snapshot()
        .candidates.filter((item) => item.kind === "answer").length,
      1,
      "Repeated context reuses the same related candidate",
    );
    assert.equal(
      f.participation.snapshot().activities.length,
      0,
      "Inspect never claims the user has read it",
    );
  } finally {
    await f.close();
  }
});

test("仅阅读可先安排；互动只待本人确认，done为self_report且不冒官方阅读或互动回执", async () => {
  const f = await participationFixture();
  try {
    let candidate = (await f.discover())[0];
    const read = f.participation.plan({
      accountId: f.account.id,
      candidateId: candidate.id,
      version: candidate.version,
      kind: "read",
      reason: "本人准备先阅读问题全文与补充。",
    });
    assert.equal(read.status, "planned");
    assert.throws(
      () =>
        f.participation.plan({
          accountId: f.account.id,
          candidateId: candidate.id,
          version: candidate.version,
          kind: "comment",
          reason: "先读上下文再决定是否评论。",
        }),
      /完整上下文/,
    );
    candidate = await f.participation.inspect({
      accountId: f.account.id,
      candidateId: candidate.id,
      version: candidate.version,
    });
    const comment = f.participation.plan({
      accountId: f.account.id,
      candidateId: candidate.id,
      version: candidate.version,
      kind: "comment",
      reason: "对照上下文提出具体疑问，由本人决定是否评论。",
      draft: "能否补充一个区分事实和推测的例子？",
    });
    assert.equal(comment.status, "needs_review");
    assert.equal(comment.contentId, null);
    assert.throws(() =>
      f.participation.resolve({
        id: comment.id,
        version: comment.version,
        outcome: "done",
        note: "本人决定已完成。",
        confirmed: false,
      }),
    );
    const done = f.participation.resolve({
      id: comment.id,
      version: comment.version,
      outcome: "done",
      note: "本人手工记录已经处理；此处没有官方发布回执。",
      confirmed: true,
    });
    assert.equal(done.resolution!.evidence, "self_report");
    assert.equal(done.status, "done");
    assert.throws(
      () =>
        f.participation.resolve({
          id: done.id,
          version: done.version,
          outcome: "skipped",
          note: "覆盖此前的完成记录。",
          confirmed: true,
        }),
      /未覆盖历史/,
    );
    assert.equal(
      f.participation.snapshot().activities.find((item) => item.id === read.id)!
        .status,
      "planned",
    );
    assert.equal(f.service.snapshot().tasks.length, 0);
  } finally {
    await f.close();
  }
});

test("官方问题上下文→本地待审AI回答稿，绑定账号、准确版本幂等、上下文和依据留存", async () => {
  const f = await participationFixture();
  try {
    let candidate = (await f.discover())[0];
    candidate = await f.participation.inspect({
      accountId: f.account.id,
      candidateId: candidate.id,
      version: candidate.version,
    });
    const activity = f.participation.plan({
        accountId: f.account.id,
        candidateId: candidate.id,
        version: candidate.version,
        kind: "answer",
        reason: "根据完整问题给出有边界的观察记录方法。",
      }),
      input = {
        id: activity.id,
        version: activity.version,
        title: "先把事实与推测分开",
        body: "可以先用两栏记录：左边只写实际看到或听到的细节，右边再写自己的解释。隔一段时间回看，核对哪些解释仍有依据。具体步骤要按场景调整。",
        basis:
          "依据本次保存的官方问题与补充，提出通用记录建议；没有声称亲测或引用外部作品的授权。",
        confirmed: true as const,
      },
      result = f.participation.answer(input),
      again = f.participation.answer(input),
      content = f.service.store.get("zhihu_contents", result.contentId);
    assert.equal(again.contentId, result.contentId);
    assert.equal(f.service.snapshot().contents.length, 1);
    assert.equal(content.accountId, f.account.id);
    assert.equal(content.reviewed, false);
    assert.equal(content.aiAssisted, true);
    assert.equal(content.kind, "answer");
    assert.equal(content.questionUrl, question);
    assert.match(content.body, /AI辅助/);
    assert.equal(result.activity.context!.text, candidate.document!.text);
    assert.equal(result.activity.basis, input.basis);
    assert.equal(result.activity.status, "prepared");
    assert.equal(result.activity.resolution, null);
    assert.equal(f.service.snapshot().tasks.length, 0);
    assert.throws(
      () =>
        f.participation.answer({
          ...input,
          body: `${input.body}又加入不同内容。`,
        }),
      /已有原回答稿/,
    );
  } finally {
    await f.close();
  }
});

test("上下文变更、跨账号、远端不完整/失败或异步guard撤销均保留旧数据、不产生回答稿", async () => {
  const f = await participationFixture();
  try {
    const second = await f.addAccount("另一个模拟账号");
    let candidate = (await f.discover())[0];
    assert.throws(
      () =>
        f.participation.plan({
          accountId: second.id,
          candidateId: candidate.id,
          version: candidate.version,
          kind: "read",
          reason: "尝试跨账号安排任务。",
        }),
      /不属于当前账号/,
    );
    candidate = await f.participation.inspect({
      accountId: f.account.id,
      candidateId: candidate.id,
      version: candidate.version,
    });
    const activity = f.participation.plan({
      accountId: f.account.id,
      candidateId: candidate.id,
      version: candidate.version,
      kind: "answer",
      reason: "起草前必须复核准确上下文版本。",
    });
    f.expire();
    f.setDocument({
      ...document(),
      text: "新问题补充：与此前的研究对象不同，请按新背景回答。",
    });
    const changed = await f.participation.inspect({
      accountId: f.account.id,
      candidateId: candidate.id,
      version: candidate.version,
    });
    assert.ok(changed.version > candidate.version);
    assert.throws(
      () =>
        f.participation.answer({
          id: activity.id,
          version: activity.version,
          title: "准确版本回答",
          body: "只能围绕当前上下文给出具体方法，不应继续使用已经失效的背景描述或引用。",
          basis: "这是对旧版问题的理解，必须被版本检查拦截。",
          confirmed: true,
        }),
      /上下文版本已变化/,
    );
    const replanned = f.participation.plan({
      accountId: f.account.id,
      candidateId: changed.id,
      version: changed.version,
      kind: "answer",
      reason: "明确重新核对新问题背景，继续原待审任务。",
    });
    assert.equal(replanned.id, activity.id);
    assert.equal(replanned.candidateVersion, changed.version);
    assert.ok(replanned.version > activity.version);
    assert.equal(f.participation.snapshot().activities.length, 1);
    const saved = f.participation.snapshot();
    f.expire();
    f.setFailure(true);
    await assert.rejects(
      f.participation.inspect({
        accountId: f.account.id,
        candidateId: changed.id,
        version: changed.version,
      }),
      /模拟网络读取失败/,
    );
    assert.equal(
      f.participation.snapshot().candidates[0].document!.text,
      saved.candidates[0].document!.text,
    );
    f.setFailure(false);
    f.setDocument({ ...document(), text: "x".repeat(16001) });
    await assert.rejects(
      f.participation.inspect({
        accountId: f.account.id,
        candidateId: changed.id,
        version: changed.version,
      }),
    );
    assert.equal(
      f.participation.snapshot().candidates[0].version,
      changed.version,
    );
    f.setDocument(document());
    let allowed = true;
    f.setDelay(async () => {
      allowed = false;
    });
    await assert.rejects(
      f.participation.inspect(
        {
          accountId: f.account.id,
          candidateId: changed.id,
          version: changed.version,
        },
        () => {
          if (!allowed) throw new Error("本次授权已撤销");
        },
      ),
      /授权已撤销/,
    );
    assert.equal(
      f.participation.snapshot().candidates[0].version,
      changed.version,
    );
    assert.equal(f.service.snapshot().contents.length, 0);
  } finally {
    await f.close();
  }
});

test("草稿编辑、跳过和2000任务上限均使用准确版本；不会删除完成记录或自动执行", async () => {
  const f = await participationFixture();
  try {
    const candidate = (await f.discover())[0],
      read = f.participation.plan({
        accountId: f.account.id,
        candidateId: candidate.id,
        version: candidate.version,
        kind: "read",
        reason: "先安排一次具体的完整问题阅读。",
      }),
      saved = f.participation.save({
        id: read.id,
        version: read.version,
        reason: "改为下班后认真阅读与记录疑问。",
        draft: "重点区分问题描述和回答者推测。",
      });
    assert.equal(saved.version, read.version + 1);
    assert.throws(
      () =>
        f.participation.save({
          id: read.id,
          version: read.version,
          reason: "旧窗口修改任务的理由。",
          draft: "过期内容",
        }),
      /版本已变化/,
    );
    const skipped = f.participation.resolve({
      id: saved.id,
      version: saved.version,
      outcome: "skipped",
      note: "本人决定今天先跳过这项阅读任务。",
      confirmed: true,
    });
    assert.equal(skipped.status, "skipped");
    assert.equal(skipped.resolution!.evidence, "self_report");
    const state = readParticipationState(f.db);
    state.activities = Array.from({ length: 2000 }, (_, index) => ({
      ...skipped,
      id: `zhactivity_fixture${index}`,
    }));
    f.db.setSetting(zhihuParticipationStateKey, state);
    assert.throws(
      () =>
        f.participation.plan({
          accountId: f.account.id,
          candidateId: candidate.id,
          version: candidate.version,
          kind: "read",
          reason: "新任务不应静默清除已有历史记录。",
        }),
      /2000条/,
    );
    assert.equal(f.participation.snapshot().activities.length, 2000);
    assert.equal(f.service.snapshot().tasks.length, 0);
  } finally {
    await f.close();
  }
});

test("历史上限和非比特环境明确阻塞，不隐式删史，不以HTTP搜索触发远端互动", async () => {
  const f = await participationFixture();
  try {
    const candidate = (await f.discover())[0],
      state = readParticipationState(f.db);
    state.candidates = Array.from({ length: 500 }, (_, index) => ({
      ...candidate,
      id: `zhcandidate_fixture${index}`,
      url: `https://www.zhihu.com/question/${100000 + index}`,
    }));
    state.discoveryCache = [];
    f.db.setSetting(zhihuParticipationStateKey, state);
    await assert.rejects(f.discover(), /500条/);
    assert.equal(f.participation.snapshot().candidates.length, 500);
    state.candidates[0] = candidate;
    f.db.setSetting(zhihuParticipationStateKey, state);
    f.setDocument({
      ...document(),
      related: [
        {
          kind: "answer",
          url: `${question}/answer/987654321`,
          title: "相关回答甲",
          excerpt: "仅摘要，需单独查看。",
        },
        {
          kind: "answer",
          url: `${question}/answer/987654322`,
          title: "相关回答乙",
          excerpt: "仅摘要，需单独查看。",
        },
      ],
    });
    await assert.rejects(
      f.participation.inspect({
        accountId: f.account.id,
        candidateId: candidate.id,
        version: candidate.version,
      }),
      /整批停止保存/,
    );
    assert.equal(f.participation.snapshot().candidates.length, 500);
    assert.equal(
      f.participation
        .snapshot()
        .candidates.find((item) => item.id === candidate.id)!.document,
      null,
      "Capacity failure preserves the previous document and inserts no partial batch",
    );
    f.db.run(
      "UPDATE browser_environments SET engine='electron' WHERE id=?",
      f.account.environmentId!,
    );
    await assert.rejects(f.discover(), /比特浏览器/);
    assert.equal(f.service.snapshot().tasks.length, 0);
    assert.equal(
      f.db.get<{ n: number }>("SELECT COUNT(*) n FROM api_calls")!.n,
      0,
    );
  } finally {
    await f.close();
  }
});

test("明确截断的官方问题保留阅读候选，但不能准备回答或宣称掌握完整原文", async () => {
  const f = await participationFixture();
  try {
    f.setDocument({
      ...document(),
      text: "只读取到的问题前半段，后续背景尚未取得。",
      truncated: true,
    });
    const found = (await f.discover())[0],
      candidate = await f.participation.inspect({
        accountId: f.account.id,
        candidateId: found.id,
        version: found.version,
      });
    assert.equal(candidate.document!.truncated, true);
    const read = f.participation.plan({
        accountId: f.account.id,
        candidateId: candidate.id,
        version: candidate.version,
        kind: "read",
        reason: "上下文不完整，安排本人阅读官方原文。",
      }),
      answer = f.participation.plan({
        accountId: f.account.id,
        candidateId: candidate.id,
        version: candidate.version,
        kind: "answer",
        reason: "即使排了待审回答，也不能据片段生成渠道稿。",
      });
    assert.equal(read.status, "planned");
    assert.throws(
      () =>
        f.participation.answer({
          id: answer.id,
          version: answer.version,
          title: "片段不够作为完整依据",
          body: "当前仅有问题的部分文字，缺少后续上下文，不应把片段作为完整背景来给出可能失真的建议。",
          basis: "仅有部分文字，应被上下文完整性检查明确阻止。",
          confirmed: true,
        }),
      /明确截断/,
    );
    assert.equal(f.service.snapshot().contents.length, 0);
  } finally {
    await f.close();
  }
});
