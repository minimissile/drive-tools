import test from "node:test";
import assert from "node:assert/strict";
import { catalogWechatText } from "../core/wechat/catalog-draft";
import { wechatSourceKey } from "../core/wechat/article-family";
import type { CatalogSnapshot } from "../shared/resource-catalog";
import { fixture, file } from "./helpers";
import { wechatHtml } from "../shared/wechat-markup";

function snapshot(count = 2): CatalogSnapshot {
  return {
    id: "snapshot_1",
    hash: "a".repeat(64),
    title: "学习资源清单",
    category: "学习资料",
    introduction: "按主题整理，按需查阅。",
    createdAt: new Date().toISOString(),
    excluded: [],
    items: Array.from({ length: count }, (_, i) => ({
      resourceId: `r${i}`,
      title: `资料 ${i + 1}`,
      category: "学习资料",
      summary: "资料说明",
      tags: ["阅读"],
      links: [
        {
          provider: "夸克",
          url: `https://pan.quark.cn/s/catalog${i}`,
          code: "abcd",
        },
      ],
    })),
  };
}

test("公众号清单正文保留顺序、多个准确分享和提取码，标题过长仅缩短标题字段", () => {
  const input = snapshot();
  input.title = "长标题".repeat(30);
  input.items[0].links.push({
    provider: "夸克",
    url: "https://pan.quark.cn/s/splititem",
    code: "efgh",
  });
  const output = catalogWechatText(input);
  assert.equal(output.text.title.length, 64);
  assert.ok(output.text.body.includes(input.title));
  assert.match(
    output.text.body,
    /## 1\. 资料 1[\s\S]+splititem\?pwd=efgh[\s\S]+## 2\. 资料 2/,
  );
  assert.equal(output.links.length, 3);
  assert.ok(
    output.links.every(
      (link) => link.manual && !link.copyId && !link.resourceId,
    ),
  );
  assert.match(wechatHtml(output.text.body), /splititem/);
  assert.match(wechatHtml(output.text.body), /efgh/);
});

test("公众号清单不静默截断链接或超限正文", () => {
  assert.equal(catalogWechatText(snapshot(100)).links.length, 100);
  assert.throws(() => catalogWechatText(snapshot(101)), {
    code: "CATALOG_WECHAT_LINK_LIMIT",
  });
  const input = snapshot();
  input.items[0].summary = "字".repeat(200000);
  assert.throws(() => catalogWechatText(input), {
    code: "CATALOG_WECHAT_BODY_LIMIT",
  });
  input.items[0].summary = "https://pan.quark.cn/s/foreignlink";
  assert.throws(() => catalogWechatText(input), {
    code: "CATALOG_WECHAT_EXTRA_LINK",
  });
});

test("资源清单导入现有本地草稿，重复导出不覆盖编辑，新快照另建，陈旧/空清单拒绝", async () => {
  const f = await fixture();
  try {
    const saved = await f.add(false);
    const owner = f.app.repo
      .accounts()
      .find((account) => account.id === f.account.id)!;
    const stamp = new Date().toISOString();
    f.app.db.run(
      `UPDATE copies SET status='ready',files=?,owner_uid=?,verified_at=?,share_id=?,share_url=?,share_owner_uid=?,share_verified_at=?,share_version=1 WHERE id=?`,
      JSON.stringify([file]),
      owner.uid,
      stamp,
      "catalogown",
      "https://pan.quark.cn/s/catalogown",
      owner.uid,
      stamp,
      saved.copyId,
    );
    await f.app.secrets.set(`share:${saved.copyId}`, "abcd");
    const catalog = await f.app.resourceCatalogs.save({
      title: "办公资料清单",
      category: "all",
      introduction: "资料介绍",
      includeTags: true,
      includeSummary: true,
      sort: "manual",
      selectionMode: "manual",
      entries: [{ resourceId: saved.resourceId }],
    });
    const input = {
      id: catalog.catalog.id,
      expectedRevision: catalog.catalog.revision,
      expectedHash: catalog.current.hash,
    };
    assert.throws(
      () => f.app.wechat.createCatalogDraft(input.id, snapshot(101)),
      {
        code: "CATALOG_WECHAT_LINK_LIMIT",
      },
    );
    assert.equal(f.app.wechat.list().length, 0);
    const exported = (await f.app.invoke(
      "resourceCatalog.exportWechat",
      input,
    )) as { articleId: string };
    let detail = f.app.wechat.get(exported.articleId);
    assert.equal(detail.article.stage, "editing");
    assert.equal(detail.article.remote, null);
    assert.equal(detail.article.source.kind, "resource-catalog");
    assert.ok(detail.article.body.includes("catalogown?pwd=abcd"));
    assert.equal(
      detail.issues.filter((issue) => issue.severity === "error").length,
      1,
    ); // cover only
    assert.match(
      detail.issues.find((issue) => issue.severity === "error")!.text,
      /封面/,
    );
    f.app.wechat.save(detail.article.id, detail.article.revision, {
      ...detail.article,
      title: "保留用户修改的标题",
    });
    const repeated = await f.app.resourceCatalogs.exportWechat(input);
    assert.equal(repeated.articleId, exported.articleId);
    assert.equal(
      f.app.wechat.get(repeated.articleId).article.title,
      "保留用户修改的标题",
    );
    assert.equal(f.app.wechat.list().length, 1);
    detail = f.app.wechat.get(exported.articleId);
    const edition = f.app.wechat.newEdition(
      detail.article.id,
      detail.article.revision,
      "0180d5e1-a952-4cb4-a329-a51d633b9cc7",
    );
    assert.equal(
      edition.article.links[0].url,
      "https://pan.quark.cn/s/catalogown",
    );
    assert.equal(edition.article.links[0].code, "abcd");
    assert.equal(
      wechatSourceKey(edition.article.source),
      wechatSourceKey(detail.article.source),
    );
    const changed = await f.app.resourceCatalogs.save({
      ...catalog.catalog,
      expectedRevision: catalog.catalog.revision,
      introduction: "修改后的介绍",
    });
    const next = await f.app.resourceCatalogs.exportWechat({
      id: input.id,
      expectedRevision: changed.catalog.revision,
      expectedHash: changed.current.hash,
    });
    assert.notEqual(next.articleId, exported.articleId);
    assert.equal(
      f.app.wechat.get(exported.articleId).article.title,
      "保留用户修改的标题",
    );
    await assert.rejects(f.app.resourceCatalogs.exportWechat(input), {
      code: "CATALOG_CONFLICT",
    });
    await assert.rejects(
      f.app.resourceCatalogs.exportWechat({
        ...input,
        expectedRevision: changed.catalog.revision,
      }),
      { code: "CATALOG_CHANGED" },
    );
    const empty = await f.app.resourceCatalogs.save({
      ...changed.catalog,
      entries: [],
      expectedRevision: changed.catalog.revision,
    });
    await assert.rejects(
      f.app.resourceCatalogs.exportWechat({
        id: input.id,
        expectedRevision: empty.catalog.revision,
        expectedHash: empty.current.hash,
      }),
      { code: "CATALOG_EMPTY" },
    );
    assert.equal(f.provider.transfers, 0);
    assert.equal(f.provider.shares, 0);
  } finally {
    await f.cleanup();
  }
});
