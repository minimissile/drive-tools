import test from "node:test";
import assert from "node:assert/strict";
import {
  tiebaReplyTargets,
  tiebaSelectionView,
  tiebaTargetCanSign,
  tiebaTargetRunLabel,
  tiebaStartingTarget,
  tiebaTargetRefreshIds,
  tiebaAccountNeedsVerification,
} from "../src/tieba/view-model";
import {
  tiebaObservePlan,
  tiebaObserveRemaining,
  tiebaObserveResult,
} from "../src/tieba/observe-view";
import type { TiebaAutocareTarget } from "../shared/tieba-autocare";
import { tiebaInitialForums } from "../shared/tieba-forums";

test("贴吧账号核实：上次connected但本次unverified仍明确待核验，不误报新核验成功", () => {
  assert.equal(
    tiebaAccountNeedsVerification({ status: "connected", unverified: true }),
    true,
  );
  assert.equal(tiebaAccountNeedsVerification({ status: "connected" }), false);
  assert.equal(tiebaAccountNeedsVerification({ status: "disconnected" }), true);
});

test("目标资料刷新：只取当前筛选的前5个唯一ID，空筛选不扩大到其他目标", () => {
  assert.deepEqual(tiebaTargetRefreshIds([]), []);
  const ids = ["a", "b", "a", "c", "d", "e", "f"].map((id) => ({ id }));
  assert.deepEqual(tiebaTargetRefreshIds(ids), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(
    tiebaTargetRefreshIds(ids.filter((item) => item.id === "f")),
    ["f"],
  );
});

test("贴吧目标选择：没有本地修改时跟随其他窗口保存的配置", () => {
  const current = { config: { targetIds: ["new"] }, revision: 3 };
  const view = tiebaSelectionView(
    { config: { targetIds: ["old"] }, baseTargetIds: ["old"], revision: 1 },
    current,
  );
  assert.deepEqual(view, { selected: ["new"], changed: false, stale: false });
});

test("贴吧目标选择：他窗修改不覆盖当前窗口未保存的目标", () => {
  const current = { config: { targetIds: ["remote"] }, revision: 3 };
  const view = tiebaSelectionView(
    { config: { targetIds: ["local"] }, baseTargetIds: ["old"], revision: 1 },
    current,
  );
  assert.deepEqual(view, { selected: ["local"], changed: true, stale: true });
});

test("贴吧目标选择：其他窗口已保存相同目标时解除草案冲突", () => {
  const current = { config: { targetIds: ["two", "one"] }, revision: 3 };
  const view = tiebaSelectionView(
    {
      config: { targetIds: ["one", "two"] },
      baseTargetIds: ["old"],
      revision: 1,
    },
    current,
  );
  assert.deepEqual(view, {
    selected: ["two", "one"],
    changed: false,
    stale: false,
  });
});

const observed = {
  id: "tiebatarget_observed",
  accountId: "web_one",
  uid: "111",
  name: "office技巧",
  source: "observed",
  paused: false,
} as TiebaAutocareTarget;

test("贴吧起步目标：首次推荐同UID已连接未暂停目标，保留有效选择，失效选择需明确恢复", () => {
  const accounts = [
    { id: "web_one", uid: "111", status: "connected" as const },
  ];
  const paused = { ...observed, id: "paused", paused: true };
  const second = { ...observed, id: "second", name: "电子书资源" };
  const foreign = { ...observed, id: "foreign", uid: "222" };
  const targets = [paused, observed, second, foreign];
  assert.equal(
    tiebaStartingTarget("", false, targets, accounts).target?.id,
    observed.id,
  );
  assert.equal(
    tiebaStartingTarget("second", true, targets, accounts).target?.id,
    "second",
  );
  assert.equal(
    tiebaStartingTarget("deleted", true, targets, accounts).target,
    undefined,
  );
  assert.equal(
    tiebaStartingTarget("deleted", true, targets, accounts).needsRecovery,
    true,
  );
  assert.equal(
    tiebaStartingTarget("", true, targets, accounts).target,
    undefined,
  );
  assert.equal(
    tiebaStartingTarget("", false, targets, [
      { ...accounts[0], status: "expired" },
    ]).target,
    undefined,
  );
});

test("观察贴吧：只能阅读，官网关注同步后保持原ID但才可选签到；旧来源仍按关注处理", () => {
  assert.equal(tiebaTargetCanSign(observed, "111"), false);
  assert.equal(
    tiebaTargetCanSign({ ...observed, source: "followed" }, "111"),
    true,
  );
  assert.equal(
    tiebaTargetCanSign({ ...observed, source: undefined }, "111"),
    true,
  );
  assert.equal(
    tiebaTargetCanSign({ ...observed, source: "followed" }, "222"),
    false,
  );
  assert.equal(
    tiebaTargetCanSign({ ...observed, source: "followed" }, null),
    false,
  );
  assert.deepEqual(
    tiebaReplyTargets([observed, { ...observed, id: "paused", paused: true }]),
    [observed],
  );
});

test("关注恢复：unknown快照升级followed与verified后显示未选签到，不残留待核对且不自动选择", () => {
  const unknown = {
    ...observed,
    followIntent: {
      status: "uncertain" as const,
      submittedAt: "2026-11-07T10:00:00Z",
      checkedAt: null,
      message: "关注结果待核对",
    },
  };
  assert.equal(tiebaTargetRunLabel(unknown, true, false), "关注待核对");
  assert.equal(tiebaTargetCanSign(unknown, "111"), false);
  const verified = {
    ...unknown,
    source: "followed" as const,
    followIntent: {
      ...unknown.followIntent,
      status: "verified" as const,
      message: "官网已核实关注",
    },
  };
  assert.equal(tiebaTargetRunLabel(verified, true, false), "未选签到");
  assert.equal(tiebaTargetCanSign(verified, "111"), true);
  assert.equal(tiebaTargetRunLabel(verified, true, true), "已选目标");
});

test("观察贴吧：首批5条可一次提交，官方链接与规范名去重，不盲目去除吧字", () => {
  const names = tiebaInitialForums.map((forum) => forum.name);
  assert.deepEqual(
    tiebaObservePlan(
      { selectedNames: names, customText: "" },
      "web_one",
      "111",
      [],
    ).forumNames,
    names,
  );
  const result = tiebaObservePlan(
    {
      selectedNames: ["office技巧"],
      customText:
        "https://tieba.baidu.com/f?kw=OFFICE%E6%8A%80%E5%B7%A7\n  资料吧  ",
    },
    "web_one",
    "111",
    [],
  );
  assert.equal(result.issue, "");
  assert.deepEqual(result.forumNames, ["OFFICE技巧", "资料吧"]);
  assert.ok(
    tiebaObservePlan(
      { selectedNames: names, customText: "第六个" },
      "web_one",
      "111",
      [],
    ).issue,
  );
});

test("观察贴吧：非官方或不确定链接不得发起读取，错误输入完整保留", () => {
  for (const customText of [
    "https://example.com/f?kw=资料",
    "http://tieba.baidu.com/f?kw=资料",
    "https://tieba.baidu.com/p/123",
    "https://tieba.baidu.com/f?kw=资料&kw=其他",
    "https://tieba.baidu.com/f",
    "https://tieba.baidu.com/f?kw=%00资料",
  ]) {
    const plan = tiebaObservePlan(
      { selectedNames: [], customText },
      "web_one",
      "111",
      [],
    );
    assert.ok(plan.issue, customText);
    assert.deepEqual(plan.forumNames, []);
  }
});

test("观察贴吧：已有观察记录仍可明确重读更新环境，不新建重复记录", () => {
  const plan = tiebaObservePlan(
    { selectedNames: ["office技巧"], customText: "" },
    "web_one",
    "111",
    [observed],
  );
  assert.deepEqual(plan.forumNames, ["office技巧"]);
  assert.deepEqual(plan.existingNames, ["office技巧"]);
  assert.deepEqual(
    tiebaObservePlan(
      { selectedNames: ["office技巧"], customText: "" },
      "web_two",
      "222",
      [observed],
    ).existingNames,
    [],
  );
});

test("观察贴吧：仅按本次账号的明确成功剔除输入，失败保留原始链接，重试不含成功项", () => {
  const input = {
    selectedNames: ["电子书资源", "office技巧", "ppt制作教程"],
    customText: "https://tieba.baidu.com/f?kw=办公文秘\n极速office",
  };
  const names = tiebaObservePlan(input, "web_one", "111", []).forumNames;
  const outcome = tiebaObserveResult(names, "web_one", {
    accountId: "web_one",
    succeeded: ["电子书资源", "OFFICE技巧", "ppt制作教程", "办公文秘"],
    failed: [{ name: "极速office", message: "官网暂时不可读" }],
  });
  assert.deepEqual(outcome.failed, [
    { name: "极速office", message: "官网暂时不可读" },
  ]);
  const remaining = tiebaObserveRemaining(input, outcome.addedNames);
  assert.deepEqual(remaining, { selectedNames: [], customText: "极速office" });
  assert.deepEqual(
    tiebaObservePlan(remaining, "web_one", "111", []).forumNames,
    ["极速office"],
  );
  const wrongAccount = tiebaObserveResult(names, "web_other", {
    accountId: "web_one",
    succeeded: names,
    failed: [],
  });
  assert.deepEqual(wrongAccount.addedNames, []);
  assert.equal(wrongAccount.failed.length, names.length);
  assert.deepEqual(
    tiebaObserveResult(names, "web_one", undefined).addedNames,
    [],
  );
});
