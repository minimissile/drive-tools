import { z } from "zod";
import { id, now } from "./database";
import { AppError } from "./errors";
import { Repository, type Row } from "./repository";
import { Operations } from "./operations";
import { localTemplate } from "./templates";
import {
  effectInput,
  topicFacts,
  topicInput,
  type EffectRecord,
  type SearchDetail,
  type SearchPage,
  type SearchTargets,
  type SearchTopic,
} from "../shared/search";
import type { Draft, Publication } from "../shared/types";

const normalize = (s: string) =>
  s.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
const topicSelect = `SELECT t.*,r.id resource_id,r.title resource_title,c.account_id,
  c.status copy_status,c.owner_uid,c.verified_at copy_verified,c.share_version copy_share_version,
  c.share_verified_at,c.share_owner_uid,a.uid,a.enabled,
  si.path,si.status split_status,si.verified_at split_verified,si.owner_uid split_owner,si.share_version item_share_version,
  d.id draft_id,d.title draft_title,d.reviewed,d.resource_revision,d.share_version draft_share_version,d.split_share_version,
  p.id publication_id,p.url publication_url,p.draft_id published_draft_id
  FROM search_topics t LEFT JOIN copies c ON c.id=t.copy_id LEFT JOIN resources r ON r.id=c.resource_id
  LEFT JOIN accounts a ON a.id=c.account_id LEFT JOIN split_items si ON si.id=t.split_item_id
  LEFT JOIN drafts d ON d.id=(SELECT id FROM drafts WHERE topic_id=t.id AND copy_id=t.copy_id AND split_item_id IS t.split_item_id ORDER BY updated_at DESC,version DESC,rowid DESC LIMIT 1)
  LEFT JOIN publications p ON p.id=(SELECT p2.id FROM publications p2 JOIN drafts d2 ON d2.id=p2.draft_id WHERE d2.topic_id=t.id AND d2.copy_id=t.copy_id AND d2.split_item_id IS t.split_item_id AND p2.status='published' ORDER BY p2.created_at DESC,p2.rowid DESC LIMIT 1)`;

export class SearchOperations {
  constructor(
    private repo: Repository,
    private operations: Operations,
    private changed: () => void,
  ) {}
  private get db() {
    return this.repo.db;
  }
  private row(id: string) {
    const row = this.db.get<Row>(`${topicSelect} WHERE t.id=?`, id);
    if (!row) throw new AppError("NOT_FOUND", "搜索选题不存在。");
    return row;
  }
  private topic(r: Row): SearchTopic {
    const attention: string[] = [];
    if (r.copy_id) {
      if (
        !r.enabled ||
        !r.uid ||
        r.owner_uid !== r.uid ||
        !r.copy_verified ||
        r.copy_status !== "ready"
      )
        attention.push("本人副本需要重新核验");
      if (
        r.split_item_id
          ? r.split_status !== "ready" ||
            !r.split_verified ||
            r.split_owner !== r.uid
          : !r.share_verified_at || r.share_owner_uid !== r.uid
      )
        attention.push("配套分享需要核验或恢复");
      if (r.draft_id) {
        const revision = this.db.get<Row>(
          "SELECT revision FROM resources WHERE id=?",
          r.resource_id,
        )?.revision;
        if (
          r.resource_revision !== revision ||
          (r.split_item_id
            ? r.split_share_version !== r.item_share_version
            : r.draft_share_version !== r.copy_share_version)
        )
          attention.push("资料或分享已更新，请重新审阅");
        if (r.publication_id && r.published_draft_id !== r.draft_id)
          attention.push("有新草稿版本尚未发布");
      }
    }
    return {
      id: r.id,
      keyword: r.keyword,
      intent: r.intent,
      platform: r.platform,
      poolId: r.pool_id,
      keywordId: r.keyword_id,
      copyId: r.copy_id,
      splitItemId: r.split_item_id,
      resourceId: r.resource_id ?? null,
      resourceTitle: r.resource_title ?? null,
      targetPath: r.split_item_id
        ? (r.path ?? "拆分项不可用")
        : r.copy_id
          ? "整份资料"
          : null,
      softwareVersion: r.software_version,
      operatingSystem: r.operating_system,
      evidence: r.evidence,
      draftId: r.draft_id ?? null,
      draftTitle: r.draft_title ?? null,
      reviewed: !!r.reviewed,
      publicationId: r.publication_id ?? null,
      publicationUrl: r.publication_url ?? null,
      stage: !r.copy_id
        ? "unbound"
        : r.publication_id
          ? "published"
          : "writing",
      attention,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
  list(raw: unknown): SearchPage {
    const input = z
      .object({
        query: z.string().trim().max(200).default(""),
        stage: z
          .enum(["all", "unbound", "writing", "published"])
          .default("all"),
        page: z.number().int().min(1).max(100000).default(1),
        pageSize: z.number().int().min(1).max(100).default(60),
      })
      .parse(raw);
    const counts = { unbound: 0, writing: 0, published: 0 };
    // Only light read models enter the board; full draft bodies are loaded on demand.
    const matches = this.db
      .all<Row>(
        `${topicSelect} WHERE t.archived=0 ORDER BY t.updated_at DESC,t.rowid DESC`,
      )
      .filter(
        (r) =>
          !input.query ||
          `${r.keyword} ${r.intent} ${r.resource_title ?? ""}`
            .toLocaleLowerCase()
            .includes(input.query.toLocaleLowerCase()),
      );
    for (const r of matches)
      counts[
        !r.copy_id ? "unbound" : r.publication_id ? "published" : "writing"
      ]++;
    const filtered = matches.filter(
      (r) =>
        input.stage === "all" ||
        (!r.copy_id
          ? "unbound"
          : r.publication_id
            ? "published"
            : "writing") === input.stage,
    );
    const page = Math.min(
      input.page,
      Math.max(1, Math.ceil(filtered.length / input.pageSize)),
    );
    return {
      items: filtered
        .slice((page - 1) * input.pageSize, page * input.pageSize)
        .map((r) => this.topic(r)),
      total: filtered.length,
      page,
      counts,
    };
  }
  get(topicId: string): SearchDetail {
    const topic = this.topic(this.row(topicId));
    const publications = this.db
      .all<Row>(
        "SELECT p.* FROM publications p JOIN drafts d ON d.id=p.draft_id WHERE d.topic_id=? AND p.status='published' ORDER BY p.created_at DESC,p.rowid DESC",
        topicId,
      )
      .map(
        (r) =>
          ({
            id: r.id,
            draftId: r.draft_id,
            draftVersion: r.draft_version,
            bindingId: r.binding_id,
            status: r.status,
            url: r.url,
            createdAt: r.created_at,
          }) as Publication,
      );
    const effects = this.db
      .all<Row>(
        `SELECT e.* FROM effect_records e WHERE e.topic_id=? OR (e.scope='account' AND e.binding_id IN (SELECT p.binding_id FROM publications p JOIN drafts d ON d.id=p.draft_id WHERE d.topic_id=? AND p.status='published')) ORDER BY e.created_at DESC,e.rowid DESC`,
        topicId,
        topicId,
      )
      .map((r) => this.effect(r));
    return {
      topic,
      draft: topic.draftId ? this.repo.draft(topic.draftId) : null,
      publications,
      effects,
    };
  }
  assertTarget(copyId: string, splitItemId: string | null) {
    const copy = this.repo.getCopy(copyId),
      account = this.repo.getAccount(copy.accountId);
    if (
      !account.enabled ||
      !account.uid ||
      copy.status !== "ready" ||
      !copy.verifiedAt ||
      copy.ownerUid !== account.uid
    )
      throw new AppError("OWNERSHIP_UNVERIFIED", "请先完成本人资料副本核验。");
    const split = splitItemId ? this.operations.splitItem(splitItemId) : null;
    if (split) {
      if (
        split.copyId !== copy.id ||
        split.status !== "ready" ||
        !split.verifiedAt ||
        !split.shareId ||
        !split.shareUrl ||
        split.ownerUid !== account.uid
      )
        throw new AppError(
          "OWNERSHIP_UNVERIFIED",
          "请选择此本人副本下已核验的拆分链接。",
        );
    } else if (
      !copy.shareId ||
      !copy.shareUrl ||
      !copy.shareVerifiedAt ||
      copy.shareOwnerUid !== account.uid
    )
      throw new AppError(
        "OWNERSHIP_UNVERIFIED",
        "整份资料的本人分享尚未核验。",
      );
    const url = split?.shareUrl ?? copy.shareUrl;
    if (url === this.repo.getResource(copy.resourceId).sourceUrl)
      throw new AppError(
        "FOREIGN_SHARE_BLOCKED",
        "来源链接不能作为配套本人资料。",
      );
    return { copy, account, split };
  }
  targets(raw: unknown): SearchTargets {
    const i = z
        .object({
          copyId: z.string(),
          page: z.number().int().min(1).default(1),
          query: z.string().max(200).default(""),
        })
        .parse(raw),
      copy = this.repo.getCopy(i.copyId),
      a = this.repo.getAccount(copy.accountId);
    let wholeReady = true;
    try {
      this.assertTarget(copy.id, null);
    } catch {
      wholeReady = false;
    }
    if (
      !a.enabled ||
      !a.uid ||
      copy.ownerUid !== a.uid ||
      !copy.verifiedAt ||
      copy.status !== "ready"
    )
      return {
        copyId: copy.id,
        wholeReady: false,
        items: [],
        total: 0,
        page: 1,
      };
    const rows = this.db
      .all<Row>(
        "SELECT id,path FROM split_items WHERE copy_id=? AND status='ready' AND verified_at IS NOT NULL AND owner_uid=? ORDER BY path",
        copy.id,
        a.uid,
      )
      .filter((r) =>
        r.path.toLocaleLowerCase().includes(i.query.toLocaleLowerCase()),
      );
    const page = Math.min(i.page, Math.max(1, Math.ceil(rows.length / 50)));
    return {
      copyId: copy.id,
      wholeReady,
      items: rows
        .slice((page - 1) * 50, page * 50)
        .map((r) => this.operations.splitItem(r.id)),
      total: rows.length,
      page,
    };
  }
  create(raw: unknown, notify = true): SearchTopic {
    const i = topicInput.parse(raw);
    if (i.splitItemId && !i.copyId)
      throw new AppError("TARGET_REQUIRED", "拆分项必须关联原资料副本。");
    if (i.copyId) this.assertTarget(i.copyId, i.splitItemId);
    let keyword = i.keyword,
      intent = i.intent;
    if (i.poolId) {
      const pool = this.repo.pools().find((p) => p.id === i.poolId),
        word = pool?.keywords.find((k) => k.id === i.keywordId);
      if (!pool || !word || word.word !== i.keyword)
        throw new AppError("KEYWORD_MISMATCH", "该关键词不属于所选词池。");
      if (
        i.copyId &&
        pool.resourceId &&
        this.repo.getCopy(i.copyId).resourceId !== pool.resourceId
      )
        throw new AppError("RESOURCE_MISMATCH", "词池与所选资料不匹配。");
      keyword = word.word;
      intent = intent || word.intent || "";
    } else if (i.keywordId)
      throw new AppError("KEYWORD_MISMATCH", "请选择关键词来源词池。");
    if (
      this.db.get(
        "SELECT id FROM search_topics WHERE normalized_keyword=? AND platform=? AND archived=0",
        normalize(keyword),
        i.platform,
      )
    )
      throw new AppError(
        "DUPLICATE_TOPIC",
        "此平台已有相同关键词的选题，请继续已有选题。",
      );
    const topicId = id("topic"),
      time = now();
    this.db.run(
      "INSERT INTO search_topics(id,keyword,normalized_keyword,intent,platform,pool_id,keyword_id,copy_id,split_item_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      topicId,
      keyword,
      normalize(keyword),
      intent,
      i.platform,
      i.poolId,
      i.keywordId,
      i.copyId,
      i.splitItemId,
      time,
      time,
    );
    if (notify) this.changed();
    return this.get(topicId).topic;
  }
  importPool(raw: unknown) {
    const i = z
        .object({
          poolId: z.string(),
          keywordIds: z.array(z.string()).min(1).max(100),
          platform: topicInput.shape.platform,
        })
        .parse(raw),
      pool = this.repo.pools().find((p) => p.id === i.poolId);
    if (
      !pool ||
      i.keywordIds.some((id) => !pool.keywords.some((k) => k.id === id))
    )
      throw new AppError("KEYWORD_MISMATCH", "选择的词池或关键词不存在。");
    let created = 0,
      skipped = 0;
    this.db.transaction(() => {
      for (const key of new Set(i.keywordIds)) {
        const k = pool.keywords.find((k) => k.id === key)!;
        if (
          this.db.get(
            "SELECT id FROM search_topics WHERE normalized_keyword=? AND platform=? AND archived=0",
            normalize(k.word),
            i.platform,
          )
        ) {
          skipped++;
          continue;
        }
        this.create(
          {
            keyword: k.word,
            intent: k.intent ?? "",
            platform: i.platform,
            poolId: pool.id,
            keywordId: k.id,
          },
          false,
        );
        created++;
      }
    });
    this.changed();
    return { created, skipped };
  }
  bind(raw: unknown) {
    const i = z
        .object({
          id: z.string(),
          copyId: z.string(),
          splitItemId: z.string().nullable(),
        })
        .parse(raw),
      topic = this.row(i.id);
    const { copy } = this.assertTarget(i.copyId, i.splitItemId);
    if (topic.pool_id) {
      const pool = this.repo.pools().find((p) => p.id === topic.pool_id);
      if (pool?.resourceId && pool.resourceId !== copy.resourceId)
        throw new AppError(
          "RESOURCE_MISMATCH",
          "此选题的词池属于其他资料，请选择对应资源。",
        );
    }
    this.db.run(
      "UPDATE search_topics SET copy_id=?,split_item_id=?,updated_at=? WHERE id=?",
      i.copyId,
      i.splitItemId,
      now(),
      i.id,
    );
    this.changed();
    return this.get(i.id).topic;
  }
  facts(raw: unknown) {
    const i = topicFacts
      .extend({ id: z.string(), intent: z.string().trim().max(100) })
      .parse(raw);
    this.row(i.id);
    this.db.transaction(() => {
      this.db.run(
        "UPDATE search_topics SET intent=?,software_version=?,operating_system=?,evidence=?,updated_at=? WHERE id=?",
        i.intent,
        i.softwareVersion,
        i.operatingSystem,
        i.evidence,
        now(),
        i.id,
      );
      this.db.run("UPDATE drafts SET reviewed=0 WHERE topic_id=?", i.id);
    });
    this.changed();
    return this.get(i.id).topic;
  }
  context(topicId: string) {
    const topic = this.get(topicId).topic;
    if (!topic.copyId)
      throw new AppError("TARGET_REQUIRED", "请先关联配套本人资料。");
    const { copy, split } = this.assertTarget(topic.copyId, topic.splitItemId);
    return { topic, copy, split };
  }
  write(topicId: string): Draft {
    const detail = this.get(topicId);
    if (detail.draft) return detail.draft;
    const { topic, copy, split } = this.context(topicId);
    const resource = this.repo.getResource(copy.resourceId),
      content = localTemplate(resource, topic.platform),
      draftId = id("draft"),
      time = now();
    content.title = topic.keyword;
    content.body = `目标问题：${topic.keyword}\n搜索意图：${topic.intent || "待补充"}\n软件版本：${topic.softwareVersion || "待核对"}\n适用系统：${topic.operatingSystem || "待核对"}\n配套资料：${split?.path ?? resource.title}\n\n${topic.evidence ? `本人补充依据：\n${topic.evidence}\n\n` : ""}${content.body}`;
    if (content.body.length > 30000)
      throw new AppError(
        "SOURCE_TOO_LARGE",
        "资料说明与教程依据合计过长，请精简后再创建教程草稿。",
      );
    this.db.run(
      "INSERT INTO drafts(id,resource_id,copy_id,platform,pool_id,title,body,tags,resource_revision,share_version,model,topic_id,split_item_id,split_share_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      draftId,
      resource.id,
      copy.id,
      topic.platform,
      topic.poolId,
      content.title,
      content.body,
      JSON.stringify(content.tags),
      resource.revision,
      copy.shareVersion,
      "local-template",
      topic.id,
      split?.id ?? null,
      split?.shareVersion ?? null,
      time,
      time,
    );
    this.db.run(
      "UPDATE search_topics SET updated_at=? WHERE id=?",
      time,
      topic.id,
    );
    this.changed();
    return this.repo.draft(draftId);
  }
  private effect(r: Row): EffectRecord {
    return {
      id: r.id,
      topicId: r.topic_id,
      publicationId: r.publication_id,
      bindingId: r.binding_id,
      scope: r.scope,
      periodStart: r.period_start,
      periodEnd: r.period_end,
      views: r.views,
      saves: r.saves,
      newUsers: r.new_users,
      revenueCents: r.revenue_cents,
      source: r.source,
      createdAt: r.created_at,
    };
  }
  recordEffect(raw: unknown) {
    const i = effectInput.parse(raw),
      publication = this.db.get<Row>(
        "SELECT p.*,d.topic_id FROM publications p JOIN drafts d ON d.id=p.draft_id WHERE p.id=? AND p.status='published'",
        i.publicationId,
      );
    if (!publication?.topic_id)
      throw new AppError(
        "PUBLICATION_REQUIRED",
        "请选择搜索选题下已人工确认发布的文章。",
      );
    const existing = this.db.get<Row>(
      `SELECT id FROM effect_records WHERE ${i.scope === "article" ? "publication_id=?" : "binding_id=?"} AND scope=? AND period_start=? AND period_end=? AND source=?`,
      i.scope === "article" ? publication.id : publication.binding_id,
      i.scope,
      i.periodStart,
      i.periodEnd,
      i.source,
    );
    if (existing)
      throw new AppError(
        "DUPLICATE_EFFECT",
        "此来源和统计周期已有记录，请勿重复录入。不同周期的累计数据不会自动相加。",
      );
    const recordId = id("effect");
    this.db.run(
      "INSERT INTO effect_records(id,topic_id,publication_id,binding_id,scope,period_start,period_end,views,saves,new_users,revenue_cents,source,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      recordId,
      i.scope === "article" ? publication.topic_id : null,
      publication.id,
      publication.binding_id,
      i.scope,
      i.periodStart,
      i.periodEnd,
      i.views,
      i.saves,
      i.newUsers,
      i.revenueCents,
      i.source,
      now(),
    );
    this.changed();
    return this.effect(
      this.db.get<Row>("SELECT * FROM effect_records WHERE id=?", recordId)!,
    );
  }
}
