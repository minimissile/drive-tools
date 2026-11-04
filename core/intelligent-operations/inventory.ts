import { createHash } from "node:crypto";
import type { IntelligentOperationsDependencies } from "./types";
import type {
  OperationsAccount,
  OperationsMaterial,
  OperationsTask,
} from "../../shared/intelligent-operations";
import { intelligentOperationsStateKey } from "../../shared/intelligent-operations";
import { brainDraftSchema } from "./brain-state";

export const operationsFingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function operationsInventory(d: IntelligentOperationsDependencies) {
  const zhihu = d.zhihu.snapshot();
  const accounts: OperationsAccount[] = d.db
    .all<{ id: string }>(
      "SELECT id FROM website_accounts WHERE provider IN ('zhihu','weibo') ORDER BY created_at",
    )
    .map((row) => {
      const a = d.accounts.get(row.id),
        env = d.environments.forAccount({ kind: "website", id: a.id });
      return {
        id: a.id,
        channel: a.provider as "zhihu" | "weibo",
        label: a.nickname || a.alias,
        environmentName: env.name,
        connected: !!a.uid && a.status === "connected",
        message: a.status === "connected" ? "身份已核实" : "请检查登录身份",
      };
    });
  for (const b of d.repo.bindings().filter((b) => b.platform === "wechat"))
    accounts.push({
      id: b.id,
      channel: "wechat",
      label: b.alias,
      environmentName: "公众号内容交接",
      connected: true,
      message: "当前支持内容计划与人工交接，未接入自动发布",
    });
  const materials: OperationsMaterial[] = zhihu.contents.map((c) => ({
    id: `zhihu:${c.id}`,
    channel: "zhihu",
    accountId: c.accountId || c.source?.editorial?.accountId || null,
    title: c.title,
    purpose: c.purpose,
    reviewed: c.reviewed,
    preview: c.body,
    imageCount: c.images.length,
    fingerprint: operationsFingerprint({
      version: c.version,
      title: c.title,
      body: c.body,
      images: c.images,
      accountId: c.accountId,
    }),
  }));
  for (const p of d.weiboPosts.list())
    materials.push({
      id: `weibo:${p.id}`,
      channel: "weibo",
      accountId: p.accountId,
      title: p.text.slice(0, 80),
      purpose: "regular",
      reviewed: false,
      preview: p.text,
      visibility: p.visibility,
      imageCount: p.images.length,
      images: p.images.map((i) => ({ name: i.name, sha256: i.sha256 })),
      fingerprint: operationsFingerprint({
        id: p.id,
        accountId: p.accountId,
        uid: p.uid,
        text: p.text,
        images: p.images,
        visibility: p.visibility,
        aiAssisted:
          p.aiAssisted === true || p.source?.editorial?.aiAssisted === true,
      }),
    });
  for (const c of d.repo.drafts().filter((c) => c.platform === "wechat"))
    materials.push({
      id: `wechat:${c.id}`,
      channel: "wechat",
      accountId: null,
      title: c.title,
      purpose: "regular",
      reviewed: c.reviewed,
      preview: c.body,
      fingerprint: operationsFingerprint({
        id: c.id,
        version: c.version,
        title: c.title,
        body: c.body,
      }),
    });
  const saved = d.db.setting<{ brain?: { drafts?: unknown } }>(
    intelligentOperationsStateKey,
    {},
  );
  const brainDrafts = brainDraftSchema
    .array()
    .safeParse(saved.brain?.drafts ?? []);
  if (brainDrafts.success)
    for (const c of brainDrafts.data)
      materials.push({
        id: `wechat:${c.id}`,
        channel: "wechat",
        accountId: c.accountId,
        title: c.title,
        purpose: "regular",
        reviewed: c.reviewed,
        preview: c.body,
        fingerprint: operationsFingerprint({
          id: c.id,
          title: c.title,
          body: c.body,
        }),
      });
  return { accounts, materials, zhihu };
}
export function existingOperationsState(
  d: Pick<IntelligentOperationsDependencies, "zhihu" | "weiboPosts">,
  t: OperationsTask,
): Partial<OperationsTask> | null {
  if (t.channel === "zhihu" && t.linkedTaskId) {
    const original = d.zhihu
      .snapshot()
      .tasks.find((o) => o.id === t.linkedTaskId);
    if (!original)
      return {
        status: "attention",
        reason: "原知乎任务不存在，请核对历史；不会重建任务",
      };
    const status =
      original.status === "published"
        ? "completed"
        : original.status === "attention"
          ? "attention"
          : original.status === "cancelled"
            ? "cancelled"
            : "delegated";
    return {
      status,
      reason: original.message,
      url: original.url ?? null,
      attemptedAt: original.attemptedAt ?? null,
      submittedAt: original.submittedAt ?? null,
      scheduledAt: original.scheduledAt,
    };
  }
  if (t.channel === "weibo" && t.materialId && t.attemptedAt) {
    let p;
    try {
      p = d.weiboPosts.get(t.materialId.slice(6));
    } catch {
      return {
        status: "attention",
        reason: "原微博任务已不存在，请核对历史；不会重建或重发",
      };
    }
    if (
      p.id !== t.linkedTaskId ||
      p.accountId !== t.accountId ||
      operationsFingerprint({
        id: p.id,
        accountId: p.accountId,
        uid: p.uid,
        text: p.text,
        images: p.images,
        visibility: p.visibility,
        aiAssisted:
          p.aiAssisted === true || p.source?.editorial?.aiAssisted === true,
      }) !== t.fingerprint
    )
      return {
        status: "attention",
        reason: "原微博内容、账号或可见范围已变化，不能把新内容回执计入旧任务",
      };
    if (p.stage === "submitted" && p.url)
      return { status: "completed", reason: p.message, url: p.url };
    if (p.stage === "uncertain" || p.stage === "submitting")
      return {
        status: "attention",
        reason: "微博已进入提交阶段，结果需在原任务核对；禁止重发",
        submittedAt: t.submittedAt ?? t.attemptedAt,
      };
  }
  return null;
}
