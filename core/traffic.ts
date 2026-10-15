import { createHash } from "node:crypto";
import { endpointSpecs } from "../shared/platforms";
import type {
  Endpoint,
  Hotspot,
  Keyword,
  TrafficQuery,
  TrafficResult,
} from "../shared/types";
import { Database, id, now, parseJson } from "./database";
import { SecretStore } from "./secrets";
import { AppError, safeMessage } from "./errors";
import { fetchJson } from "./http";
import type { JsonObject } from "./providers/provider";

export const micros = (yuan: number) => Math.round(yuan * 1_000_000);
export function budgetDayStart(date = new Date()) {
  const day = new Date(date.getTime() + 8 * 3600_000)
    .toISOString()
    .slice(0, 10);
  return new Date(`${day}T00:00:00+08:00`).toISOString();
}
const suggestPlatforms = [
  "baidu",
  "baidumobile",
  "shenma",
  "360",
  "360mobile",
  "sogou",
  "sogoumobile",
  "zhihu",
  "toutiao",
  "taobao",
  "tmall",
  "pinduoduo",
  "jingdong",
  "douyin",
  "amazon",
  "xiaohongshu",
];
export class TrafficService {
  private submissions = new Map<string, Promise<TrafficResult>>();
  private suggestions = new Map<string, Promise<TrafficResult>>();
  constructor(
    private db: Database,
    private secrets: SecretStore,
    private changed: () => void,
    private requestJson = fetchJson,
  ) {}
  private reserve(
    endpoint: Endpoint | "openrouter",
    units: number,
    phase: string,
    price: number | null,
    dailyUnits: number,
    dailyBudget: number | null,
  ) {
    const callId = id("api");
    this.db.transaction(() => {
      const used = this.db.get<{ units: number; amount: number }>(
        "SELECT COALESCE(SUM(units),0) units,COALESCE(SUM(COALESCE(reserved_micros,estimated_micros,0)),0) amount FROM api_calls WHERE endpoint=? AND created_at>=? AND status IN ('reserved','success','uncertain')",
        endpoint,
        budgetDayStart(),
      );
      if ((used?.units ?? 0) + units > dailyUnits)
        throw new AppError(
          "API_BUDGET_EXCEEDED",
          "今日接口计费单位预算不足，已阻止请求；待核费用也占用预算。",
        );
      if (dailyBudget != null && price == null)
        throw new AppError(
          "API_PRICE_REQUIRED",
          "设置人民币预算前，请先录入此接口实际套餐单价。",
        );
      const amount = price == null ? null : price * units;
      if (
        dailyBudget != null &&
        (used?.amount ?? 0) + (amount ?? 0) > dailyBudget
      )
        throw new AppError(
          "API_BUDGET_EXCEEDED",
          "今日接口金额预算不足，已阻止请求。",
        );
      this.db.run(
        "INSERT INTO api_calls(id,endpoint,phase,units,estimated_micros,reserved_micros,status,created_at) VALUES(?,?,?,?,?,?,?,?)",
        callId,
        endpoint,
        phase,
        units,
        amount,
        amount,
        "reserved",
        now(),
      );
    });
    this.changed();
    return callId;
  }
  private async call(
    endpoint: Endpoint,
    body: Record<string, string>,
    units: number,
    phase: "query" | "submit" | "poll" = "query",
    beforeRequest?: () => void,
  ) {
    const key = await this.secrets.get(`5118:${endpoint}`);
    if (!key)
      throw new AppError(
        "API_KEY_REQUIRED",
        "请先在连接与设置中配置此5118接口的Key。",
      );
    const plan = this.db.get<{
      enabled: number;
      unit_price_micros: number | null;
      daily_units: number;
      daily_budget_micros: number | null;
    }>("SELECT * FROM api_plans WHERE endpoint=?", endpoint);
    if (!plan?.enabled)
      throw new AppError(
        "API_DISABLED",
        endpoint === "radar"
          ? "热点雷达尚未启用。请先确认已开通权限和数据时效，再在设置中启用。"
          : "请先启用此API并设置调用预算。",
      );
    const callId = this.reserve(
      endpoint,
      units,
      phase,
      plan.unit_price_micros,
      plan.daily_units,
      plan.daily_budget_micros,
    );
    try {
      beforeRequest?.();
      const result = await this.requestJson(
        `https://apis.5118.com${endpointSpecs[endpoint].path}`,
        {
          method: "POST",
          headers: {
            Authorization: key,
            "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
          },
          body: new URLSearchParams(body).toString(),
        },
        45_000,
      );
      const code = String(result.errcode ?? result.error_code ?? "");
      if ((phase === "poll" || endpoint === "suggest") && code === "200104") {
        this.db.run(
          "UPDATE api_calls SET status=?,message=? WHERE id=?",
          "uncertain",
          endpoint === "suggest"
            ? "5118返回200104，数据分析中；已保存分析记录，不自动再次请求，实际计费待核。"
            : "数据仍在获取中；轮询是否计费待官方对账。",
          callId,
        );
        return result;
      }
      if (code !== "0")
        throw new AppError(
          code === "100101" ? "API_QUOTA_EXHAUSTED" : "API_REMOTE_ERROR",
          `5118错误 ${code}：${String(result.errmsg ?? "请求未成功").slice(0, 180)}。本次是否计费待核实。`,
        );
      const valid =
        endpoint === "longtail"
          ? Array.isArray(result.data?.word)
          : endpoint === "suggest"
            ? Array.isArray(result.data)
            : endpoint === "metrics"
              ? phase === "submit"
                ? ["string", "number"].includes(typeof result.data?.taskid) &&
                  String(result.data.taskid).trim() !== ""
                : Array.isArray(result.data?.keyword_param)
              : Array.isArray(result.data) ||
                Array.isArray(
                  result.data?.list ??
                    result.data?.hot_list ??
                    result.data?.radar,
                );
      if (!valid)
        throw new AppError(
          "REMOTE_SCHEMA_CHANGED",
          "5118返回成功状态，但数据结构不完整；未缓存为空结果，本次计费仍待核实。",
        );
      this.db.run(
        "UPDATE api_calls SET status=?,message=? WHERE id=?",
        phase === "poll" ? "uncertain" : "success",
        phase === "poll"
          ? "查询结果已取得；轮询计次待对账。"
          : "请求成功，按套餐估算，实际扣费待官方对账。",
        callId,
      );
      return result;
    } catch (error) {
      this.db.run(
        "UPDATE api_calls SET status=?,message=? WHERE id=?",
        "uncertain",
        `${safeMessage(error)}；可能已计费，保留预算。`,
        callId,
      );
      throw error;
    } finally {
      this.changed();
    }
  }
  private async cachedCall(
    endpoint: Endpoint,
    body: Record<string, string>,
    units: number,
    useCache: boolean,
  ): Promise<JsonObject> {
    const key = createHash("sha256")
      .update(
        JSON.stringify({
          endpoint,
          body,
          revision: this.db.setting(`keyRevision:${endpoint}`, ""),
          part: true,
        }),
      )
      .digest("hex");
    if (useCache) {
      const cached = this.db.get<{ value: string }>(
        "SELECT value FROM api_cache WHERE key=? AND expires_at>?",
        key,
        now(),
      );
      if (cached) {
        this.db.run(
          "INSERT INTO api_calls(id,endpoint,phase,units,request_count,estimated_micros,reserved_micros,status,message,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
          id("api"),
          endpoint,
          "cache",
          0,
          0,
          0,
          0,
          "cache",
          "复用已成功查询的单页；未发出外部请求。",
          now(),
        );
        return parseJson<JsonObject>(cached.value, {});
      }
    }
    const result: JsonObject = {
      ...(await this.call(endpoint, body, units)),
      _panxuFetchedAt: now(),
    };
    const ttl =
      endpoint === "radar"
        ? 5 * 60_000
        : endpoint === "suggest"
          ? 10 * 60_000
          : 24 * 3600_000;
    // Checkpoint each paid request, so a later page failure cannot discard paid results.
    this.db.run(
      "INSERT OR REPLACE INTO api_cache(key,value,expires_at) VALUES(?,?,?)",
      key,
      JSON.stringify(result),
      new Date(Date.now() + ttl).toISOString(),
    );
    return result;
  }
  async query(query: TrafficQuery): Promise<TrafficResult> {
    if (query.endpoint !== "metrics" || query.taskId)
      return this.performQuery(query);
    const key = JSON.stringify(
      [...new Set(query.seeds.map((s) => s.trim()).filter(Boolean))].sort(),
    );
    const pending = this.submissions.get(key);
    if (pending) return pending;
    const operation = this.performQuery(query);
    this.submissions.set(key, operation);
    try {
      return await operation;
    } finally {
      this.submissions.delete(key);
    }
  }
  suggestionResult(queryId: string): TrafficResult {
    const row = this.db.get<{ result: string | null; status: string }>(
      "SELECT result,status FROM suggestion_queries WHERE id=?",
      queryId,
    );
    if (!row) throw new AppError("NOT_FOUND", "下拉词分析记录不存在。");
    if (row.status !== "completed" || !row.result)
      throw new AppError(
        "RESULT_NOT_READY",
        "本条分析尚未返回结果，请先核对状态。",
      );
    return {
      ...parseJson<TrafficResult>(row.result, {
        keywords: [],
        hotspots: [],
        fromCache: true,
      }),
      fromCache: true,
    };
  }
  async resumeSuggestion(queryId: string): Promise<TrafficResult> {
    const row = this.db.get<{
      seed: string;
      platform: string;
      key_revision: string;
      status: string;
      last_requested_at: string;
    }>("SELECT * FROM suggestion_queries WHERE id=?", queryId);
    if (!row) throw new AppError("NOT_FOUND", "下拉词分析记录不存在。");
    if (row.key_revision !== this.db.setting("keyRevision:suggest", ""))
      throw new AppError(
        "QUERY_KEY_CHANGED",
        "此分析使用的Key已变更。可查看已有结果；如需新查询，请使用当前Key重新填写种子词。",
      );
    if (row.status === "completed") return this.suggestionResult(queryId);
    const elapsed = Date.now() - new Date(row.last_requested_at).getTime();
    if (elapsed < 60_000)
      throw new AppError(
        "POLL_TOO_EARLY",
        `应用限制下拉词继续查询至少间隔60秒，请再等待 ${Math.ceil((60_000 - elapsed) / 1000)} 秒。`,
      );
    return this.suggestOne(row.seed, row.platform, false, true);
  }
  private suggestOne(
    seed: string,
    platform: string,
    useCache: boolean,
    resume = false,
  ): Promise<TrafficResult> {
    const revision = this.db.setting("keyRevision:suggest", "");
    const key = JSON.stringify([seed, platform, revision]);
    const active = this.suggestions.get(key);
    if (active) return active;
    const operation = this.performSuggestion(
      seed,
      platform,
      revision,
      useCache,
      resume,
    );
    this.suggestions.set(key, operation);
    void operation
      .finally(() => {
        if (this.suggestions.get(key) === operation)
          this.suggestions.delete(key);
      })
      .catch(() => {});
    return operation;
  }
  private async performSuggestion(
    seed: string,
    platform: string,
    revision: string,
    useCache: boolean,
    resume: boolean,
  ): Promise<TrafficResult> {
    const prior = this.db.get<{
      id: string;
      status: string;
      result: string | null;
      last_requested_at: string;
    }>(
      "SELECT * FROM suggestion_queries WHERE seed=? AND platform=? AND key_revision=?",
      seed,
      platform,
      revision,
    );
    const pending = (queryId: string, fromCache: boolean): TrafficResult => ({
      keywords: [],
      hotspots: [],
      pending: true,
      pendingSuggestions: [queryId],
      fromCache,
    });
    if (prior && prior.status !== "completed" && !resume)
      return pending(prior.id, true);
    if (
      prior?.status === "completed" &&
      useCache &&
      Date.now() - new Date(prior.last_requested_at).getTime() < 10 * 60_000
    ) {
      this.db.run(
        "INSERT INTO api_calls(id,endpoint,phase,units,request_count,estimated_micros,reserved_micros,status,message,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        id("api"),
        "suggest",
        "cache",
        0,
        0,
        0,
        0,
        "cache",
        "复用本地下拉词结果，未发送外部请求。",
        now(),
      );
      this.changed();
      return this.suggestionResult(prior.id);
    }
    const queryId = prior?.id ?? id("suggestion");
    let started = false;
    try {
      const result = await this.call(
        "suggest",
        { word: seed, platform },
        1,
        "query",
        () => {
          this.db.run(
            "INSERT INTO suggestion_queries(id,seed,platform,key_revision,status,message,created_at,last_requested_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(seed,platform,key_revision) DO UPDATE SET status=excluded.status,message=excluded.message,result=NULL,last_requested_at=excluded.last_requested_at",
            queryId,
            seed,
            platform,
            revision,
            "uncertain",
            "请求已发出，结果尚未确认；应用不会自动重试。",
            now(),
            now(),
          );
          started = true;
        },
      );
      if (String(result.errcode ?? result.error_code) === "200104") {
        this.db.run(
          "UPDATE suggestion_queries SET status='pending',message=? WHERE id=?",
          "5118正在分析此关键词与平台。没有远端任务ID；继续查询仍按原关键词和平台请求，可能再次计费。",
          queryId,
        );
        return pending(queryId, false);
      }
      const output: TrafficResult = {
        keywords: this.normalizeKeywords(
          result.data,
          "5118 下拉联想词",
          platform,
        ),
        hotspots: [],
        fromCache: false,
      };
      this.db.run(
        "UPDATE suggestion_queries SET status='completed',result=?,message=? WHERE id=?",
        JSON.stringify(output),
        `已保存${output.keywords.length}个候选词，可离线查看。`,
        queryId,
      );
      return output;
    } catch (error) {
      if (started)
        this.db.run(
          "UPDATE suggestion_queries SET status='uncertain',message=? WHERE id=?",
          `${safeMessage(error)}；上次费用保留待核，请核对后再决定是否继续查询。`,
          queryId,
        );
      throw error;
    } finally {
      this.changed();
    }
  }
  private async performQuery(query: TrafficQuery): Promise<TrafficResult> {
    const seeds = [
      ...new Set(query.seeds.map((s) => s.trim()).filter(Boolean)),
    ];
    if (query.endpoint === "metrics") seeds.sort();
    if (!seeds.length && query.endpoint !== "radar" && !query.taskId)
      throw new AppError("SEEDS_REQUIRED", "请填写种子词。");
    if (
      seeds.length > 50 ||
      seeds.some((s) => s.length > 100) ||
      query.pages < 1 ||
      query.pages > 5
    )
      throw new AppError(
        "QUERY_TOO_LARGE",
        "每次最多50个种子词、每词最多5页。",
      );
    if (
      query.endpoint === "suggest" &&
      !suggestPlatforms.includes(query.platform ?? "")
    )
      throw new AppError("PLATFORM_REQUIRED", "请选择接口支持的下拉词平台。");
    if (query.endpoint === "suggest") {
      if (seeds.length > 30)
        throw new AppError(
          "QUERY_TOO_LARGE",
          "请将一次找词限制在30个计费单位以内。",
        );
      const output: TrafficResult = {
        keywords: [],
        hotspots: [],
        fromCache: true,
        pendingSuggestions: [],
      };
      for (const seed of seeds) {
        const part = await this.suggestOne(
          seed,
          query.platform!,
          query.useCache,
        );
        output.keywords.push(...part.keywords);
        output.pendingSuggestions!.push(...(part.pendingSuggestions ?? []));
        output.fromCache = output.fromCache && part.fromCache;
        if (seeds.length > 1)
          await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      output.pending = output.pendingSuggestions!.length > 0;
      return output;
    }
    const keyRevision = this.db.setting(`keyRevision:${query.endpoint}`, "");
    const cacheKey = createHash("sha256")
      .update(
        JSON.stringify({ ...query, seeds, useCache: undefined, keyRevision }),
      )
      .digest("hex");
    if (query.useCache && !query.taskId) {
      const cache = this.db.get<{ value: string }>(
        "SELECT value FROM api_cache WHERE key=? AND expires_at>?",
        cacheKey,
        now(),
      );
      if (cache) {
        this.db.run(
          "INSERT INTO api_calls(id,endpoint,phase,units,request_count,estimated_micros,reserved_micros,status,message,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
          id("api"),
          query.endpoint,
          "cache",
          0,
          0,
          0,
          0,
          "cache",
          "本地缓存；未向5118发出请求。",
          now(),
        );
        this.changed();
        return {
          ...parseJson<TrafficResult>(cache.value, {
            keywords: [],
            hotspots: [],
            fromCache: true,
          }),
          fromCache: true,
        };
      }
    }
    const output: TrafficResult = {
      keywords: [],
      hotspots: [],
      fromCache: false,
    };
    if (query.endpoint === "metrics") {
      if (query.taskId) {
        const task = this.db.get<{
          last_polled_at: string | null;
          created_at: string;
          result: string | null;
          status: string;
        }>(
          "SELECT * FROM async_queries WHERE task_id=? AND endpoint=?",
          query.taskId,
          "metrics",
        );
        if (!task)
          throw new AppError(
            "UNKNOWN_TASK",
            "本地没有此查询任务记录，请不要重复提交。",
          );
        if (task.status === "uncertain" || task.status === "released")
          throw new AppError(
            "UNCERTAIN_QUERY_RESULT",
            "此提交尚未取得远端任务ID，不能轮询。请先在5118后台核对。",
          );
        if (task.result)
          return {
            ...parseJson<TrafficResult>(task.result, {
              keywords: [],
              hotspots: [],
              fromCache: true,
            }),
            fromCache: true,
          };
        const elapsed =
          Date.now() -
          new Date(task.last_polled_at ?? task.created_at).getTime();
        if (elapsed < 60_000)
          throw new AppError(
            "POLL_TOO_EARLY",
            `请等待 ${Math.ceil((60_000 - elapsed) / 1000)} 秒后再获取结果，避免无效轮询。`,
          );
        this.db.run(
          "UPDATE async_queries SET last_polled_at=? WHERE task_id=?",
          now(),
          query.taskId,
        );
        const result = await this.call(
          "metrics",
          { taskid: query.taskId },
          1,
          "poll",
        );
        if (String(result.errcode) === "200104")
          return { ...output, taskId: query.taskId, pending: true };
        output.keywords = this.normalizeKeywords(
          result.data?.keyword_param ?? [],
          "5118 搜索量 v2",
          null,
        );
        this.db.run(
          "UPDATE async_queries SET status=?,result=? WHERE task_id=?",
          "completed",
          JSON.stringify(output),
          query.taskId,
        );
        this.changed();
      } else {
        const prior = this.db
          .all<{ task_id: string; status: string; seeds: string }>(
            "SELECT task_id,status,seeds FROM async_queries WHERE endpoint='metrics' AND status IN ('pending','uncertain') ORDER BY created_at DESC",
          )
          .find(
            (row) =>
              JSON.stringify(parseJson<string[]>(row.seeds, []).sort()) ===
              JSON.stringify(seeds),
          );
        if (prior?.status === "uncertain")
          throw new AppError(
            "UNCERTAIN_QUERY_RESULT",
            "相同关键词的上次提交结果待核，已阻止重复付费。请在5118后台核对后处理待核记录。",
          );
        if (prior) return { ...output, taskId: prior.task_id, pending: true };
        let localTaskId = "";
        const result = await this.call(
          "metrics",
          { keywords: seeds.join("|") },
          seeds.length,
          "submit",
          () => {
            localTaskId = `local:${id("submission")}`;
            this.db.run(
              "INSERT INTO async_queries(task_id,endpoint,seeds,status,created_at) VALUES(?,?,?,?,?)",
              localTaskId,
              "metrics",
              JSON.stringify(seeds),
              "uncertain",
              now(),
            );
          },
        );
        const taskId = String(result.data?.taskid ?? "");
        if (!taskId)
          throw new AppError(
            "INVALID_RESPONSE",
            "5118未返回查询任务ID，请在后台核对，避免重复付费提交。",
          );
        this.db.transaction(() => {
          this.db.run("DELETE FROM async_queries WHERE task_id=?", localTaskId);
          this.db.run(
            "INSERT OR REPLACE INTO async_queries(task_id,endpoint,seeds,created_at) VALUES(?,?,?,?)",
            taskId,
            "metrics",
            JSON.stringify(seeds),
            now(),
          );
        });
        this.changed();
        return { ...output, taskId, pending: true };
      }
    } else if (query.endpoint === "radar") {
      const result = await this.call(
        "radar",
        {
          keyword: seeds[0] ?? "",
          type_name: query.type ?? "",
          page_index: "1",
          page_size: "10",
          start_time: query.startTime ?? "",
          end_time: query.endTime ?? "",
        },
        1,
      );
      const data = result.data;
      const rows: JsonObject[] = Array.isArray(data)
        ? data
        : (data?.list ?? data?.hot_list ?? data?.radar ?? []);
      if (!Array.isArray(rows))
        throw new AppError(
          "REMOTE_SCHEMA_CHANGED",
          "热点雷达返回结构无法识别，请核对接口权限和文档。",
        );
      output.hotspots = rows.map((r) => ({
        id: String(r.hot_id ?? id("hot")),
        title: String(r.hot_name ?? ""),
        type: String(r.p_type_name ?? data?.type_name ?? ""),
        sourceUpdatedAt: r.update_date == null ? null : String(r.update_date),
        fetchedAt: now(),
        events: Array.isArray(r.event_vein) ? r.event_vein : [],
        metrics: {
          event_hot_exp: r.event_hot_exp ?? null,
          baidu_pc_exp: r.baidu_pc_exp ?? null,
          baidu_move_exp: r.baidu_move_exp ?? null,
        },
      }));
    } else {
      if (seeds.length * query.pages > 30)
        throw new AppError(
          "QUERY_TOO_LARGE",
          "请将一次找词限制在30个计费单位以内。",
        );
      for (const seed of seeds) {
        for (let page = 1; page <= query.pages; page++) {
          const result = await this.cachedCall(
            "longtail",
            {
              keyword: seed,
              page_index: String(page),
              page_size: "100",
              sort_fields: "4",
              sort_type: "desc",
            },
            1,
            query.useCache,
          );
          output.keywords.push(
            ...this.normalizeKeywords(
              result.data?.word ?? [],
              "5118 长尾词 v2",
              null,
              result._panxuFetchedAt,
            ),
          );
          if (page >= Number(result.data?.page_count ?? 1)) break;
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        if (seeds.length > 1)
          await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    output.keywords = [
      ...new Map(
        output.keywords.map((k) => [`${k.word}:${k.platform}:${k.source}`, k]),
      ).values(),
    ];
    const ttl = query.endpoint === "radar" ? 5 * 60_000 : 24 * 3600_000;
    if (!query.taskId)
      this.db.run(
        "INSERT OR REPLACE INTO api_cache(key,value,expires_at) VALUES(?,?,?)",
        cacheKey,
        JSON.stringify(output),
        new Date(Date.now() + ttl).toISOString(),
      );
    return output;
  }
  private normalizeKeywords(
    rows: unknown,
    source: string,
    platform: string | null,
    fetchedAt = now(),
  ): Keyword[] {
    if (!Array.isArray(rows))
      throw new AppError("REMOTE_SCHEMA_CHANGED", "5118关键词列表格式变化。");
    return rows
      .slice(0, 5000)
      .map((r) => {
        const word = String(r.promote_word ?? r.keyword ?? "")
          .trim()
          .slice(0, 200);
        const metrics: Record<string, number | string | null> = {};
        for (const field of [
          "index",
          "mobile_index",
          "haosou_index",
          "douyin_index",
          "toutiao_index",
          "kuaishou_index",
          "weibo_index",
          "bidword_pcpv",
          "bidword_wisepv",
          "long_keyword_count",
          "sem_price",
        ])
          if (
            r[field] != null &&
            ["string", "number"].includes(typeof r[field])
          )
            metrics[field] = r[field];
        return {
          id: createHash("sha256")
            .update(source + ":" + (platform ?? "") + ":" + word)
            .digest("hex")
            .slice(0, 20),
          word,
          source,
          platform,
          metrics,
          sourceUpdatedAt: r.add_time == null ? null : String(r.add_time),
          fetchedAt,
        };
      })
      .filter((k) => k.word);
  }
}
