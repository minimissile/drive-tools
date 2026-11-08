import test from "node:test";
import assert from "node:assert/strict";
import type {
  TiebaParticipationCandidate,
  TiebaReplyDraft,
} from "../shared/tieba-participation";
import {
  tiebaReplyCanRegenerate,
  tiebaReplyContextIssue,
  tiebaReplyEditable,
  tiebaReplyEditorView,
} from "../src/tieba/participation-view";

const context: NonNullable<TiebaParticipationCandidate["context"]> = {
  threadId: "123",
  forumId: "456",
  forumName: "开发",
  title: "如何整理资料",
  url: "https://tieba.baidu.com/p/123",
  authorUid: "789",
  body: "原帖提供了完整的资料整理问题和实际使用场景。",
  replies: [],
  closed: false,
  canReply: true,
  truncated: false,
  checkedAt: "2026-11-07T01:00:00Z",
};
const candidate: TiebaParticipationCandidate = {
  ...context,
  id: "tiebacandidate_test",
  targetId: "tiebatarget_test",
  accountId: "web_test",
  uid: "111",
  replyCount: 0,
  lastActiveAt: null,
  discoveredAt: context.checkedAt,
  updatedAt: context.checkedAt,
  status: "read",
  context,
  message: "",
};
const draft = {
  body: "这是一条依据原帖场景整理的可编辑回复正文。",
  version: 2,
  status: "ready",
  submittedAt: null,
  generationAttempts: 1,
} as TiebaReplyDraft;

test("贴吧回复编辑：无本地修改时跟随最新正文，有修改时保留并识别版本冲突", () => {
  assert.deepEqual(
    tiebaReplyEditorView(
      { body: "旧正文", baseBody: "旧正文", version: 1 },
      draft,
    ),
    { body: draft.body, changed: false, stale: false },
  );
  assert.deepEqual(
    tiebaReplyEditorView(
      { body: "本窗口修改", baseBody: "旧正文", version: 1 },
      draft,
    ),
    { body: "本窗口修改", changed: true, stale: true },
  );
  assert.deepEqual(
    tiebaReplyEditorView(
      { body: draft.body, baseBody: "旧正文", version: 1 },
      draft,
    ),
    { body: draft.body, changed: false, stale: false },
  );
});

test("贴吧回复上下文：缺正文、截断、锁帖、权限未知和串帖均不能生成", () => {
  assert.equal(tiebaReplyContextIssue(candidate), "");
  assert.ok(tiebaReplyContextIssue({ ...candidate, context: null }));
  for (const patch of [
    { body: "" },
    { truncated: true },
    { closed: true },
    { canReply: null },
    { threadId: "999" },
    { forumId: "999" },
  ])
    assert.ok(
      tiebaReplyContextIssue({
        ...candidate,
        context: { ...context, ...patch },
      }),
    );
  assert.ok(
    tiebaReplyContextIssue({
      ...candidate,
      status: "skipped",
      message: "上下文不适合回复",
    }),
  );
});

test("贴吧回复状态：已提交和费用未知正文锁定，只有已知生成失败可以有限再生成", () => {
  assert.equal(tiebaReplyEditable(draft), true);
  for (const status of [
    "attention",
    "uncertain",
    "submitting",
    "verified",
    "generating",
    "skipped",
  ] as const)
    assert.equal(tiebaReplyEditable({ ...draft, status }), false);
  assert.equal(
    tiebaReplyEditable({ ...draft, submittedAt: context.checkedAt }),
    false,
  );
  assert.equal(tiebaReplyCanRegenerate({ ...draft, status: "failed" }), true);
  assert.equal(tiebaReplyCanRegenerate({ ...draft, status: "skipped" }), true);
  assert.equal(
    tiebaReplyCanRegenerate({
      ...draft,
      status: "failed",
      generationAttempts: 2,
    }),
    false,
  );
  assert.equal(
    tiebaReplyCanRegenerate({ ...draft, status: "attention" }),
    false,
  );
  assert.equal(
    tiebaReplyCanRegenerate({
      ...draft,
      status: "failed",
      submittedAt: context.checkedAt,
    }),
    false,
  );
});
