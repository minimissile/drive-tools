import { createHash } from "node:crypto";
import {
  ideaInput,
  type IdeaContext,
  type IdeaRun,
  type IdeaReference,
} from "../shared/ideas";
import type { Keyword, Pool } from "../shared/types";
import { Repository } from "./repository";
import { AiService } from "./ai";
import { AppError } from "./errors";
import { id, now } from "./database";
import { ideaInstruction, ideaPromptVersion } from "./idea-prompt";
import { redactPromptText } from "./text-safety";

const historyKey = "keywordIdeaHistory:v1";
export const normalizeIdeaWord = (s: string) =>
  s.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, "").trim();
function text(s: unknown, limit: number) {
  return redactPromptText(String(s ?? "")).slice(0, limit);
}
function terms(words: string[]) {
  const tokens = new Set<string>();
  for (const word of words) {
    for (const part of word
      .normalize("NFKC")
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9.+#-]{1,}|[\u3400-\u9fff]{2,}/g) ?? []) {
      tokens.add(part);
      if (/^[\u3400-\u9fff]+$/.test(part))
        for (let i = 0; i < part.length - 1; i++)
          tokens.add(part.slice(i, i + 2));
    }
  }
  const generic = new Set([
    "资料",
    "教程",
    "入门",
    "模板",
    "怎么",
    "如何",
    "使用",
    "方法",
    "完整",
    "视频",
    "资源",
    "下载",
    "分享",
    "软件",
    "内容",
    "什么",
    "工具",
    "新手",
  ]);
  return [...tokens].filter((t) => !generic.has(t)).slice(0, 24);
}

export class KeywordIdeas {
  private pending = new Map<string, Promise<IdeaRun>>();
  constructor(
    private repo: Repository,
    private ai: AiService,
    private changed: () => void,
  ) {}

  preview(raw: unknown): IdeaContext {
    const input = ideaInput.parse(raw);
    const r = input.resourceId ? this.repo.getResource(input.resourceId) : null;
    input.seeds = [
      ...new Map(
        input.seeds.map((w) => [normalizeIdeaWord(w), text(w, 100)]),
      ).values(),
    ];
    input.audience = text(input.audience, 200);
    input.objective = text(input.objective, 600);
    const resource = r
      ? {
          title: text(r.title, 200),
          summary: text(r.summary, 4000),
          category: text(r.category, 100),
          tags: r.tags.slice(0, 20).map((t) => text(t, 80)),
          filenames: [
            ...new Set(
              r.copies.flatMap((c) => c.files.map((f) => text(f.name, 140))),
            ),
          ].slice(0, 30),
        }
      : null;
    if (!input.seeds.length && !resource)
      throw new AppError(
        "IDEA_TOPIC_REQUIRED",
        "请填写主题起始词，或关联一份资源。",
      );
    const queryTerms = terms(
      input.seeds.length
        ? input.seeds
        : resource
          ? [...resource.tags, resource.title]
          : [],
    );
    let references: IdeaReference[] = [],
      localCount = 0;
    if (input.useLocal && queryTerms.length) {
      // Query every stored library, including expired successful queries. Only the
      // ranked, bounded text snippets cross the AI boundary, never cache envelopes.
      const rows = this.repo.db.all<{
        ref: string;
        word: string;
        source: string;
        platform: string | null;
        fetched_at: string | null;
        pool_name: string | null;
        resource_id: string | null;
      }>(
        `
        WITH archived AS (
          SELECT *,ROW_NUMBER() OVER(PARTITION BY kind,normalized_word,coalesce(platform,''),source ORDER BY coalesce(observed_at,'') DESC,rowid DESC) recent FROM traffic_items WHERE kind IN ('word','hotspot')
        ), docs AS (
          SELECT 'archive:'||i.id prefix,NULL pool_name,NULL resource_id,json_object('word',i.word,'source',i.source,'platform',i.platform,'fetchedAt',i.observed_at) item,'object' item_type FROM archived i WHERE i.recent=1
          UNION ALL
          SELECT 'pool:'||p.id prefix,p.name pool_name,p.resource_id,json_each.value item,json_each.type item_type FROM pools p,json_each(CASE WHEN json_valid(p.keywords) THEN p.keywords ELSE '[]' END)
          UNION ALL
          SELECT 'cache:'||a.key,NULL,NULL,j.value,j.type FROM api_cache a,json_each(CASE WHEN json_valid(a.value) THEN a.value ELSE '{}' END,'$.keywords') j
          UNION ALL
          SELECT 'query:'||q.id,NULL,NULL,j.value,j.type FROM suggestion_queries q,json_each(CASE WHEN json_valid(q.result) THEN q.result ELSE '{}' END,'$.keywords') j
          UNION ALL
          SELECT 'longtail:'||a.key,NULL,NULL,CASE WHEN j.type='object' THEN json_set(j.value,'$.fetchedAt',json_extract(a.value,'$._panxuFetchedAt')) ELSE j.value END,j.type FROM api_cache a,json_each(CASE WHEN json_valid(a.value) THEN a.value ELSE '{}' END,'$.data.word') j
        ), words AS (
          SELECT prefix||':'||row_number() OVER () ref,pool_name,resource_id,
            json_extract(CASE WHEN item_type='object' THEN item ELSE '{}' END,'$.word') normalized_word,
            coalesce(json_extract(CASE WHEN item_type='object' THEN item ELSE '{}' END,'$.word'),json_extract(CASE WHEN item_type='object' THEN item ELSE '{}' END,'$.keyword'),json_extract(CASE WHEN item_type='object' THEN item ELSE '{}' END,'$.promote_word')) word,
            coalesce(json_extract(CASE WHEN item_type='object' THEN item ELSE '{}' END,'$.source'),CASE WHEN substr(prefix,1,9)='longtail:' THEN '5118 长尾词 v2（本地记录）' ELSE '本地记录（来源未标注）' END) source,
            json_extract(CASE WHEN item_type='object' THEN item ELSE '{}' END,'$.platform') platform,
            json_extract(CASE WHEN item_type='object' THEN item ELSE '{}' END,'$.fetchedAt') fetched_at
          FROM docs
        ) SELECT *,COUNT(*) OVER () corpus_count FROM words
        WHERE typeof(word)='text' AND length(word) BETWEEN 2 AND 200 AND (${queryTerms.map(() => "instr(lower(word),?)>0").join(" OR ")})
        ORDER BY ${queryTerms.map(() => "CASE WHEN instr(lower(word),?)>0 THEN 1 ELSE 0 END").join("+")} DESC,CASE WHEN resource_id=? THEN 1 ELSE 0 END DESC,coalesce(fetched_at,'') DESC,ref LIMIT 600
      `,
        ...queryTerms,
        ...queryTerms,
        input.resourceId,
      );
      localCount = Number(
        (rows[0] as (typeof rows)[0] & { corpus_count?: number })
          ?.corpus_count ?? 0,
      );
      const seen = new Set<string>();
      for (const row of rows) {
        const key = normalizeIdeaWord(row.word);
        if (seen.has(key)) continue;
        seen.add(key);
        references.push({
          id: row.ref,
          word: text(row.word, 100),
          source: text(row.source, 100),
          poolName: row.pool_name ? text(row.pool_name, 100) : null,
          platform: row.platform ? text(row.platform, 50) : null,
          fetchedAt: row.fetched_at ? text(row.fetched_at, 50) : null,
        });
        if (references.length === 50) break;
      }
    }
    return {
      input,
      resource,
      references,
      localCount,
      promptVersion: ideaPromptVersion,
      instruction: ideaInstruction,
    };
  }
  history(): IdeaRun[] {
    return this.repo.db.setting<IdeaRun[]>(historyKey, []);
  }
  generate(raw: unknown) {
    const context = this.preview(raw);
    const key = createHash("sha256")
      .update(JSON.stringify({ context, model: this.ai.modelFor("analysis") }))
      .digest("hex");
    const pending = this.pending.get(key);
    if (pending) return pending;
    const task = this.perform(context);
    this.pending.set(key, task);
    void task
      .finally(() => {
        if (this.pending.get(key) === task) this.pending.delete(key);
      })
      .catch(() => {});
    return task;
  }
  private async perform(context: IdeaContext): Promise<IdeaRun> {
    const response = await this.ai.suggestIdeas({
      topic: context.input.seeds,
      audience: context.input.audience,
      objective: context.input.objective,
      focus: context.input.focus,
      channel: context.input.channel,
      requestedCount: context.input.count,
      resource: context.resource,
      references: context.references,
    });
    const allowed = new Set(context.references.map((r) => r.id)),
      seen = new Set<string>();
    if (
      response.candidates.length > context.input.count ||
      response.candidates.some(
        (c) =>
          c.localRefIds.some((r) => !allowed.has(r)) ||
          /https?:|www\.|[\r\n<>]/i.test(c.word),
      )
    )
      throw new AppError(
        "INVALID_AI_RESPONSE",
        "模型的候选数量、词语或本地引用不符合要求，未保存候选；AI费用已记账。",
      );
    const candidates = response.candidates
      .filter((c) => {
        const k = normalizeIdeaWord(c.word);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map((c) => ({
        ...c,
        id: id("idea"),
        localRefIds: [...new Set(c.localRefIds)],
        alreadyLocal: context.references.some(
          (r) => normalizeIdeaWord(r.word) === normalizeIdeaWord(c.word),
        ),
      }));
    const run: IdeaRun = {
      id: id("ideas"),
      createdAt: now(),
      model: this.ai.modelFor("analysis"),
      context,
      strategy: response.strategy,
      candidates,
    };
    this.repo.db.setSetting(historyKey, [run, ...this.history()].slice(0, 20));
    this.changed();
    return run;
  }
  save(runId: string, selected: string[], name: string): Pool {
    const run = this.history().find((r) => r.id === runId);
    if (!run)
      throw new AppError("NOT_FOUND", "此轮联想已不在本地最近20轮历史中。");
    const selectedSet = new Set(selected),
      chosen = run.candidates.filter((c) => selectedSet.has(c.id));
    if (!chosen.length || chosen.length !== selectedSet.size)
      throw new AppError(
        "IDEA_SELECTION_REQUIRED",
        "请从当前联想结果选择有效候选词。",
      );
    if (run.context.input.resourceId)
      this.repo.getResource(run.context.input.resourceId);
    const poolId = id("pool"),
      time = now();
    const keywords: Keyword[] = chosen.map((c) => ({
      id: id("keyword"),
      word: c.word,
      intent: c.intent,
      source: "AI联想 · 待5118验证",
      platform: null,
      metrics: {},
      sourceUpdatedAt: null,
      fetchedAt: run.createdAt,
      idea: {
        runId: run.id,
        kind: c.kind,
        cluster: c.cluster,
        angle: c.angle,
        answerQuestion: c.answerQuestion,
        evidenceNeeded: c.evidenceNeeded,
        references: c.localRefIds.map(
          (r) => run.context.references.find((ref) => ref.id === r)!.word,
        ),
      },
    }));
    this.repo.db.run(
      "INSERT INTO pools(id,name,resource_id,keywords,created_at) VALUES(?,?,?,?,?)",
      poolId,
      name,
      run.context.input.resourceId,
      JSON.stringify(keywords),
      time,
    );
    this.changed();
    return this.repo.pools().find((p) => p.id === poolId)!;
  }
}
