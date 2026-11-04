import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { zhihuFixture } from "./zhihu-fixture";
import { Repository } from "../core/repository";
import { WeiboPosts } from "../core/weibo/posts";
import { WeiboStatistics } from "../core/weibo/statistics";
import { IntelligentOperations } from "../core/intelligent-operations/service";
import type { IntelligentOperationsDependencies } from "../core/intelligent-operations/types";
import { ZhihuParticipation } from "../core/zhihu-participation/service";
import type { OperationsBrainPermissions } from "../shared/operations-brain";
import { ContentSupply } from "../core/content-supply/service";
import { PipixSources } from "../core/pipix/service";
import { PipixClient } from "../core/pipix/client";
import { PipixKnowledge } from "../core/pipix/knowledge";
import type { AiService } from "../core/ai";
import type { AgentTurnInput, AgentTurnResult } from "../shared/ai-agent";
import { pipixDiscoverInput } from "../shared/pipix";
import type { OperationsPlan } from "../shared/intelligent-operations";
import {
  pipixHtml,
  pipixImage,
  pipixItemId,
  pipixCommentId,
} from "./pipix-fixture";

/** Real domain services, isolated SQLite/files, and injected transports only. */
export async function intelligentSupplyFixture(
  options: { participation?: boolean } = {},
) {
  const f = await zhihuFixture(),
    repo = new Repository(f.db),
    levels = new Map<string, number>(),
    requests: string[] = [],
    turns: AgentTurnInput[] = [];
  // Keep all scheduled actions inside the desktop daytime execution window.
  const day = new Date(f.time + 8 * 3600000).toISOString().slice(0, 10);
  f.advance(Date.parse(`${day}T10:00:00+08:00`) - f.time);
  f.ports.pipixFetch = async () => {
    assert.fail("Tests must not use a paid Pipix transport");
  };
  f.ports.normalizeCover = async (bytes) => bytes;
  f.ports.zhihu!.progress = async (account) => ({
    creator: true,
    level: levels.get(account.id) ?? 2,
    source: "official",
    checkedAt: new Date(f.time).toISOString(),
    note: "隔离测试模拟官方创作者页",
  });
  let respond: (
    input: AgentTurnInput,
  ) => Promise<AgentTurnResult> = async () => ({
    message: { role: "assistant", content: "本轮观察完成" },
    finishReason: "stop",
    costMicros: 0,
    costKnown: true,
    requestId: `mock-request-${turns.length}`,
    reservedMicros: 0,
  });
  const ai = {
    modelFor: () => "mock/operations-tools",
    assertTextConfigured: () => {},
    assertAgentConfigured: () => ({ model: "mock/operations-tools" }),
    agentTurn: async (input: AgentTurnInput) => {
      turns.push(input);
      return respond(input);
    },
  } as unknown as AiService;
  f.db.setSetting("modelCatalog", [
    { id: "mock/operations-tools", tools: true },
  ]);
  const weiboPosts = new WeiboPosts({
    db: f.db,
    accounts: f.accounts,
    dataPath: f.dir,
    ports: f.ports,
    changed() {},
  });
  const weiboStatistics = new WeiboStatistics({
    db: f.db,
    accounts: f.accounts,
    ports: f.ports,
    changed() {},
    posts: (accountId) => weiboPosts.list(accountId),
    marketing: () => [],
  });
  const participation = options.participation
    ? new ZhihuParticipation({
        db: f.db,
        accounts: f.accounts,
        ports: f.ports,
        zhihu: f.service,
        dataPath: f.dir,
        changed() {},
      })
    : undefined;
  const dependencies: IntelligentOperationsDependencies = {
    db: f.db,
    repo,
    accounts: f.accounts,
    environments: f.environments,
    zhihu: f.service,
    zhihuParticipation: participation,
    weiboPosts,
    weiboStatistics,
    ai,
    dataPath: f.dir,
    changed() {},
    clock: () => f.time,
  };
  const ops = new IntelligentOperations(dependencies);
  const pipix = new PipixSources(
    {
      db: f.db,
      dataPath: f.dir,
      ports: f.ports,
      changed() {},
      destinations: {
        zhihu: (material) => f.service.saveSource(material),
        weibo: (material, accountId) =>
          weiboPosts.saveSource(material, accountId),
      },
    },
    new PipixClient((async (address: string | URL | Request) => {
      requests.push(String(address));
      return new URL(String(address)).hostname === "h5.pipix.com"
        ? new Response(pipixHtml())
        : new Response(pipixImage);
    }) as typeof fetch),
  );
  const supply = new ContentSupply({
    db: f.db,
    dataPath: f.dir,
    pipix,
    ai,
    operations: () => ops.snapshot(),
    linkMaterial: (planId, materialId, accountId) =>
      ops.linkSuppliedMaterial(planId, materialId, accountId),
    destinations: {
      zhihu: (material) => f.service.saveSource(material),
      weibo: (material, accountId) =>
        weiboPosts.saveSource(material, accountId),
    },
    changed() {},
  });
  const addAccount = async (label = "模拟7号", level = 4) => {
    const account = await f.addAccount(label);
    levels.set(account.id, level);
    await f.service.checkProgress(account.id);
    f.service.configure({
      accountId: account.id,
      targetLevel: 5,
      dailyLimit: 2,
    });
    return account;
  };
  const plan = (accountIds: string[]) =>
    ops.save({
      name: "皮皮虾来源知乎目标Lv5",
      goal: "使用已核对来源稿，知乎账号达到Lv5后结束养号",
      direction: "日常观察与生活方法",
      mode: "autonomous",
      channels: [{ channel: "zhihu", enabled: true, purpose: "warming" }],
      accounts: accountIds.map((accountId) => ({
        accountId,
        channel: "zhihu",
      })),
      materialIds: [],
      brain: { permissions: { read: true, publish: true } },
    });
  const readySupply = async (planId: string, accountId: string) => {
    await pipix.collect(`https://h5.pipix.com/ppx/item/${pipixItemId}`);
    const archive = new PipixKnowledge(f.db),
      entry = archive.begin(pipixDiscoverInput.parse({ mode: "home" }));
    archive.receive(
      entry,
      JSON.stringify({
        code: 200,
        data: {
          cell_list: [
            {
              item: {
                item_id_str: pipixItemId,
                content: "日常观察与生活方法",
                author: { name: "模拟来源作者" },
                note: { multi_image: [{}] },
              },
            },
          ],
          has_more: false,
        },
      }),
      200,
      "",
    );
    archive.index(entry);
    const commentEntry = pipix.comments.begin(pipixItemId, "0", 0, null);
    pipix.comments.receive(
      commentEntry,
      JSON.stringify({
        code: 200,
        data: {
          comments: [
            {
              comment_id_str: pipixCommentId,
              text: "换个角度，平凡的小事也有惊喜。",
              user: { name: "热心网友" },
              tag_info: { content: "神评" },
              like_count: 42,
            },
          ],
          has_more: false,
        },
      }),
      200,
      "",
    );
    pipix.comments.index(commentEntry);
    const result = supply.start({
      sourceIds: [pipixItemId],
      planId,
      accountId,
      direction: "日常观察与生活方法",
      audience: "日常生活记录者",
    });
    for (let index = 0; supply.isBusy && index < 1000; index++)
      await setImmediate();
    assert.equal(supply.isBusy, false, "Local source collection should settle");
    let draft = supply.snapshot().drafts.find((d) => d.id === result.ids[0])!;
    assert.equal(draft.stage, "editing", draft.reason);
    draft = supply.attachComments(draft.id, draft.version, [pipixCommentId]);
    return supply.save({
      id: draft.id,
      version: draft.version,
      editorial: {
        ...draft.editorial,
        angle: "怎样通过一次小观察建立具体的生活记录？",
        contribution: "先记录看见的细节，再把自己的推测和实际观察分开。",
        checks: "隔离测试使用合成文字和一像素图片，没有真实第三方作品。",
        title: "把日常观察写得更具体",
        body: "认真观察一件小事时，可以先写下看到的颜色、位置和变化，再写自己的想法。把事实和推测分开，回头阅读时就容易发现当时忽略的细节。引用的评论只是另一种观察角度，不能替代事实依据。",
        imageIds: [draft.source!.images[0].id],
        commentIds: [pipixCommentId],
        textBasis: "reference",
        textEvidence: "此测试来源文字由测试fixture合成，仅用于流程验证。",
        imageBasis: "own",
        imageEvidence: "测试fixture内的一像素自建PNG。",
        commentBasis: "own",
        commentEvidence: "测试fixture合成的神评文字，不是真实用户内容。",
      },
    });
  };
  const enable = (
    p: OperationsPlan,
    permissions: OperationsBrainPermissions = {
      read: true,
      create: false,
      reviewOwn: false,
      publish: true,
    },
  ) => {
    for (const account of p.accounts) {
      if (f.service.plan(account.accountId).progress!.level! < 5)
        f.service.activate(account.accountId, true);
    }
    ops.activate(p.id, true);
    ops.brainActivate(p.id, true, permissions, p.revision);
    ops.scheduler(true);
  };
  return {
    ...f,
    ops,
    supply,
    pipix,
    turns,
    requests,
    levels,
    participation,
    dependencies,
    get time() {
      return f.time;
    },
    get submissions() {
      return f.submissions;
    },
    addAccount,
    plan,
    readySupply,
    enable,
    respond: (callback: typeof respond) => {
      respond = callback;
    },
    tool: (name: string, argumentsValue: unknown): AgentTurnResult => ({
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `mock-tool-${turns.length}`,
            type: "function",
            function: { name, arguments: JSON.stringify(argumentsValue) },
          },
        ],
      },
      finishReason: "tool_calls",
      costMicros: 0,
      costKnown: true,
      requestId: `mock-request-${turns.length}`,
      reservedMicros: 0,
    }),
    close: async () => {
      ops.close();
      participation?.close();
      supply.close();
      pipix.close();
      await f.close();
    },
  };
}
