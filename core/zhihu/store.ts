import { Database } from "../database";
import { AppError } from "../errors";
import type { ZhihuContent, ZhihuTask, ZhihuPlan } from "../../shared/zhihu";

type Rows = {
  zhihu_contents: ZhihuContent;
  zhihu_tasks: ZhihuTask;
  zhihu_plans: ZhihuPlan;
};
export class ZhihuStore {
  constructor(readonly db: Database) {}
  list<K extends keyof Rows>(table: K): Rows[K][] {
    return this.db
      .all<{ data: string }>(`SELECT data FROM ${table} ORDER BY rowid DESC`)
      .map((r) => JSON.parse(r.data));
  }
  get<K extends keyof Rows>(table: K, id: string): Rows[K] {
    const row = this.db.get<{ data: string }>(
      `SELECT data FROM ${table} WHERE id=?`,
      id,
    );
    if (!row) throw new AppError("NOT_FOUND", "知乎记录不存在，请刷新后重试。");
    return JSON.parse(row.data);
  }
  save<K extends keyof Rows>(table: K, id: string, value: Rows[K]): Rows[K] {
    this.db.run(
      `INSERT INTO ${table}(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`,
      id,
      JSON.stringify(value),
    );
    return value;
  }
}
