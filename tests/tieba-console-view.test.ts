import test from "node:test";
import assert from "node:assert/strict";
import type {
  TiebaAutomationConfig,
  TiebaAutomationSnapshot,
} from "../shared/tieba-automation";
import type { TiebaTopicDraft, TiebaTopicRule } from "../shared/tieba-topics";
import {
  tiebaAutomationConfigView,
  tiebaAutomationInitialRecommendation,
  tiebaInsightsRefreshFeedback,
  tiebaSignedDelta,
  tiebaVisibilityLabel,
  tiebaTargetRefreshFeedback,
} from "../src/tieba/console-view";
import {
  emptyTiebaTopicSource,
  tiebaTopicCanReconcile,
  tiebaTopicEditable,
  tiebaTopicEditorView,
  tiebaTopicFormHash,
  tiebaTopicRuleView,
} from "../src/tieba/topic-view";

test("自动回帖起步：只在初始未保存状态推荐首5个草稿目标，不扩大保存过的范围或授权", () => {
  const snapshot = {
    revision: 1,
    enabled: false,
    busy: false,
    config: { targetIds: [], mode: "draft", dailyLimit: 1 },
    run: null,
    tasks: [],
    accounts: [{ id: "account", uid: "111", status: "connected" }],
    targets: Array.from({ length: 6 }, (_, i) => ({
      id: `target_${i}`,
      accountId: "account",
      uid: "111",
      paused: false,
    })),
  } as unknown as TiebaAutomationSnapshot;
  assert.deepEqual(tiebaAutomationInitialRecommendation(snapshot), {
    targetIds: ["target_0", "target_1", "target_2", "target_3", "target_4"],
    mode: "draft",
    dailyLimit: 1,
  });
  assert.equal(snapshot.enabled, false);
  assert.equal(
    tiebaAutomationInitialRecommendation({ ...snapshot, revision: 2 }),
    null,
  );
  assert.equal(
    tiebaAutomationInitialRecommendation({
      ...snapshot,
      config: { ...snapshot.config, targetIds: ["target_0"] },
    }),
    null,
  );
  assert.equal(
    tiebaAutomationInitialRecommendation({ ...snapshot, enabled: true }),
    null,
  );
});

test("自动回帖设置：未修改草稿跟随官网本地设置；未保存范围与模式不被他窗覆盖", () => {
  const base: TiebaAutomationConfig = {
    targetIds: ["one"],
    mode: "draft",
    dailyLimit: 1,
  };
  const remote: TiebaAutomationConfig = {
    targetIds: ["two"],
    mode: "draft",
    dailyLimit: 2,
  };
  assert.deepEqual(
    tiebaAutomationConfigView(
      { config: base, base, revision: 1 },
      { config: remote, revision: 2 },
    ),
    { config: remote, changed: false, stale: false },
  );
  const edited: TiebaAutomationConfig = { ...base, mode: "publish" };
  assert.deepEqual(
    tiebaAutomationConfigView(
      { config: edited, base, revision: 1 },
      { config: remote, revision: 2 },
    ),
    { config: edited, changed: true, stale: true },
  );
  assert.deepEqual(
    tiebaAutomationConfigView(
      { config: edited, base, revision: 1 },
      { config: edited, revision: 3 },
    ),
    { config: edited, changed: false, stale: false },
  );
});

const topic = {
  id: "tiebatopic_test",
  version: 2,
  status: "ready",
  submittedAt: null,
  title: "资料整理方法",
  body: "先保留原始目录，再按使用目的建立索引，统一主题与年份命名。",
  source: {
    ...emptyTiebaTopicSource,
    title: "本人资料整理记录",
    body: "实际材料正文，说明资料来源与当前整理流程。",
  },
} as TiebaTopicDraft;

test("主题编辑：远端生成不覆盖本窗口已编辑标题、正文与材料", () => {
  const local = {
    title: topic.title,
    body: topic.body,
    source: topic.source,
    version: 1,
    base: tiebaTopicFormHash(topic),
  };
  const remote = { ...topic, body: "另一窗口更新后的主题正文。", version: 3 };
  assert.equal(tiebaTopicEditorView(local, remote).form.body, remote.body);
  const edited = {
    ...local,
    source: {
      ...local.source,
      sourceUrl: "https://example.com/my-source",
      rightsNote: "已获许可用于该吧讨论",
    },
  };
  const result = tiebaTopicEditorView(edited, remote);
  assert.equal(result.changed, true);
  assert.equal(result.stale, true);
  assert.deepEqual(result.form.source, edited.source);
});

test("主题状态：未知、审核中和费用中断禁止编辑重发，审核中与未知仅核实原提交", () => {
  for (const status of [
    "uncertain",
    "pending_review",
    "attention",
    "generating",
    "submitting",
    "verified",
  ] as const)
    assert.equal(tiebaTopicEditable({ ...topic, status }), false, status);
  assert.equal(tiebaTopicEditable({ ...topic, status: "failed" }), true);
  assert.equal(
    tiebaTopicEditable({
      ...topic,
      status: "ready",
      submittedAt: "2026-11-07T00:00:00Z",
    }),
    false,
  );
  assert.equal(
    tiebaTopicCanReconcile({
      ...topic,
      status: "uncertain",
      submittedAt: "2026-11-07T00:00:00Z",
    }),
    true,
  );
  assert.equal(
    tiebaTopicCanReconcile({
      ...topic,
      status: "pending_review",
      submittedAt: "2026-11-07T00:00:00Z",
    }),
    true,
  );
  assert.equal(
    tiebaTopicCanReconcile({ ...topic, status: "attention" }),
    false,
  );
  assert.equal(
    tiebaTopicCanReconcile({
      ...topic,
      status: "verified",
      submittedAt: "2026-11-07T00:00:00Z",
    }),
    false,
  );
});

test("逐吧规则：无修改时跟随他窗图片许可，实际修改保留且识别版本冲突", () => {
  const local = {
    note: "旧的规则",
    base: "旧的规则",
    allowImages: false,
    baseAllowImages: false,
    version: 1,
  };
  const remote = {
    targetId: "one",
    note: "他窗更新的规则",
    allowImages: true,
    version: 2,
    checkedAt: "2026-11-07T00:00:00Z",
  } satisfies TiebaTopicRule;
  assert.deepEqual(tiebaTopicRuleView(local, remote), {
    note: remote.note,
    allowImages: true,
    changed: false,
    stale: false,
  });
  assert.deepEqual(
    tiebaTopicRuleView({ ...local, note: "本窗口新规则" }, remote),
    { note: "本窗口新规则", allowImages: false, changed: true, stale: true },
  );
  assert.deepEqual(
    tiebaTopicRuleView(
      { ...local, note: remote.note, allowImages: true },
      remote,
    ),
    { note: remote.note, allowImages: true, changed: false, stale: false },
  );
});

test("运营复盘：真实零变化不冒充缺历史，未知与官网审核状态分别表达", () => {
  assert.equal(tiebaSignedDelta(null), "暂无可比记录");
  assert.equal(tiebaSignedDelta(0), "与上次相同");
  assert.equal(tiebaSignedDelta(3), "较上次 +3");
  assert.equal(tiebaSignedDelta(-1), "较上次 -1");
  assert.equal(tiebaVisibilityLabel("unknown"), "可见性未知");
  assert.equal(tiebaVisibilityLabel("pending_review"), "官网提示审核中");
  assert.equal(tiebaVisibilityLabel("unexpected"), "可见性未知");
});

test("运营复盘刷新：只按本次明确结果报告成功，部分与全部失败不能显示成功", () => {
  assert.equal(
    tiebaInsightsRefreshFeedback({
      refreshResult: { succeeded: ["one"], failed: [] },
    }).tone,
    "success",
  );
  assert.equal(
    tiebaInsightsRefreshFeedback({
      refreshResult: {
        succeeded: ["one"],
        failed: [{ id: "two", message: "官网超时" }],
      },
    }).tone,
    "warning",
  );
  assert.equal(
    tiebaInsightsRefreshFeedback({
      refreshResult: {
        succeeded: [],
        failed: [{ id: "two", message: "需要核对原主题" }],
      },
    }).tone,
    "error",
  );
  assert.equal(tiebaInsightsRefreshFeedback({}).tone, "warning");
});

test("目标资料反馈：按实际刷新结果统计，保留账号或环境的具体失败原因", () => {
  const targets = [{ id: "one", name: "office技巧" }];
  const failed = tiebaTargetRefreshFeedback(
    {
      refreshResult: {
        succeeded: [],
        failed: [{ id: "one", message: "账号环境尚未核实" }],
      },
    },
    targets,
  );
  assert.equal(failed.tone, "error");
  assert.match(failed.text, /office技巧：账号环境尚未核实/);
  assert.equal(
    tiebaTargetRefreshFeedback(
      {
        refreshResult: {
          succeeded: ["two"],
          failed: [{ id: "one", message: "官网资料暂不可识别" }],
        },
      },
      targets,
    ).tone,
    "warning",
  );
  assert.equal(tiebaTargetRefreshFeedback({}, targets).tone, "warning");
});
