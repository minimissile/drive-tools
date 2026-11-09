import test from "node:test";
import assert from "node:assert/strict";
import type { WechatSummary } from "../shared/wechat";
import {
  groupWechatArticles,
  matchesWechatArticle,
  preferredWechatEdition,
} from "../src/wechat/article-groups";

const summary = (
  id: string,
  patch: Partial<WechatSummary> = {},
): WechatSummary => ({
  id,
  title: id,
  stage: "editing",
  revision: 1,
  sentRevision: null,
  updatedAt: "2026-11-08T01:00:00.000Z",
  ...patch,
});

test("公众号文章导航：多稿归为一篇，以原文标题查找，不改动原始列表", () => {
  const items = [
    summary("child", {
      materialId: "root",
      editionNumber: 2,
      title: "新的检索角度",
      updatedAt: "2026-11-08T03:00:00.000Z",
    }),
    summary("other", {
      sourceTitle: "另一篇原文",
      updatedAt: "2026-11-08T02:00:00.000Z",
    }),
    summary("root", {
      materialId: "root",
      editionNumber: 1,
      sourceTitle: "最初的原文标题",
      title: "已改写的标题",
    }),
  ];
  const before = structuredClone(items);
  const groups = groupWechatArticles(items);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].id, "root");
  assert.equal(groups[0].title, "最初的原文标题");
  assert.deepEqual(
    groups[0].editions.map((item) => item.id),
    ["root", "child"],
  );
  assert(matchesWechatArticle(groups[0], " 原文标题 "));
  assert(matchesWechatArticle(groups[0], "检索角度"));
  assert(!matchesWechatArticle(groups[0], "不存在"));
  assert.equal(preferredWechatEdition(groups[0], "root"), "root");
  assert.equal(preferredWechatEdition(groups[0], "deleted"), "child");
  assert.equal(preferredWechatEdition(groups[0]), "child");
  assert.deepEqual(items, before);
});

test("公众号文章导航：兼容旧后端摘要，按原有稿件家族归组", () => {
  const groups = groupWechatArticles([
    summary("child", {
      edition: {
        rootId: "root",
        parentId: "root",
        number: 2,
        requestId: "request",
      },
    }),
    summary("root", { title: "旧稿标题" }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].title, "旧稿标题");
  assert.deepEqual(
    groups[0].editions.map((item) => item.id),
    ["root", "child"],
  );
});
