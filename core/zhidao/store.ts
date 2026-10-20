import { Database, id, now, parseJson } from "../database";
import { AppError } from "../errors";
import type {
  OperationRun,
  OperationItem,
  OperationKind,
  OperationStatus,
  ZhidaoAccount,
} from "../../shared/zhidao";

export class OperationsStore {
  constructor(readonly db: Database) {}
  recover() {
    this.db.run(
      "UPDATE operation_runs SET status='paused',message='上次运行已中断，已保留结果；请核对后继续。',updated_at=? WHERE status='running'",
      now(),
    );
    this.db.run(
      "UPDATE operation_items SET status='uncertain',data=json_set(data,'$.status','uncertain','$.message','提交过程被中断，请核对平台结果后处理。') WHERE status='submitting'",
    );
  }
  accounts(): ZhidaoAccount[] {
    return this.db
      .all<{ data: string }>(
        "SELECT data FROM zhidao_accounts ORDER BY created_at DESC",
      )
      .map((r) => parseJson<ZhidaoAccount>(r.data, {} as ZhidaoAccount));
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
  state(
    runId: string,
    status: OperationStatus,
    message: string,
    done?: number,
  ) {
    this.db.run(
      "UPDATE operation_runs SET status=?,message=?,done=coalesce(?,done),updated_at=? WHERE id=?",
      status,
      message,
      done ?? null,
      now(),
      runId,
    );
    return this.run(runId);
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
    const item: OperationItem = old
      ? { ...this.item(old.id), ...values }
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
    return item;
  }
  submitting(item: OperationItem) {
    this.db.run(
      "UPDATE operation_items SET status='submitting' WHERE id=?",
      item.id,
    );
  }
  detail(runId: string, page = 1) {
    const run = this.run(runId);
    return {
      run,
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
