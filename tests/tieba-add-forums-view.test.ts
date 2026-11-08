import test from "node:test";
import assert from "node:assert/strict";
import type { TiebaForumDiscoveryItem } from "../shared/tieba-forum-discovery";
import {
  tiebaAddPlan,
  tiebaAddRemaining,
  tiebaAdditionResult,
  tiebaFilterForums,
  tiebaLowReplyCandidate,
} from "../src/tieba/add-forums-view";

const item = (
  name: string,
  memberCount: number | null,
  postCount: number | null,
  sampledThreads = 0,
  zeroReplyThreads = 0,
) =>
  ({
    name,
    memberCount,
    postCount,
    sampledThreads,
    zeroReplyThreads,
    forumId: null,
    url: "https://tieba.baidu.com/f?kw=" + encodeURIComponent(name),
    description: "",
    threadCount: null,
    latestActiveLabel: null,
    checkedAt: "2026-11-07T00:00:00Z",
  }) satisfies TiebaForumDiscoveryItem;
test("找吧筛选：仅筛本次已读候选，设置上限排除未知，未设上限保留未知", () => {
  const values = [
    item("小吧", 100, 200, 4, 3),
    item("未知", null, null),
    item("人数大", 1000, 100),
    item("帖子多", 100, 500),
  ];
  assert.deepEqual(
    tiebaFilterForums(values, {
      memberMax: "300",
      postMax: "300",
      lowReplies: false,
    }).items.map((v) => v.name),
    ["小吧"],
  );
  assert.deepEqual(
    tiebaFilterForums(
      [item("真实0", 0, 0), item("未知", null, null), item("边界", 100, 200)],
      { memberMax: "0", postMax: "0", lowReplies: false },
    ).items.map((value) => value.name),
    ["真实0"],
  );
  assert.deepEqual(
    tiebaFilterForums([item("边界", 100, 200)], {
      memberMax: "100",
      postMax: "200",
      lowReplies: false,
    }).items.map((value) => value.name),
    ["边界"],
  );
  assert.ok(
    tiebaFilterForums(values, {
      memberMax: "-1",
      postMax: "",
      lowReplies: false,
    }).issue,
  );
  assert.equal(
    tiebaFilterForums(values, { memberMax: "", postMax: "", lowReplies: false })
      .items.length,
    4,
  );
});
test("低回复候选：必须至少3个真实样本且零回复不少于一半，不凭未知或关注人数判断", () => {
  assert.equal(
    tiebaLowReplyCandidate({ sampledThreads: 2, zeroReplyThreads: 2 }),
    false,
  );
  assert.equal(
    tiebaLowReplyCandidate({ sampledThreads: 3, zeroReplyThreads: 2 }),
    true,
  );
  assert.equal(
    tiebaLowReplyCandidate({ sampledThreads: 4, zeroReplyThreads: 2 }),
    true,
  );
  assert.equal(
    tiebaLowReplyCandidate({ sampledThreads: 4, zeroReplyThreads: 1 }),
    false,
  );
  assert.equal(
    tiebaLowReplyCandidate({ sampledThreads: 0, zeroReplyThreads: 0 }),
    false,
  );
  assert.equal(
    tiebaLowReplyCandidate({ sampledThreads: 3, zeroReplyThreads: 4 }),
    false,
  );
});
test("添加贴吧：初始空选择不授权，跨来源去重且仍受5条上限约束", () => {
  assert.deepEqual(
    tiebaAddPlan({ selectedNames: [], customText: "" }, "one", "111", [])
      .forumNames,
    [],
  );
  const result = tiebaAddPlan(
    {
      selectedNames: ["office技巧"],
      customText:
        "https://tieba.baidu.com/f?kw=OFFICE%E6%8A%80%E5%B7%A7\n电子书pdf",
    },
    "one",
    "111",
    [],
  );
  assert.equal(result.issue, "");
  assert.deepEqual(result.forumNames, ["OFFICE技巧", "电子书pdf"]);
  assert.ok(
    tiebaAddPlan(
      { selectedNames: ["一", "二", "三", "四", "五"], customText: "六" },
      "one",
      "111",
      [],
    ).issue,
  );
});
test("添加逐项结果：仅同账号明确followed移除，unknown/失败/未执行原文字保留", () => {
  const input = {
    selectedNames: ["office技巧", "电子书pdf"],
    customText: "https://tieba.baidu.com/f?kw=mobi电子书\n办公资料",
  };
  const names = tiebaAddPlan(input, "one", "111", []).forumNames;
  const outcome = tiebaAdditionResult(names, "one", {
    accountId: "one",
    items: [
      { name: "OFFICE技巧", status: "followed", message: "已核实关注" },
      { name: "电子书pdf", status: "uncertain", message: "仅核对原关注" },
      { name: "mobi电子书", status: "failed", message: "未执行：前项待核对" },
      { name: "办公资料", status: "failed", message: "未执行：原批次已中止" },
    ],
  });
  assert.deepEqual(outcome.followed, ["office技巧"]);
  assert.equal(outcome.remaining.length, 3);
  assert.equal(outcome.remaining[0].status, "uncertain");
  assert.deepEqual(tiebaAddRemaining(input, outcome.followed), {
    selectedNames: ["电子书pdf"],
    customText: input.customText,
  });
  assert.deepEqual(
    tiebaAdditionResult(names, "other", {
      accountId: "one",
      items: names.map((name) => ({
        name,
        status: "followed",
        message: "旧账号结果",
      })),
    }).followed,
    [],
  );
  assert.deepEqual(tiebaAdditionResult(names, "one", undefined).followed, []);
});
