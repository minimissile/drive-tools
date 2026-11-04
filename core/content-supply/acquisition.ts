import { z } from "zod";
import { id, now, type Database } from "../database";
import { AppError, safeMessage } from "../errors";
import type { PipixSources } from "../pipix/service";
import { pipixRunRequests, readPipixPolicy } from "../pipix/request-budget";
import type { PipixRequestBudget } from "../pipix/request-budget";
import type { OperationsSnapshot } from "../../shared/intelligent-operations";
import type { RuntimeLog } from "../runtime-log";
import {
  pipixRequestPolicy,
  supplyAcquireInput,
  type SupplyAcquireRun,
} from "../../shared/pipix-acquisition";
import { parsePipixJson } from "../pipix/json";

const runSchema: z.ZodType<SupplyAcquireRun> = z.object({
  id: z.string(),
  status: z.enum(["running", "paused", "completed", "attention"]),
  phase: z.enum(["local", "lists", "comments", "collection", "done"]),
  context: supplyAcquireInput.omit({ confirmed: true }),
  policy: pipixRequestPolicy,
  queries: z.string().array(),
  queryIndex: z.number().int(),
  listPages: z.number().int(),
  sourceIds: z.string().array(),
  commentsDone: z.string().array(),
  commentPages: z.record(z.string(), z.number().int()),
  draftIds: z.string().array(),
  requestsUsed: z.number().int(),
  reason: z.string(),
  warnings: z.string().array(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
const prefix = "contentSupply:acquisition:v1:";
export function readSupplyAcquireRuns(db: Database) {
  return db
    .all<{ value: string }>(
      "SELECT value FROM settings WHERE key LIKE ?",
      `${prefix}%`,
    )
    .map((row) => runSchema.parse(JSON.parse(row.value)));
}
export function restoreSupplyAcquireRun(db: Database, run: SupplyAcquireRun) {
  db.setSetting(
    `${prefix}${run.id}`,
    runSchema.parse({
      ...run,
      status: run.status === "running" ? "paused" : run.status,
      reason:
        run.status === "running"
          ? "从备份恢复，需重新授权剩余请求后继续"
          : run.reason,
    }),
  );
}
const fail = (message: string): never => {
  throw new AppError("SUPPLY_ACQUISITION_BLOCKED", message);
};
export class SupplyAcquisition {
  private active: SupplyAcquireRun | null = null;
  private stopped = false;
  private closed = false;
  private grant: PipixRequestBudget | null = null;
  constructor(
    private d: {
      db: Database;
      pipix: PipixSources;
      logs: RuntimeLog;
      changed(): void;
      contentBusy(): boolean;
      operations(): OperationsSnapshot;
      ingest(
        sourceIds: string[],
        context: SupplyAcquireRun["context"],
      ): Promise<{ ids: string[]; ready: number; blocked: number }>;
    },
  ) {
    for (const row of d.db.all<{ value: string }>(
      "SELECT value FROM settings WHERE key LIKE ? AND json_extract(value,'$.status')='running'",
      `${prefix}%`,
    )) {
      const run = runSchema.parse(JSON.parse(row.value));
      run.status = "paused";
      run.reason = "运行已中断，已归档资料保留；继续时重新授权本轮剩余请求";
      this.save(run);
    }
  }
  get isBusy() {
    return !!this.active;
  }
  private read(key: string) {
    const value = this.d.db.setting<unknown>(`${prefix}${key}`, null);
    return value ? runSchema.parse(value) : fail("补料记录不存在。");
  }
  private save(run: SupplyAcquireRun) {
    if (this.closed) return;
    run.updatedAt = now();
    run.requestsUsed = pipixRunRequests(this.d.db, run.id);
    this.d.db.setSetting(`${prefix}${run.id}`, runSchema.parse(run));
    this.d.changed();
  }
  private event(
    run: SupplyAcquireRun,
    event: string,
    message: string,
    level: "info" | "warning" | "error" = "info",
    details: Record<string, unknown> = {},
  ) {
    if (!this.closed)
      this.d.logs.record({
        event,
        message,
        level,
        accountId: run.context.accountId || undefined,
        taskId: run.id,
        details: {
          phase: run.phase,
          requestsUsed: pipixRunRequests(this.d.db, run.id),
          ...details,
        },
      });
  }
  snapshot() {
    return {
      runs: this.d.db
        .all<{ value: string }>(
          "SELECT value FROM settings WHERE key LIKE ? ORDER BY rowid DESC LIMIT 20",
          `${prefix}%`,
        )
        .map((row) => {
          const run = runSchema.parse(JSON.parse(row.value));
          return { ...run, requestsUsed: pipixRunRequests(this.d.db, run.id) };
        }),
      busy: this.isBusy,
      usage: this.d.pipix.requestPolicy(),
    };
  }
  private assertIdle() {
    if (
      this.closed ||
      this.isBusy ||
      this.d.contentBusy() ||
      this.d.pipix.isBusy
    )
      fail("请等待当前采集、编辑生成或补料完成。");
  }
  start(raw: unknown) {
    this.assertIdle();
    const input = supplyAcquireInput.parse(raw),
      { confirmed: _, ...context } = input,
      queries = [
        ...new Set(
          input.keyword
            .split(/[\s,，、;；]+/)
            .map((v) => v.trim())
            .filter(Boolean),
        ),
      ].slice(0, 5);
    const ops = this.d.operations();
    if (
      input.accountId &&
      !ops.accounts.some(
        (a) =>
          a.id === input.accountId && ["zhihu", "weibo"].includes(a.channel),
      )
    )
      fail("目标账号不存在或不是已支持渠道。");
    if (
      input.planId &&
      !ops.plans.some(
        (p) =>
          p.id === input.planId &&
          (!input.accountId ||
            p.accounts.some((a) => a.accountId === input.accountId)),
      )
    )
      fail("账号未加入所选运营计划，请核对后补料。");
    const run: SupplyAcquireRun = {
      id: id("supplyrun"),
      status: "running",
      phase: "local",
      context,
      policy: readPipixPolicy(this.d.db),
      queries,
      queryIndex: 0,
      listPages: 0,
      sourceIds: [],
      commentsDone: [],
      commentPages: {},
      draftIds: [],
      requestsUsed: 0,
      reason: "先匹配本地未建单图文",
      warnings: [],
      createdAt: now(),
      updatedAt: now(),
    };
    this.save(run);
    this.event(
      run,
      "acquisition.started",
      "按方向补料已启动；先缓存，后按本轮额度请求",
    );
    this.launch(run);
    return run;
  }
  resume(key: string) {
    this.assertIdle();
    const run = this.read(key);
    if (!["paused", "attention"].includes(run.status))
      fail("仅暂停或待处理的原补料记录可以继续。");
    if (
      JSON.stringify(readPipixPolicy(this.d.db)) !== JSON.stringify(run.policy)
    )
      fail("请求设置已变更，请新建一轮；旧归档与评论仍可复用。");
    run.status = "running";
    run.reason = "继续原补料，使用本轮剩余请求额度";
    this.save(run);
    this.launch(run);
    return run;
  }
  pause() {
    if (!this.active) return false;
    this.stopped = true;
    this.grant?.stop();
    this.active.reason = "当前请求归档后暂停后续步骤";
    this.save(this.active);
    return true;
  }
  close() {
    if (this.active) {
      this.active.status = "paused";
      this.active.reason = "工作空间关闭，资料保留，未恢复计费授权";
      this.save(this.active);
    }
    this.stopped = true;
    this.grant?.stop();
    this.closed = true;
  }
  private launch(run: SupplyAcquireRun) {
    this.active = run;
    this.stopped = false;
    this.grant = this.d.pipix.requestBudget(run.id, run.policy.requestsPerRun);
    void this.execute(run, this.grant)
      .catch((error) => {
        if (this.closed) return;
        run.status = this.stopped ? "paused" : "attention";
        run.reason = safeMessage(error);
        this.event(run, "acquisition.stopped", run.reason, "warning");
        this.save(run);
      })
      .finally(() => {
        this.grant?.stop();
        this.grant = null;
        this.active = null;
        if (!this.closed) this.d.changed();
      });
  }
  private check() {
    if (this.closed || this.stopped) fail("本轮已暂停，当前响应及资料已保留。");
  }
  private candidates(run: SupplyAcquireRun) {
    const terms = run.queries.map((v) => v.toLocaleLowerCase()),
      where = terms
        .map(() => "instr(lower(i.text || ' ' || i.author),?)>0")
        .join(" OR ");
    return this.d.db
      .all<{ source_id: string }>(
        `SELECT i.source_id FROM content_knowledge_items i WHERE i.provider='pipix' AND i.kind='images' AND (${where}) AND NOT EXISTS(SELECT 1 FROM settings s WHERE s.key LIKE 'contentSupply:draft:v1:%' AND json_extract(s.value,'$.sourceId')=i.source_id) ORDER BY CASE WHEN json_extract(i.raw,'$.stats.comment_count')>0 THEN 0 ELSE 1 END,i.last_seen DESC,i.source_id DESC LIMIT ?`,
        ...terms,
        run.policy.itemsPerRun,
      )
      .map((row) => row.source_id);
  }
  private async execute(run: SupplyAcquireRun, budget: PipixRequestBudget) {
    this.check();
    if (run.phase === "local" || run.phase === "lists") {
      for (const keyword of run.queries)
        this.d.pipix.reuseList({ mode: "search", keyword });
      run.listPages = this.d.db.get<{ n: number }>(
        "SELECT COUNT(*) n FROM api_calls WHERE endpoint='tikhub:pipix' AND phase=?",
        `list:${run.id}`,
      )!.n;
      run.sourceIds = this.candidates(run);
      run.phase = "lists";
      this.save(run);
      while (
        run.sourceIds.length < run.policy.itemsPerRun &&
        run.listPages < run.policy.listPagesPerRun &&
        run.queryIndex < run.queries.length &&
        budget.used < budget.limit &&
        this.d.pipix.requestPolicy().remainingToday > 0
      ) {
        this.check();
        const keyword = run.queries[run.queryIndex],
          local = this.d.pipix.knowledge({ mode: "search", keyword });
        if (local.hasQuery && !local.next) {
          run.queryIndex++;
          this.save(run);
          continue;
        }
        const next = local.hasQuery ? local.next : null;
        run.reason = `按方向获取“${keyword}”的${next ? "下一" : "首"}页列表`;
        this.save(run);
        let result;
        try {
          result = await this.d.pipix.discover(
            {
              mode: "search",
              keyword,
              cursor: next?.cursor ?? "0",
              page: next?.page ?? 0,
            },
            budget,
          );
        } finally {
          run.listPages = this.d.db.get<{ n: number }>(
            "SELECT COUNT(*) n FROM api_calls WHERE endpoint='tikhub:pipix' AND phase=?",
            `list:${run.id}`,
          )!.n;
          this.save(run);
        }
        this.event(
          run,
          "acquisition.list_archived",
          `列表已${result.cached ? "复用" : "归档"}，返回${result.items.length}条`,
          "info",
          { keyword, responseId: result.responseId },
        );
        run.sourceIds = this.candidates(run);
        if (!result.nextCursor) run.queryIndex++;
        this.save(run);
      }
      if (
        run.sourceIds.length < run.policy.itemsPerRun &&
        (budget.used >= budget.limit ||
          !this.d.pipix.requestPolicy().remainingToday)
      )
        run.warnings.push(
          "已到请求上限，停止新增列表请求；本轮仅处理已入库的相关素材。",
        );
      if (!run.sourceIds.length) {
        run.status = "completed";
        run.phase = "done";
        run.reason = "本轮未找到与关键词匹配的未建单图文，未用无关素材凑数";
        this.save(run);
        this.event(run, "acquisition.empty", run.reason, "warning");
        return;
      }
      run.phase = "comments";
      this.save(run);
    }
    if (run.phase === "comments") {
      for (const sourceId of run.sourceIds) {
        this.check();
        if (run.commentsDone.includes(sourceId)) continue;
        const row = this.d.db.get<{ raw: string }>(
            "SELECT raw FROM content_knowledge_items WHERE provider='pipix' AND source_id=?",
            sourceId,
          ),
          raw = row ? parsePipixJson(row.raw) : null;
        if (run.context.comments && raw?.stats?.comment_count !== 0) {
          let summary = this.d.pipix.comments.read({ sourceId });
          run.commentPages[sourceId] = this.commentRequests(run.id, sourceId);
          if (summary.needsAttention) {
            summary = this.d.pipix.comments.reindex(sourceId);
            if (summary.needsAttention)
              fail(
                `来源${sourceId}的原评论响应需要核对；资料已保留，请先重建索引或明确重新请求，未自动重发。`,
              );
          }
          while (
            (!summary.responses || summary.hasMore || summary.needsAttention) &&
            (run.commentPages[sourceId] ?? 0) < run.policy.commentPagesPerItem
          ) {
            this.check();
            if (
              budget.used >= budget.limit ||
              !this.d.pipix.requestPolicy().remainingToday
            ) {
              run.warnings.push(
                `${sourceId}：已到请求上限，保留已有评论，不新增请求；可在评论库中另行明确补采。`,
              );
              break;
            }
            run.reason = `补采来源${sourceId}的评论`;
            this.save(run);
            let result;
            try {
              result = await this.d.pipix.fetchComments(
                { sourceId, confirmed: true },
                budget,
              );
            } finally {
              run.commentPages[sourceId] = this.commentRequests(
                run.id,
                sourceId,
              );
              this.save(run);
            }
            this.save(run);
            this.event(
              run,
              "acquisition.comments_archived",
              `评论页已${result.cached ? "复用" : "归档"}：${result.items.length}条文字评论`,
              "info",
              { sourceId, responseId: result.responseId },
            );
            summary = this.d.pipix.comments.read({ sourceId });
            if (!result.hasMore) break;
          }
          if (!summary.labeled)
            run.warnings.push(
              `${sourceId}：本地没有来源明确标注的神评；不得将高赞直接称为神评。`,
            );
          if (summary.hasMore)
            run.warnings.push(
              `${sourceId}：尚有后续评论，本轮按每帖页数上限停止。`,
            );
          if (summary.issue) run.warnings.push(`${sourceId}：${summary.issue}`);
        } else if (run.context.comments) {
          run.warnings.push(
            `${sourceId}：原帖本次列表标注0条评论，未为它新增评论请求。`,
          );
        }
        run.commentsDone.push(sourceId);
        this.save(run);
      }
      run.phase = "collection";
      this.save(run);
    }
    this.check();
    run.reason = "复用原采集队列，落地配图并建立待编辑资料包";
    this.save(run);
    const result = await this.d.ingest(run.sourceIds, run.context);
    run.draftIds = result.ids;
    this.check();
    run.phase = "done";
    run.status = result.blocked ? "attention" : "completed";
    run.reason = `已形成${result.ready}份待编辑资料包${result.blocked ? `，另有${result.blocked}项采集待处理` : ""}，等待作者观点与内容审阅；未发布`;
    run.warnings = [...new Set(run.warnings)];
    this.save(run);
    this.event(run, "acquisition.completed", run.reason, "info", {
      draftIds: run.draftIds,
      warnings: run.warnings,
    });
  }
  private commentRequests(runId: string, sourceId: string) {
    return this.d.db.get<{ n: number }>(
      "SELECT COUNT(*) n FROM api_calls a JOIN content_source_responses r ON r.id=a.id WHERE a.endpoint='tikhub:pipix' AND a.phase=? AND json_extract(r.request,'$.sourceId')=?",
      `comments:${runId}`,
      sourceId,
    )!.n;
  }
}
