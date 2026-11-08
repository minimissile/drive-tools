import { z } from "zod";
import { id, now, type Database } from "../database";
import { AppError } from "../errors";
import { validateOutgoingLinks } from "../links";
import { weiboPostText } from "../../shared/weibo-marketing";
import type { WebsiteAccounts } from "../website-accounts";
import type { WeiboPosts } from "./posts";
import type { WeiboMarketing } from "./marketing";
import type { WeiboStatistics } from "./statistics";
import type { AiService } from "../ai";
import { readWeiboStyle } from "./editorial";
import {
  weiboIdeaInput,
  weiboStyleInput,
  weiboContentKinds,
  type WeiboIdea,
  type WeiboContentRow,
} from "../../shared/weibo-workspace";

const indexKey = "weiboWorkspace:index:v1";
const key = (id: string) => `weiboWorkspace:v1:${id}`;
export class WeiboWorkspace {
  private active = new Set<string>();
  get isBusy() {
    return this.active.size > 0;
  }
  constructor(
    private deps: {
      db: Database;
      accounts: WebsiteAccounts;
      posts: WeiboPosts;
      marketing: WeiboMarketing;
      statistics: WeiboStatistics;
      ai: AiService;
      changed(): void;
    },
  ) {}
  private account(accountId: string) {
    const account = this.deps.accounts.get(accountId);
    if (account.provider !== "weibo")
      throw new AppError("WEIBO_ACCOUNT_REQUIRED", "请选择微博账号。");
    return account;
  }
  style(accountId: string) {
    this.account(accountId);
    return readWeiboStyle(this.deps.db, accountId);
  }
  saveStyle(raw: unknown) {
    const value = weiboStyleInput.parse(raw);
    this.account(value.accountId);
    this.deps.db.setSetting(`weiboStyle:v1:${value.accountId}`, {
      instructions: value.instructions,
      linkFirst: value.linkFirst,
    });
    this.deps.changed();
    return this.style(value.accountId);
  }
  get(id: string): WeiboIdea {
    const item = this.deps.db.setting<WeiboIdea | null>(key(id), null);
    if (!item) throw new AppError("NOT_FOUND", "微博选题草稿不存在。");
    return item;
  }
  private persist(item: WeiboIdea) {
    item.updatedAt = now();
    this.deps.db.setSetting(key(item.id), item);
    this.deps.changed();
    return item;
  }
  private editable(item: WeiboIdea) {
    if (this.active.has(item.id))
      throw new AppError("WEIBO_BUSY", "此稿件正在处理，请稍后重试。");
    if (item.target)
      throw new AppError(
        "WEIBO_DELIVERED",
        "此稿件已进入发布编辑，请打开对应内容继续；新版本可另存为账号版本。",
      );
  }
  save(raw: unknown) {
    const input = weiboIdeaInput.parse(raw);
    if (input.accountId) this.account(input.accountId);
    // Drafts may contain a proposed link, but delivery still validates ownership.
    const old = input.id ? this.get(input.id) : null;
    if (old) this.editable(old);
    const item: WeiboIdea = {
      ...old,
      ...input,
      id: old?.id ?? id("wbidea"),
      createdAt: old?.createdAt ?? now(),
      updatedAt: now(),
    };
    if (!old)
      this.deps.db.setSetting(indexKey, [
        item.id,
        ...this.deps.db.setting<string[]>(indexKey, []),
      ]);
    return this.persist(item);
  }
  variant(
    ideaId: string,
    accountId: string,
    kind: "idea" | "post" | "marketing" = "idea",
  ) {
    this.account(accountId);
    const source: z.output<typeof weiboIdeaInput> & {
      id: string;
      originId?: string;
      aiAssisted?: boolean;
    } =
      kind === "idea"
        ? this.get(ideaId)
        : kind === "post"
          ? (() => {
              const p = this.deps.posts.get(ideaId);
              return {
                ...weiboIdeaInput.parse({
                  title: p.text.split("\n")[0].slice(0, 200),
                  text: p.text,
                  kind: "note",
                }),
                id: p.id,
                aiAssisted: p.aiAssisted,
              };
            })()
          : (() => {
              const d = this.deps.marketing.get(ideaId);
              const text = weiboPostText(d.draft);
              if (text.length > 2000)
                throw new AppError(
                  "WEIBO_TEXT_LIMIT",
                  "当前文案超过2000字符，请先精简后再另存版本；原文保留。",
                );
              return {
                ...weiboIdeaInput.parse({
                  title: d.run.input.keyword,
                  text,
                  copyId: d.run.input.copyId,
                  evidence: d.run.input.evidence,
                  audience: d.run.input.audience,
                }),
                id: d.run.id,
                aiAssisted: !["manual", "local-template"].includes(
                  d.draft.model,
                ),
              };
            })();
    const item = this.save({
      ...source,
      id: undefined,
      accountId,
      plannedAt: null,
    });
    item.originId = source.originId ?? source.id;
    item.aiAssisted = source.aiAssisted;
    return this.persist(item);
  }
  async generate(ideaId: string) {
    const item = this.get(ideaId);
    this.editable(item);
    if (!item.accountId)
      throw new AppError(
        "WEIBO_ACCOUNT_REQUIRED",
        "先选择目标账号，以便沿用该账号文风。",
      );
    if (item.evidence.trim().length < 10)
      throw new AppError(
        "WEIBO_EVIDENCE_REQUIRED",
        "请补充至少10字可核对的内容依据，避免编造资源规格或经历。",
      );
    const before = JSON.stringify(item);
    this.active.add(item.id);
    try {
      const style = this.style(item.accountId);
      const result = await this.deps.ai.resourceExport(
        "weibo_content",
        z.object({ text: z.string().trim().min(1).max(2000) }),
        "创作一条中文微博，返回text。只依据输入已核实事实，不编造年份、清晰度、文件体积、主创、体验和效果。输出完整可编辑文案，不加任何URL、提取码、私信领取或强制关注。账号文风是表达约束，事实仍以本次依据为准。",
        {
          title: item.title,
          kind: weiboContentKinds[item.kind],
          facts: item.evidence,
          audience: item.audience,
          existingText: item.text,
          style: style.instructions,
        },
        [],
        { maxTokens: 1800 },
      );
      if (JSON.stringify(this.get(item.id)) !== before)
        throw new AppError(
          "WEIBO_DRAFT_CHANGED",
          "生成期间稿件已变化，未覆盖当前内容；本次模型费用已记录。",
        );
      validateOutgoingLinks(result.text, "", false);
      item.text = result.text;
      item.aiAssisted = true;
      return this.persist(item);
    } finally {
      this.active.delete(item.id);
    }
  }
  deliver(ideaId: string) {
    const item = this.get(ideaId);
    if (item.target) return item.target;
    this.editable(item);
    if (!item.accountId)
      throw new AppError("WEIBO_ACCOUNT_REQUIRED", "请选择发布账号。");
    const account = this.account(item.accountId);
    let target: NonNullable<WeiboIdea["target"]>;
    if (item.copyId) {
      if (item.evidence.trim().length < 10)
        throw new AppError(
          "WEIBO_EVIDENCE_REQUIRED",
          "关联资源发布前请补充至少10字已核实依据。",
        );
      const detail = this.deps.marketing.create({
        keyword: item.title.slice(0, 100),
        sourceId: item.sourceId,
        copyId: item.copyId,
        audience: item.audience,
        evidence: item.evidence,
        accountId: account.id,
        initialText: item.text,
        aiAssisted: item.aiAssisted === true,
        originId: item.id,
      });
      target = { kind: "marketing", id: detail.run.id };
    } else {
      if (!item.text.trim())
        throw new AppError(
          "WEIBO_TEXT_REQUIRED",
          "请先填写微博文案，或仅保存为选题。",
        );
      const post = this.deps.posts.save({
        accountId: account.id,
        text: item.text,
        visibility: "self",
        aiAssisted: item.aiAssisted,
      });
      target = { kind: "post", id: post.id };
    }
    item.target = target;
    this.persist(item);
    return target;
  }
  list(): WeiboContentRow[] {
    const ideas = this.deps.db
      .setting<string[]>(indexKey, [])
      .map((id) => this.get(id));
    const mapped = new Map(
      ideas
        .filter((i) => i.target)
        .map((i) => [`${i.target!.kind}:${i.target!.id}`, i]),
    );
    const rows: WeiboContentRow[] = ideas
      .filter((i) => !i.target)
      .map((i) => ({
        key: `idea:${i.id}`,
        kind: "idea",
        id: i.id,
        title: i.title,
        text: i.text,
        accountId: i.accountId,
        status: i.plannedAt ? "planned" : i.text.trim() ? "draft" : "idea",
        plannedAt: i.plannedAt,
        updatedAt: i.updatedAt,
        url: null,
        latest: null,
      }));
    for (const post of this.deps.posts.list()) {
      const idea = mapped.get(`post:${post.id}`);
      rows.push({
        key: `post:${post.id}`,
        kind: "post",
        id: post.id,
        title: idea?.title ?? post.text.split("\n")[0].slice(0, 100),
        text: post.text,
        accountId: post.accountId,
        status: post.url
          ? "published"
          : ["uncertain", "attention"].includes(post.stage)
            ? "attention"
            : ["filled", "filling", "submitting"].includes(post.stage)
              ? "ready"
              : idea?.plannedAt
                ? "planned"
                : "draft",
        plannedAt: idea?.plannedAt ?? null,
        updatedAt: post.updatedAt,
        url: post.url,
        latest: null,
      });
    }
    for (const run of this.deps.marketing.history()) {
      const idea = mapped.get(`marketing:${run.id}`);
      rows.push({
        key: `marketing:${run.id}`,
        kind: "marketing",
        id: run.id,
        title: idea?.title ?? run.input.keyword,
        text: "",
        accountId: run.options?.accountId || run.input.accountId || "",
        status: run.url
          ? "published"
          : ["attention", "uncertain", "handoff"].includes(run.stage)
            ? "attention"
            : ["filled", "ready", "submitting"].includes(run.stage)
              ? "ready"
              : idea?.plannedAt
                ? "planned"
                : "draft",
        plannedAt: idea?.plannedAt ?? null,
        updatedAt: run.updatedAt,
        url: run.url,
        latest: null,
      });
    }
    for (const row of rows)
      if (row.url && row.accountId) {
        try {
          row.latest =
            this.deps.statistics.get(row.accountId, row.url)[0] ?? null;
        } catch {
          row.statisticsError = "本地统计读取失败，请打开内容重试。";
        }
      }
    return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}
