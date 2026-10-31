import { Database, id, now, parseJson } from "../database";
import { AppError } from "../errors";
import { collectionDriveType, type CollectionDriveFilter, type CollectionResultSummary } from "../../shared/resource-collection";
import type {
  OperationRun,
  OperationItem,
  OperationKind,
  OperationStatus,
  ZhidaoAccount,
  AnswerLogEntry,
  AnswerLogPage,
} from "../../shared/zhidao";

export class OperationsStore {
  constructor(readonly db: Database, private accountView?: (account: ZhidaoAccount) => ZhidaoAccount) {}
  recover() {
    const interrupted = this.db.all<{ id: string }>(
      "SELECT id FROM operation_runs WHERE kind='answer' AND status='running'",
    );
    this.db.run(
      "UPDATE operation_runs SET status='paused',message='上次运行已中断，已保留结果；请核对后继续。',updated_at=? WHERE status='running'",
      now(),
    );
    this.db.run(
      "UPDATE operation_items SET status='uncertain',data=json_set(data,'$.status','uncertain','$.message','提交过程被中断，请核对平台结果后处理。') WHERE status='submitting'",
    );
    for (const run of interrupted)
      this.answerLog(
        run.id,
        "warning",
        "上次运行已中断，已保留回答和进度；请核对后继续。",
      );
  }
  accounts(): ZhidaoAccount[] {
    return this.db
      .all<{ data: string }>(
        "SELECT data FROM zhidao_accounts ORDER BY created_at DESC",
      )
      .map((r) => parseJson<ZhidaoAccount>(r.data, {} as ZhidaoAccount))
      .map((account) => this.accountView ? this.accountView(account) : account);
  }
  account(accountId: string) {
    const a = this.accounts().find((a) => a.id === accountId);
    if (!a) throw new AppError("NOT_FOUND", "百度知道账号不存在。");
    return a;
  }
  saveAccount(a: ZhidaoAccount) {
    this.db.run(
      "INSERT INTO zhidao_accounts(id,data,created_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      a.id,
      JSON.stringify(a),
      now(),
    );
    return a;
  }
  create(
    kind: OperationKind,
    title: string,
    config: Record<string, unknown>,
    total: number,
  ) {
    const run: OperationRun = {
      id: id("op"),
      kind,
      title,
      status: "draft",
      config,
      total,
      done: 0,
      message: "",
      createdAt: now(),
      updatedAt: now(),
    };
    this.db.run(
      "INSERT INTO operation_runs(id,kind,title,status,config,total,done,message,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      run.id,
      kind,
      title,
      run.status,
      JSON.stringify(config),
      total,
      0,
      "",
      run.createdAt,
      run.updatedAt,
    );
    return run;
  }
  run(runId: string): OperationRun {
    const r = this.db.get<any>(
      "SELECT * FROM operation_runs WHERE id=?",
      runId,
    );
    if (!r) throw new AppError("NOT_FOUND", "运营任务不存在。");
    return {
      ...r,
      config: parseJson(r.config, {}),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
  list(kind?: OperationKind, page = 1) {
    const where = kind ? "WHERE kind=?" : "";
    const args = kind ? [kind] : [];
    const rows = this.db.all<{ id: string }>(
      `SELECT id FROM operation_runs ${where} ORDER BY created_at DESC,rowid DESC LIMIT 20 OFFSET ?`,
      ...args,
      (page - 1) * 20,
    );
    return {
      items: rows.map((r) => this.run(r.id)),
      total: this.db.get<{ n: number }>(
        `SELECT count(*) n FROM operation_runs ${where}`,
        ...args,
      )!.n,
    };
  }
  activeRuns() {
    return this.db
      .all<{ id: string }>(
        "SELECT id FROM operation_runs WHERE status='running' ORDER BY created_at DESC,rowid DESC",
      )
      .map(({ id }) => {
        const { config, ...run } = this.run(id);
        return run;
      });
  }
  state(
    runId: string,
    status: OperationStatus,
    message: string,
    done?: number,
  ) {
    const previous = this.run(runId);
    this.db.run(
      "UPDATE operation_runs SET status=?,message=?,done=coalesce(?,done),updated_at=? WHERE id=?",
      status,
      message,
      done ?? null,
      now(),
      runId,
    );
    if (
      previous.kind === "answer" &&
      (previous.status !== status || previous.message !== message ||
        (done !== undefined && previous.done !== done))
    )
      this.answerLog(
        runId,
        status === "failed" ? "error" : status === "paused" ? "warning" : status === "completed" ? "success" : "info",
        message,
      );
    return this.run(runId);
  }
  answerLog(runId: string, level: AnswerLogEntry["level"], message: string) {
    if (!message.trim()) return;
    this.db.run(
      "INSERT INTO zhidao_answer_logs(run_id,level,message,created_at) VALUES(?,?,?,?)",
      runId, level, message.slice(0, 2000), now(),
    );
  }
  answerLogs(runId: string, page = 1): AnswerLogPage {
    if (this.run(runId).kind !== "answer")
      throw new AppError("INVALID_RUN", "请选择智能问答记录。");
    const total = this.db.get<{ n: number }>(
      "SELECT count(*) n FROM zhidao_answer_logs WHERE run_id=?", runId,
    )!.n;
    const pageSize = 100;
    const currentPage = Math.min(page, Math.max(1, Math.ceil(total / pageSize)));
    const items = this.db.all<AnswerLogEntry>(
      "SELECT id,level,message,created_at AS createdAt FROM zhidao_answer_logs WHERE run_id=? ORDER BY id DESC LIMIT ? OFFSET ?",
      runId, pageSize, (currentPage - 1) * pageSize,
    ).reverse();
    return { runId, items, total, page: currentPage, pageSize };
  }
  config(runId: string, config: Record<string, unknown>) {
    this.db.run(
      "UPDATE operation_runs SET config=?,updated_at=? WHERE id=?",
      JSON.stringify(config),
      now(),
      runId,
    );
  }
  item(itemId: string): OperationItem {
    const r = this.db.get<{ data: string }>(
      "SELECT data FROM operation_items WHERE id=?",
      itemId,
    );
    if (!r) throw new AppError("NOT_FOUND", "结果项不存在。");
    return parseJson(r.data, {} as OperationItem);
  }
  items(runId: string) {
    return this.db
      .all<{ data: string }>(
        "SELECT data FROM operation_items WHERE run_id=? ORDER BY rowid",
        runId,
      )
      .map((r) => parseJson<OperationItem>(r.data, {} as OperationItem));
  }
  put(runId: string, key: string, values: Partial<OperationItem>) {
    const old = this.db.get<{ id: string }>(
      "SELECT id FROM operation_items WHERE run_id=? AND item_key=?",
      runId,
      key,
    );
    const previous = old ? this.item(old.id) : null;
    const item: OperationItem = previous
      ? { ...previous, ...values }
      : {
          id: id("item"),
          runId,
          key,
          name: "",
          link: "",
          code: "",
          sourceUrl: "",
          sourceName: "",
          question: "",
          answer: "",
          questionId: "",
          answerId: "",
          taskId: "",
          copyId: "",
          shareVersion: 0,
          reviewed: false,
          status: "pending",
          message: "",
          backups: [],
          evidence: "",
          createdAt: now(),
          ...values,
        };
    this.db.run(
      "INSERT INTO operation_items(id,run_id,item_key,status,data) VALUES(?,?,?,?,?) ON CONFLICT(run_id,item_key) DO UPDATE SET status=excluded.status,data=excluded.data",
      item.id,
      runId,
      key,
      item.status,
      JSON.stringify(item),
    );
    if (this.run(runId).kind === "answer" &&
      (!previous || previous.status !== item.status || previous.message !== item.message)) {
      const labels = {
        pending: "待处理", ready: "回答已生成", failed: "回答失败",
        submitted: "回答已提交", uncertain: "提交结果待核对", skipped: "已跳过",
      };
      this.answerLog(
        runId,
        item.status === "failed" ? "error" : ["uncertain", "skipped"].includes(item.status) ? "warning" : item.status === "submitted" ? "success" : "info",
        `${labels[item.status]} · ${(item.question || item.name).slice(0, 180)}${item.message ? ` · ${item.message}` : ""}`,
      );
    }
    return item;
  }
  submitting(item: OperationItem) {
    this.db.run(
      "UPDATE operation_items SET status='submitting' WHERE id=?",
      item.id,
    );
  }
  detail(runId: string, page = 1, driveType: CollectionDriveFilter = "all") {
    const run = this.run(runId);
    if (run.kind === "collect") {
      const all = this.items(runId);
      const counts: CollectionResultSummary["counts"] = {};
      for (const item of all) {
        const type = item.link ? collectionDriveType(item.link) : "unmatched";
        counts[type] = (counts[type] ?? 0) + 1;
      }
      const items = driveType === "all" ? all : all.filter((item) => (item.link ? collectionDriveType(item.link) : "unmatched") === driveType);
      const currentPage = Math.min(page, Math.max(1, Math.ceil(items.length / 25)));
      return { run, items: items.slice((currentPage - 1) * 25, currentPage * 25), total: items.length,
        page: currentPage, pageSize: 25, collection: { driveType, total: all.length, counts } };
    }
    return {
      run,
      ...(run.kind === "answer" ? {
        answerAttention: this.db.all<{ data: string }>(
          "SELECT data FROM operation_items WHERE run_id=? AND status IN ('ready','failed','uncertain') ORDER BY rowid",
          runId,
        ).map(row => parseJson<OperationItem>(row.data, {} as OperationItem)),
      } : {}),
      items: this.db
        .all<{ data: string }>(
          "SELECT data FROM operation_items WHERE run_id=? ORDER BY rowid LIMIT 25 OFFSET ?",
          runId,
          (page - 1) * 25,
        )
        .map((r) => parseJson<OperationItem>(r.data, {} as OperationItem)),
      total: this.db.get<{ n: number }>(
        "SELECT count(*) n FROM operation_items WHERE run_id=?",
        runId,
      )!.n,
      page,
      pageSize: 25,
    };
  }
}
