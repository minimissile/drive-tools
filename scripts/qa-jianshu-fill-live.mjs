import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { verifyOfficialDraft } from "./jianshu-official-qa.mjs";
import { existingBitBrowserEndpoint } from "../core/bitbrowser-existing.ts";

/** Explicit live draft fill, using an explicitly selected existing article. No AI or publishing.
 * Run with test:session --page jianshu-workflow --close. This can create an unpublished
 * remote note on its first use; later runs use its persisted exact note checkpoint.
 */
export async function run({ page, checkpoint, windowId }) {
  assert.equal(
    process.env.PANXU_QA_JIANSHU_FILL,
    "1",
    "实号填写须显式设置 PANXU_QA_JIANSHU_FILL=1",
  );
  const id = process.env.PANXU_QA_JIANSHU_ARTICLE;
  assert.match(id ?? "", /^jianshu_[\w-]+$/, "请指定本轮验收文章ID");
  if (process.env.PANXU_QA_JIANSHU_FILL_ONLY !== "1") {
    const endpoint = new URL(process.env.PANXU_QA_JIANSHU_CDP);
    assert.equal(endpoint.protocol, "http:");
    assert.equal(endpoint.hostname, "127.0.0.1");
    assert.ok(
      !endpoint.username && !endpoint.password && endpoint.port,
      "请传入所选账号当前比特浏览器的本地调试端点",
    );
  }
  const ipc = (method, args) =>
    page.evaluate(({ method, args }) => window.panxu.invoke(method, args), {
      method,
      args,
    });
  const before = await ipc("jianshu.get", { id });
  assert.equal(
    before.article.accountId,
    process.env.PANXU_QA_JIANSHU_ACCOUNT,
    "请明确指定并核对本轮使用的简书账号",
  );
  assert.ok(before.article.accountId, "测试文章必须已关联简书账号");
  assert.equal(before.article.receiptUrl, null, "测试文章不得已有发布回执");
  assert.notEqual(before.article.stage, "published");
  const backend = await ipc("dev.updates");
  const minimum = Number(process.env.PANXU_QA_JIANSHU_MIN_REVISION ?? 0);
  assert.ok(
    backend && backend.runningRevision >= minimum,
    "新后端尚未由用户加载，不能把旧版本记作通过",
  );
  const evidence = await mkdtemp(join(tmpdir(), "panxu-jianshu-fill-"));
  const environments = await ipc("environments.list");
  const environment = environments.find((item) =>
    item.accounts.some(
      (ref) => ref.kind === "website" && ref.id === before.article.accountId,
    ),
  );
  assert.equal(
    environment?.engine,
    "bitbrowser",
    "本实号脚本只验当前关联的比特浏览器账号，内置适配器另有专项",
  );
  console.log(
    JSON.stringify({
      phase: "started",
      windowId,
      articleId: id,
      evidence,
      profileId: environment.profileId,
      runningRevision: backend.runningRevision,
    }),
  );
  const record = async (value) =>
    writeFile(
      join(evidence, "progress.json"),
      JSON.stringify({ windowId, articleId: id, evidence, ...value }, null, 2),
    );
  await record({
    phase: "started",
    stage: before.article.stage,
    editorUrl: before.article.editorUrl,
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("heading", { name: "简书内容", exact: true }).waitFor();
  const articleList = page.getByRole("complementary", {
    name: "简书文章列表",
    exact: true,
  });
  await articleList.getByLabel("搜索简书文章", { exact: true }).fill("");
  await articleList.locator(`[data-article-id="${id}"]`).click();
  await page.getByLabel("简书文章正文", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("简书文章正文", { exact: true }).inputValue(),
    before.article.body,
  );
  await checkpoint();
  if (process.env.PANXU_QA_JIANSHU_RESUME_CHECK === "1") {
    assert.equal(before.article.stage,"uncertain","只恢复已中断且未进入写入的核验");
    assert.equal(before.article.editorUrl,null);
    assert.equal(before.article.preparedUid,null);
    assert.ok(!before.article.preparedFill);
    await page.getByRole("button",{name:"确认尚未发布，返回修改",exact:true}).click();
    await page.getByRole("button",{name:"填写到简书",exact:true}).waitFor();
  }
  if (process.env.PANXU_QA_JIANSHU_NEW_DRAFT === "1") {
    assert.equal(
      before.article.preparedFill?.filled,
      false,
      "仅对本轮尚未写入的误关联执行恢复",
    );
    assert.equal(before.article.preparedFill?.uploadedImages, 0);
    assert.ok(
      !before.article.preparedFill?.titleHash &&
        !before.article.preparedFill?.uploadedImageRefs?.length,
    );
    await page.getByRole("button", { name: "改用新草稿", exact: true }).click();
    await page
      .getByRole("dialog", { name: "改用新的官网草稿", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "确认未发布，改用新草稿", exact: true })
      .click();
    await page
      .getByRole("button", { name: "填写到简书", exact: true })
      .waitFor();
    const detached = await ipc("jianshu.get", { id });
    assert.equal(detached.article.editorUrl, null);
    assert.equal(detached.article.body, before.article.body);
    assert.deepEqual(detached.article.images, before.article.images);
  }
  // Existing legacy QA titles are normalized to real article titles. Validation
  // notes belong in the evidence manifest, never in newly delivered content.
  if (before.article.title.startsWith("[功能测试]")) {
    const normalTitle = before.article.title.replace(/^\[功能测试\]\s*/, "");
    if (before.article.stage !== "editing") {
      await page
        .getByRole("button", { name: "确认尚未发布，返回修改", exact: true })
        .click();
    }
    const title = page.getByLabel("简书文章标题", { exact: true });
    await page.waitForFunction(
      () => !document.querySelector('[aria-label="简书文章标题"]')?.disabled,
    );
    await title.fill(normalTitle);
    await page.getByRole("button", { name: "保存草稿", exact: true }).click();
    await page.waitForFunction(
      () =>
        !document.querySelector('[aria-label="简书文章标题"]')?.disabled &&
        [...document.querySelectorAll("button")].find(
          (b) => b.textContent.trim() === "保存草稿",
        )?.disabled === true,
    );
    for (let n = 0; n < 50; n++) {
      const current = await ipc("jianshu.get", { id });
      if (
        current.article.title === normalTitle &&
        current.article.revision > before.article.revision
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const source = await ipc("jianshu.get", { id });
  await record({
    phase: "article-selected",
    revision: source.article.revision,
    title: source.article.title,
    priorEditorUrl: source.article.editorUrl,
  });
  let fillTriggered = false;
  if (
    !source.article.preparedFill?.filled ||
    source.article.preparedRevision !== source.article.revision
  ) {
    await page
      .getByRole("button", {
        name: /^(填写到简书|继续填写原草稿|重新填写原草稿)$/,
      })
      .click();
    fillTriggered = true;
    let completed = false;
    for (let attempt = 0; attempt < 600; attempt++) {
      const current = await ipc("jianshu.get", { id });
      if (
        current.article.stage === "prepared" &&
        current.article.preparedFill?.filled &&
        current.article.preparedRevision === current.article.revision
      ) {
        completed = true;
        break;
      }
      if (
        current.article.updatedAt !== source.article.updatedAt &&
        !current.busy &&
        /官网填写未完成/.test(current.article.message)
      ) {
        await record({
          phase: "fill-failed",
          message: current.article.message,
          editorUrl: current.article.editorUrl,
        });
        throw Error(current.article.message);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(completed, "官网填写尚未完成，已保留当前进度");
    await page
      .getByRole("button", { name: "查看已填写草稿", exact: true })
      .waitFor();
  }
  assert.ok(
    fillTriggered || process.env.PANXU_QA_JIANSHU_VERIFY_EXISTING === "1",
    "文章已填过，本次只读查看不能算作新的完整填写验收；需显式选择验收原稿",
  );
  const filled = await ipc("jianshu.get", { id });
  assert.equal(filled.article.stage, "prepared");
  assert.equal(filled.article.preparedFill?.filled, true);
  assert.equal(filled.article.preparedFill?.pendingImageSha256 ?? null, null);
  assert.equal(
    filled.article.preparedFill?.uploadedImages,
    filled.article.images.length,
  );
  assert.equal(
    filled.article.preparedFill?.totalImages,
    filled.article.images.length,
  );
  assert.match(
    filled.article.editorUrl,
    /^https:\/\/www\.jianshu\.com\/writer#\/notebooks\/[1-9]\d*\/notes\/[1-9]\d*$/,
  );
  assert.equal(filled.article.receiptUrl, null);
  await record({
    phase: "filled",
    revision: filled.article.revision,
    editorUrl: filled.article.editorUrl,
    uploadedImages: filled.article.preparedFill.uploadedImages,
  });
  assert.equal(filled.article.preparedRevision, filled.article.revision);
  if (process.env.PANXU_QA_JIANSHU_FILL_ONLY === "1") {
    await page.screenshot({ path: join(evidence, "filled-1440.png") });
    const report = {
      phase: "fill-passed-open-pending",
      windowId,
      articleId: id,
      editorUrl: filled.article.editorUrl,
      runningRevision: backend.runningRevision,
      title: filled.article.title,
      fillTriggered,
      uploadedImages: filled.article.preparedFill.uploadedImages,
      published: false,
      evidence,
    };
    await writeFile(
      join(evidence, "result.json"),
      JSON.stringify(report, null, 2),
    );
    return report;
  }
  await page
    .getByRole("button", { name: "查看已填写草稿", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      !![...document.querySelectorAll(".jianshu-editor button")].find(
        (button) =>
          button.textContent.trim() === "查看已填写草稿" && !button.disabled,
      ),
  );
  assert.deepEqual(
    await page.locator(".jianshu-editor .notice.danger").allTextContents(),
    [],
    "打开官网草稿不应出现接口错误",
  );
  const reopened = await ipc("jianshu.get", { id });
  assert.deepEqual(
    reopened.article.preparedFill,
    filled.article.preparedFill,
    "只查看不改写正文或重传配图",
  );
  assert.equal(reopened.article.editorUrl, filled.article.editorUrl);
  const currentEndpoint = await existingBitBrowserEndpoint(environment.profileId);
  const currentCdp = currentEndpoint ? `http://${new URL(currentEndpoint).host}` : process.env.PANXU_QA_JIANSHU_CDP;
  const official = await verifyOfficialDraft(
    currentCdp,
    filled,
    evidence,
  );
  await record({ phase: "official-verified", ...official });
  await page.reload();
  await page
    .getByRole("button", { name: "查看已填写草稿", exact: true })
    .waitFor();
  assert.equal(
    await page.getByLabel("简书文章正文", { exact: true }).inputValue(),
    before.article.body,
  );
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(evidence, "filled-1440.png") });
  const report = {
    windowId,
    articleId: id,
    editorUrl: filled.article.editorUrl,
    runningRevision: backend.runningRevision,
    profileId: environment.profileId,
    title: filled.article.title,
    fillTriggered,
    official,
    uploadedImages: filled.article.preparedFill.uploadedImages,
    filled: true,
    sourceReloaded: true,
    published: false,
    evidence,
  };
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify(report, null, 2),
  );
  return report;
}
