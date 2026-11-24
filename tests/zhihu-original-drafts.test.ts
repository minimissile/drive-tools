import assert from "node:assert/strict";
import { test } from "node:test";
import {
  autocareOriginalBodyHash,
  findAutocareOriginalDraft,
  hasAutocareOriginalClaim,
} from "../core/zhihu-autocare/original-drafts";
import {
  autocareConfigSchema,
  type AutocareJob,
} from "../shared/zhihu-autocare";
import { zhihuFixture } from "./zhihu-fixture";

test("original spare requires explicit approval of the checked account and exact reviewed draft", async (t) => {
  const f = await zhihuFixture();
  t.after(f.close);
  const a = await f.addAccount("甲");
  const b = await f.addAccount("乙");
  const draft = f.content();
  const state = {
    config: autocareConfigSchema.parse({
      accountIds: [a.id, b.id],
      accountTargets: { [a.id]: { enabled: true, domain: "生活" } },
    }),
    jobs: [],
    identities: { [a.id]: a.uid!, [b.id]: b.uid! },
  };
  const select = (id: string) =>
    findAutocareOriginalDraft(f.service.snapshot(), state, id);
  assert.equal(select(a.id), undefined);
  assert.throws(() => f.service.setOriginalDraft(draft.id, 999, a.id), /版本/);
  f.service.setOriginalDraft(draft.id, draft.version, a.id);
  assert.equal(select(a.id)?.id, draft.id);
  assert.equal(select(b.id), undefined);
  assert.throws(
    () => f.service.setOriginalDraft(draft.id, draft.version, b.id),
    /原账号/,
  );
  state.config.accountTargets[a.id].domain = "量子计算";
  assert.equal(select(a.id), undefined);
  state.config.accountTargets[a.id].domain = "生活";
  state.identities[a.id] = "different-uid";
  assert.equal(select(a.id), undefined);
  state.identities[a.id] = a.uid!;
  const edited = f.service.saveContent({ ...draft, title: "已修改的生活随笔" });
  f.service.review(edited.id, edited.version);
  assert.equal(select(a.id), undefined);
  assert.throws(
    () => f.service.setOriginalDraft(edited.id, draft.version, a.id),
    /版本/,
  );
  f.service.setOriginalDraft(edited.id, edited.version, a.id);
  assert.equal(select(a.id)?.id, edited.id);
  f.service.setOriginalDraft(edited.id, edited.version, null);
  assert.equal(select(a.id), undefined);
});

test("original spares reject a duplicate body across accounts even after its first attempt is cancelled", async (t) => {
  const f = await zhihuFixture();
  t.after(f.close);
  const a = await f.addAccount("甲");
  const b = await f.addAccount("乙");
  const posted = f.content({ accountId: a.id });
  const draft = f.content({
    accountId: b.id,
    body: posted.body.replace("生活", "生 活"),
  });
  f.service.setOriginalDraft(draft.id, draft.version, b.id);
  const state = {
    config: autocareConfigSchema.parse({ accountIds: [a.id, b.id] }),
    jobs: [],
    identities: { [a.id]: a.uid!, [b.id]: b.uid! },
  };
  const task = f.service.enqueue(
    a.id,
    posted.id,
    new Date(f.time).toISOString(),
  );
  const select = () =>
    findAutocareOriginalDraft(f.service.snapshot(), state, b.id);
  assert.equal(select(), undefined);
  assert.throws(
    () => f.service.setOriginalDraft(posted.id, posted.version, a.id),
    /排期/,
  );
  const cancelled = f.service.cancel(task.id);
  const selected = select();
  assert.equal(selected?.id, draft.id);
  const own: AutocareJob = {
    id: "ready-original",
    kind: "article",
    accountId: b.id,
    uid: b.uid!,
    contentId: draft.id,
    sourceId: `original:${draft.id}`,
    sourceHash: autocareOriginalBodyHash(draft),
    status: "ready",
    message: "试验备用稿",
    createdAt: new Date(f.time).toISOString(),
    updatedAt: new Date(f.time).toISOString(),
    model: "",
    templateVersion: 1,
    checks: [],
  };
  assert.equal(
    hasAutocareOriginalClaim(f.service.snapshot(), [own], draft, own),
    false,
  );
  assert.equal(
    hasAutocareOriginalClaim(f.service.snapshot(), [own], draft),
    true,
  );
  f.service.store.save("zhihu_tasks", task.id, {
    ...cancelled,
    attemptedAt: new Date(f.time).toISOString(),
  });
  assert.equal(select(), undefined);
  assert.equal(
    hasAutocareOriginalClaim(f.service.snapshot(), [own], draft, own),
    true,
  );
});

test("reviewing an original spare cannot take the place of rule approval at the submit checkpoint", async (t) => {
  const f = await zhihuFixture();
  t.after(f.close);
  const a = await f.addAccount("甲");
  const draft = f.content({ accountId: a.id });
  f.service.setOriginalDraft(draft.id, draft.version, a.id);
  let approved = true;
  f.service.connectRuleAuthority({
    owns: (accountId) => accountId === a.id,
    approved: (content, accountId) =>
      approved && content.id === draft.id && accountId === a.id,
    executionPolicy: () => ({
      gapMinutes: 5,
      dailyLimit: 3,
      weeklyLimit: 10,
      deadlineAt: new Date(f.time + 60_000).toISOString(),
    }),
  });
  const task = f.service.enqueue(
    a.id,
    draft.id,
    new Date(f.time).toISOString(),
  );
  f.before(async () => {
    approved = false;
  });
  await f.service.executeRuleTask(task.id, () => true);
  const saved = f.service.store.get("zhihu_tasks", task.id);
  assert.ok(saved.attemptedAt);
  assert.equal(saved.submittedAt, undefined);
  assert.match(saved.message, /授权或版本已变化/);
  assert.equal(f.submissions, 0);
});
