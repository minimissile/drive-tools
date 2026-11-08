import { errors, type Page } from "playwright-core";
import { createHash } from "node:crypto";
import { AppError, safeMessage } from "../errors";
import type { TiebaBrowserProfile } from "./types";
import type { TiebaTopicPublisher, TiebaTopicPayload } from "./topic-types";
import type { TiebaTopicReceipt } from "../../shared/tieba-topics";
import {
  assertTiebaAccount,
  assertTiebaViewer,
  withTiebaBusinessPage,
} from "./browser-runtime";
import { tiebaForumUrl } from "./autocare-page";
import { prepareTiebaTopicLocalImageInput } from "./topic-upload";
import {
  ensureTiebaAiContentDeclaration,
  assertTiebaAiContentDeclaration,
} from "./content-declaration";
import { tiebaThreadIdFromUrl, tiebaThreadUrl } from "./participation-page";
import {
  assertTopicEditor,
  assertTopicForum,
  officialTiebaImage,
  tiebaTopicPageScript,
  tiebaTopicTitleSelector,
  tiebaTopicEditorSelector,
  tiebaTopicSubmitSelector,
  topicReceipt,
  topicUnknown,
  topicOwnCandidates,
  topicCreationTime,
  topicText,
  type TiebaTopicPageSnapshot,
} from "./topic-page";

type Go = (url: string) => Promise<void>;
export function tiebaTopicPublisher(
  profile: TiebaBrowserProfile,
  options: { pageTimeoutMs?: number; resultTimeoutMs?: number } = {},
): TiebaTopicPublisher {
  const snapshot = (p: Page) =>
    p.evaluate<TiebaTopicPageSnapshot>(tiebaTopicPageScript);
  const settled = async (page: Page) => {
    try {
      await page.waitForFunction(
        `(()=>{const s=${tiebaTopicPageScript};return s.challenge||s.login||(s.forum&&(s.topicTitleCount||s.topicPosts.length||s.listRecognized));})()`,
        undefined,
        { timeout: options.pageTimeoutMs ?? 6000 },
      );
    } catch (e) {
      if (!(e instanceof errors.TimeoutError)) throw e;
    }
    return snapshot(page);
  };
  const validate = (p: TiebaTopicPayload) => {
    if (
      !/^[1-9]\d{0,19}$/.test(p.forumId) ||
      p.title.trim().length < 3 ||
      p.title.length > 30 ||
      p.body.trim().length < 80 ||
      p.body.length > 10000 ||
      p.images.length > 6 ||
      new Set(p.images.map((i) => i.sha256)).size !== p.images.length
    )
      throw new AppError(
        "TIEBA_TOPIC_INVALID",
        "待发布主题目标、长度或配图数量无效。",
      );
    tiebaForumUrl(p.forumName);
    for (const i of p.images)
      if (
        i.bytes.length >= 10 * 1024 * 1024 ||
        !i.bytes.length ||
        !["image/png", "image/jpeg"].includes(i.mime) ||
        (i.mime === "image/png"
          ? !Buffer.from(i.bytes)
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : !(i.bytes[0] === 255 && i.bytes[1] === 216)) ||
        createHash("sha256").update(i.bytes).digest("hex") !== i.sha256
      )
        throw new AppError(
          "TIEBA_TOPIC_IMAGES",
          "本地配图与已保存的内容指纹不同。",
        );
  };
  const readReceipt = async (
    page: Page,
    go: Go,
    uid: string,
    p: TiebaTopicPayload,
    previous?: TiebaTopicReceipt | null,
    initial?: TiebaTopicPageSnapshot,
    submittedAt?: string,
  ) => {
    const images = previous?.images ?? [];
    const known = previous?.threadId;
    if (known) {
      await go(tiebaThreadUrl(known));
      const s = await settled(page),
        r = topicReceipt(s, uid, p, images);
      if (r) return r;
      return topicUnknown(
        p,
        "官网尚未核实原主题的完整首帖和图文，保留原结果，不会再次发布。",
        images,
        known,
      );
    }
    if (initial && tiebaThreadIdFromUrl(initial.url)) {
      const r = topicReceipt(initial, uid, p, images);
      if (r) return r;
      return topicUnknown(
        p,
        "已取得官网主题地址，首帖证据仍待核对。",
        images,
        tiebaThreadIdFromUrl(initial.url),
      );
    }
    // A bounded read of current official forum candidates is reconciliation, never a replay.
    await go(tiebaForumUrl(p.forumName));
    const s = await settled(page);
    assertTopicForum(s, uid, p);
    const rows = topicOwnCandidates(s, uid, p);
    for (const tid of rows) {
      await go(tiebaThreadUrl(tid));
      const current = await settled(page);
      const created = topicCreationTime(current);
      if (
        !submittedAt ||
        created === null ||
        created < Date.parse(submittedAt) - 5000 ||
        created > Date.now() + 5000
      )
        continue;
      const r = topicReceipt(current, uid, p, images);
      if (r) return r;
    }
    return topicUnknown(
      p,
      "官网当前列表未找到可核实的原主题，未知结果继续保留，不重发。",
      images,
    );
  };
  return {
    publish(account, uid, p, beforeSubmit, beforePublish) {
      assertTiebaAccount(account, uid);
      validate(p);
      return profile(account, async (context) => {
        await assertTiebaViewer(context, uid);
        return withTiebaBusinessPage(context, async (page, go) => {
          await go(tiebaForumUrl(p.forumName));
          let s = await settled(page);
          assertTopicEditor(s, uid, p);
          const existing = topicOwnCandidates(s, uid, p);
          for (const tid of existing) {
            await go(tiebaThreadUrl(tid));
            const old = await settled(page);
            assertTopicForum(old, uid, p);
            if (
              old.topicPosts.some((post) => {
                const data = post.data as {
                  author?: { user_id?: unknown; id?: unknown };
                  content?: { post_no?: unknown };
                } | null;
                return (
                  Number(data?.content?.post_no) === 1 &&
                  String(data?.author?.user_id ?? data?.author?.id ?? "") ===
                    uid &&
                  !post.truncated &&
                  topicText(post.text) === topicText(p.body)
                );
              })
            )
              throw new AppError(
                "TIEBA_TOPIC_DUPLICATE",
                "官网已有本人相同标题正文的主题，本次不新增发布。",
              );
          }
          if (existing.length) {
            await go(tiebaForumUrl(p.forumName));
            s = await settled(page);
            assertTopicEditor(s, uid, p);
          }
          const title = page
              .locator(tiebaTopicTitleSelector)
              .filter({ visible: true }),
            editor = page
              .locator(tiebaTopicEditorSelector)
              .filter({ visible: true }),
            button = page
              .locator(tiebaTopicSubmitSelector)
              .filter({ visible: true });
          if (
            (await title.count()) !== 1 ||
            (await editor.count()) !== 1 ||
            (await button.count()) !== 1
          )
            throw new AppError("TIEBA_TOPIC_EDITOR", "官网主题控件不唯一。");
          await title.fill(p.title);
          await editor.fill(p.body);
          const declaration = await ensureTiebaAiContentDeclaration(
            page,
            p.aiGenerated === true,
          );
          await assertTiebaViewer(context, uid);
          s = await snapshot(page);
          assertTopicEditor(s, uid, p, true, []);
          const firstImageInput = p.images.length
            ? await prepareTiebaTopicLocalImageInput(
                page,
                options.pageTimeoutMs ?? 6000,
              )
            : null;
          await assertTiebaViewer(context, uid);
          s = await snapshot(page);
          assertTopicEditor(s, uid, p, true, []);
          // Checkpoint precedes both local-image upload and the single publish click.
          await beforeSubmit();
          const uploaded: { sha256: string; url: string }[] = [];
          try {
            await assertTiebaViewer(context, uid);
            s = await snapshot(page);
            assertTopicEditor(s, uid, p, true, []);
            if (p.images.length) {
              // Upload one file at a time: parallel completion order is not evidence
              // that an editor image URL belongs to a particular local hash.
              for (const image of p.images) {
                const input =
                  uploaded.length === 0
                    ? firstImageInput!
                    : await prepareTiebaTopicLocalImageInput(
                        page,
                        options.pageTimeoutMs ?? 6000,
                      );
                await beforePublish();
                await input.setFile({
                  name: image.name,
                  mimeType: image.mime,
                  buffer: Buffer.from(image.bytes),
                });
                try {
                  await page.waitForFunction(
                    `(()=>{const s=${tiebaTopicPageScript};return s.challenge||s.login||(!s.topicUploading&&s.topicEditorImages.length===${uploaded.length + 1}&&s.topicEditorImages.every(u=>u.startsWith('https://')));})()`,
                    undefined,
                    { timeout: options.resultTimeoutMs ?? 20000 },
                  );
                } catch (e) {
                  if (!(e instanceof errors.TimeoutError)) throw e;
                }
                s = await snapshot(page);
                assertTopicForum(s, uid, p);
                if (
                  s.topicEditorImages.length !== uploaded.length + 1 ||
                  s.topicEditorImages.some((u) => !officialTiebaImage(u)) ||
                  new Set(s.topicEditorImages.map(officialTiebaImage)).size !==
                    uploaded.length + 1 ||
                  uploaded.some(
                    (i) =>
                      !s.topicEditorImages.some(
                        (u) =>
                          officialTiebaImage(u) === officialTiebaImage(i.url),
                      ),
                  )
                )
                  throw new AppError(
                    "TIEBA_TOPIC_IMAGE_UNCERTAIN",
                    "官网尚未提供可核对的完整上传图片。",
                  );
                const added = s.topicEditorImages.filter(
                  (u) =>
                    !uploaded.some(
                      (i) =>
                        officialTiebaImage(i.url) === officialTiebaImage(u),
                    ),
                );
                if (added.length !== 1)
                  throw new AppError(
                    "TIEBA_TOPIC_IMAGE_UNCERTAIN",
                    "无法将新图片与本地文件唯一对应。",
                  );
                uploaded.push({ sha256: image.sha256, url: added[0] });
              }
            }
            await assertTiebaViewer(context, uid);
            s = await snapshot(page);
            assertTopicEditor(s, uid, p, true, uploaded);
            await assertTiebaAiContentDeclaration(
              page,
              p.aiGenerated === true,
              declaration,
            );
            await beforePublish();
            await button.click({ timeout: 10000 });
            try {
              await page.waitForFunction(
                `(()=>{const s=${tiebaTopicPageScript};return s.challenge||s.login||s.topicReview||/\\/p\\/[1-9]\\d*/.test(s.url);})()`,
                undefined,
                { timeout: options.resultTimeoutMs ?? 12000 },
              );
            } catch (e) {
              if (!(e instanceof errors.TimeoutError)) throw e;
            }
            await assertTiebaViewer(context, uid);
            s = await snapshot(page);
            assertTopicForum(s, uid, p);
            const r = topicReceipt(s, uid, p, uploaded);
            if (r) return r;
            const unknown = topicUnknown(
              p,
              "原主题已尝试提交，官网首帖尚未核实；仅可核对，不会重放。",
              uploaded,
              tiebaThreadIdFromUrl(s.url),
            );
            if (s.topicReview)
              return {
                ...unknown,
                status: "pending_review",
                message:
                  "官网明确显示主题审核中，发布回执与后续可见性分开记录。",
              };
            return unknown;
          } catch (e) {
            return topicUnknown(
              p,
              `${safeMessage(e)}；提交检查点已保留，只能只读核对，不会再次上传或发布。`,
              uploaded,
              tiebaThreadIdFromUrl(page.url()),
            );
          }
        });
      });
    },
    reconcile(account, uid, p, at, previous) {
      assertTiebaAccount(account, uid);
      validate(p);
      if (!Number.isFinite(Date.parse(at)))
        throw new AppError("TIEBA_TOPIC_TIME", "原提交时间无效。");
      return profile(account, async (context) => {
        await assertTiebaViewer(context, uid);
        return withTiebaBusinessPage(context, async (page, go) => {
          const r = await readReceipt(
            page,
            go,
            uid,
            p,
            previous,
            undefined,
            at,
          );
          await assertTiebaViewer(context, uid);
          return r;
        });
      });
    },
  };
}
