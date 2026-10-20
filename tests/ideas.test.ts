import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers";
import { AiService } from "../core/ai";
import type { IdeaContext, IdeaRun } from "../shared/ideas";
import type { Pool } from "../shared/types";

const candidate = (
  word = "AI办公会议纪要模板怎么用",
  localRefIds: string[] = [],
) => ({
  word,
  kind: "longtail",
  cluster: "会议整理",
  intent: "howto",
  priority: "high",
  reason: "围绕资料已提供的会议记录主题提出问题",
  angle: "展示从原始记录整理成行动清单的流程",
  answerQuestion: "怎样用现有会议纪要模板整理行动项？",
  evidenceNeeded: "补充本人操作截图及模板实际字段",
  localRefIds,
});
async function aiFixture() {
  const f = await fixture();
  const saved = await f.add(false);
  await f.app.secrets.set("openrouter", "test-private-key");
  f.app.db.setSetting("model", "test/ideas");
  f.app.db.setSetting("modelCatalog", [
    {
      id: "test/ideas",
      structured: true,
      promptPrice: 0.000001,
      completionPrice: 0.000001,
    },
  ]);
  f.app.db.setSetting("dailyAiBudgetMicros", 1000000);
  return { ...f, saved };
}

test("local idea preview recalls old pools and expired paid-query fragments, without network or fake live metrics", async () => {
  const f = await aiFixture();
  try {
    await f.app.invoke("pool.manual", {
      name: "本地历史",
      resourceId: f.saved.resourceId,
      words: "AI办公会议纪要模板\n纯无关电影资料",
    });
    for (let i = 0; i < 650; i++)
      f.app.db.run(
        "INSERT INTO api_cache(key,value,expires_at) VALUES(?,?,?)",
        `new-${i}`,
        JSON.stringify({ keywords: [{ word: "与目标无关的词" }] }),
        "2099-01-01",
      );
    f.app.db.run(
      "INSERT INTO api_cache(key,value,expires_at) VALUES(?,?,?)",
      "very-old",
      JSON.stringify({
        data: { word: [{ keyword: "AI办公会议记录步骤", index: 9999 }] },
        _panxuFetchedAt: "2020-01-01",
      }),
      "2020-01-02",
    );
    const context = (await f.app.invoke("ai.ideas.preview", {
      resourceId: f.saved.resourceId,
      seeds: ["AI办公"],
    })) as IdeaContext;
    assert.ok(context.references.some((r) => r.word === "AI办公会议记录步骤"));
    assert.equal(
      context.references.find((r) => r.word === "AI办公会议记录步骤")
        ?.fetchedAt,
      "2020-01-01",
    );
    assert.ok(context.references.some((r) => r.word === "AI办公会议纪要模板"));
    assert.ok(!context.references.some((r) => r.word === "纯无关电影资料"));
    assert.doesNotMatch(
      JSON.stringify(context.references),
      /9999|source123|test-private-key/,
    );
    assert.equal(f.app.repo.calls().length, 0);
    await f.app.invoke("pool.manual", {
      name: "其他领域",
      resourceId: null,
      words: "Obsidian 数据库视图\n软件资料入门",
    });
    const explicit = (await f.app.invoke("ai.ideas.preview", {
      resourceId: f.saved.resourceId,
      seeds: ["Obsidian"],
    })) as IdeaContext;
    assert.deepEqual(
      explicit.references.map((r) => r.word),
      ["Obsidian 数据库视图"],
    );
    const noLocal = (await f.app.invoke("ai.ideas.preview", {
      resourceId: f.saved.resourceId,
      seeds: [],
      useLocal: false,
    })) as IdeaContext;
    assert.equal(noLocal.references.length, 0);
    await assert.rejects(
      f.app.invoke("ai.ideas.preview", { resourceId: null, seeds: [] }),
      { code: "IDEA_TOPIC_REQUIRED" },
    );
  } finally {
    await f.cleanup();
  }
});

test("SEO/GEO prompt grounds candidates in bounded local text; repeated in-flight requests charge once and save unverified provenance", async () => {
  const f = await aiFixture();
  try {
    await f.app.invoke("pool.manual", {
      name: "会议词池",
      resourceId: f.saved.resourceId,
      words: "AI办公会议纪要模板",
    });
    f.app.db.run(
      "UPDATE resources SET summary=? WHERE id=?",
      "办公笔记 https://pan.quark.cn/s/secretlink 提取码：s123 API Key: sk-or-v1-abcdefghijklmnopqrstuv",
      f.saved.resourceId,
    );
    let requests = 0;
    const ai = new AiService(
      f.app.repo,
      f.app.secrets,
      () => {},
      async (_url, init) => {
        requests++;
        const payload = JSON.parse(String(init?.body)),
          input = JSON.parse(payload.messages[1].content);
        assert.equal(payload.max_tokens, 6500);
        assert.match(payload.messages[0].content, /SEO|GEO|不保证|本地/);
        assert.match(payload.messages[0].content, /不是地理位置优化/);
        assert.doesNotMatch(
          payload.messages[1].content,
          /secretlink|sk-or-v1-abcdefghijklmnopqrstuv|s123|source123|owner-1|source-file|test-private-key/,
        );
        assert.ok(input.references.length <= 50);
        await new Promise((r) => setTimeout(r, 15));
        return {
          usage: { cost: 0.002 },
          choices: [
            {
              message: {
                content: JSON.stringify({
                  strategy: "围绕会议纪要场景组织教程与可核验问题。",
                  candidates: [
                    candidate(undefined, [input.references[0].id]),
                    candidate("ＡＩ办公会议纪要模板怎么用", [
                      input.references[0].id,
                    ]),
                  ],
                }),
              },
            },
          ],
        };
      },
    );
    f.app.ai.suggestIdeas = ai.suggestIdeas.bind(ai);
    const input = {
      resourceId: f.saved.resourceId,
      seeds: ["AI办公"],
      focus: "balanced",
      audience: "职场新人",
      objective: "提供会议整理教程",
    };
    const [run, again] = (await Promise.all([
      f.app.invoke("ai.ideas.generate", input),
      f.app.invoke("ai.ideas.generate", input),
    ])) as IdeaRun[];
    assert.equal(run.id, again.id);
    assert.equal(requests, 1);
    assert.equal(run.candidates.length, 1);
    assert.equal(f.app.repo.calls()[0].confirmedMicros, 2000);
    assert.equal(f.app.repo.calls()[0].phase, "keyword_ideas");
    const pool = (await f.app.invoke("ai.ideas.save", {
      runId: run.id,
      selected: [run.candidates[0].id],
      name: "候选词池",
    })) as Pool;
    assert.equal(pool.resourceId, f.saved.resourceId);
    assert.deepEqual(pool.keywords[0].metrics, {});
    assert.match(pool.keywords[0].source, /AI联想.*待5118验证/);
    assert.equal(
      pool.keywords[0].idea?.evidenceNeeded,
      run.candidates[0].evidenceNeeded,
    );
    assert.deepEqual(pool.keywords[0].idea?.references, ["AI办公会议纪要模板"]);
    assert.equal(
      ((await f.app.invoke("ai.ideas.history")) as IdeaRun[])[0].id,
      run.id,
    );
    await assert.rejects(
      f.app.invoke("ai.ideas.save", {
        runId: run.id,
        selected: ["invented"],
        name: "错误",
      }),
      { code: "IDEA_SELECTION_REQUIRED" },
    );
    assert.equal(requests, 1);
  } finally {
    await f.cleanup();
  }
});

test("invented local references and fabricated metrics cannot be saved; returned AI costs stay recorded", async () => {
  const f = await aiFixture();
  try {
    for (const wrong of [
      candidate(undefined, ["invented-reference"]),
      { ...candidate(), searchVolume: 12345 },
    ]) {
      const ai = new AiService(
        f.app.repo,
        f.app.secrets,
        () => {},
        async () => ({
          usage: { cost: 0.001 },
          choices: [
            {
              message: {
                content: JSON.stringify({
                  strategy: "测试",
                  candidates: [wrong],
                }),
              },
            },
          ],
        }),
      );
      f.app.ai.suggestIdeas = ai.suggestIdeas.bind(ai);
      await assert.rejects(
        f.app.invoke("ai.ideas.generate", {
          resourceId: f.saved.resourceId,
          seeds: ["AI办公"],
        }),
        { code: "INVALID_AI_RESPONSE" },
      );
    }
    assert.equal(
      ((await f.app.invoke("ai.ideas.history")) as IdeaRun[]).length,
      0,
    );
    assert.equal(f.app.repo.pools().length, 0);
    assert.equal(
      f.app.repo.calls().filter((c) => c.confirmedMicros === 1000).length,
      2,
    );
  } finally {
    await f.cleanup();
  }
});

test("idea generation shares the existing dollar budget and does not call 5118", async () => {
  const f = await aiFixture();
  try {
    f.app.db.setSetting("dailyAiBudgetMicros", 0);
    let requests = 0;
    const ai = new AiService(
      f.app.repo,
      f.app.secrets,
      () => {},
      async () => {
        requests++;
        throw new Error("should not request");
      },
    );
    f.app.ai.suggestIdeas = ai.suggestIdeas.bind(ai);
    await assert.rejects(
      f.app.invoke("ai.ideas.generate", {
        resourceId: f.saved.resourceId,
        seeds: [],
      }),
      { code: "AI_BUDGET_EXCEEDED" },
    );
    assert.equal(requests, 0);
    assert.equal(f.app.repo.calls().length, 0);
  } finally {
    await f.cleanup();
  }
});
