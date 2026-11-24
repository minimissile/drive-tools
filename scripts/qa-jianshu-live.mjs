import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openNewDraftSettings } from "./qa-jianshu-ui.mjs";

/** Real, reversible local workflow. Never submits a Jianshu article or creates a share.
 * Text AI requires the explicit run flag; native image/export pickers remain real.
 * Run only with test:session --close. Keep the evidence manifest if interrupted;
 * do not rerun a paid step without first checking its saved article and API record.
 */
export async function run({ page, checkpoint, windowId }) {
  assert.equal(
    process.env.PANXU_QA_JIANSHU_TEXT,
    "1",
    "真实文本AI测试须显式设置 PANXU_QA_JIANSHU_TEXT=1",
  );
  const resumed = process.env.PANXU_QA_JIANSHU_RESUME
    ? JSON.parse(await readFile(process.env.PANXU_QA_JIANSHU_RESUME, "utf8"))
    : null;
  const evidence =
    resumed?.evidence || (await mkdtemp(join(tmpdir(), "panxu-jianshu-live-")));
  const report = resumed
    ? {
        ...resumed,
        windowId,
        priorWindowId: resumed.windowId,
        error: undefined,
      }
    : {
        windowId,
        evidence,
        checks: [],
        sourceArticleId: null,
        resourceArticleId: null,
        aiRequests: 0,
        exportPath: null,
      };
  let draft;
  const record = async (phase, extra = {}) => {
    Object.assign(report, extra, { phase });
    await writeFile(
      join(evidence, "result.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify({ phase, ...extra, windowId, evidence }));
  };
  const ipc = (method, args) =>
    page.evaluate(({ method, args }) => window.panxu.invoke(method, args), {
      method,
      args,
    });
  const button = (name) =>
    page.getByRole("button", { name, exact: true }).filter({ visible: true });
  const choose = async (label, name) => {
    await page.getByLabel(label, { exact: true }).click();
    await page.getByRole("option", { name, exact: true }).click();
  };
  const details = () => ipc("jianshu.get", { id: report.resourceArticleId });
  const newDraft = async (ids) => {
    const rows = await ipc("jianshu.list");
    const created = rows.filter((row) => !ids.includes(row.id));
    assert.equal(created.length, 1, "本次创建应只产生一篇新稿");
    return ipc("jianshu.get", { id: created[0].id });
  };
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page
      .getByRole("heading", { name: "简书内容", exact: true })
      .waitFor();
    if (resumed) {
      draft = await details();
      assert.equal(draft.article.stage, "editing");
      const articles = page.getByRole("complementary", {
        name: "简书文章列表",
        exact: true,
      });
      await articles.getByLabel("搜索简书文章", { exact: true }).fill("");
      await articles
        .getByRole("button", { name: draft.article.title, exact: true })
        .and(articles.locator(`[data-article-id="${draft.article.id}"]`))
        .click();
      await page.getByLabel("简书文章正文", { exact: true }).waitFor();
      assert.equal(
        await page.getByLabel("简书文章正文", { exact: true }).inputValue(),
        draft.article.body,
      );
      await record("resumed-saved-draft-without-ai");
    } else {
      const snapshot = await ipc("snapshot");
      assert.ok(snapshot.settings.openrouterConfigured, "未配置OpenRouter");
      report.model = snapshot.settings.aiModels.copy || snapshot.settings.model;
      report.callsBefore = snapshot.apiCalls
        .filter((c) => c.phase === "jianshu_article")
        .map((c) => c.id);
      const accounts = await ipc("websiteAccounts.list", {
        provider: "jianshu",
      });
      const account =
        accounts.find((a) => a.nickname === "跨过那山海") ||
        accounts.find((a) => a.uid);
      assert.ok(account, "需要已有简书账号");
      report.accountId = account.id;
      await button("新建文章").click();
      await openNewDraftSettings(page);
      await choose(
        "新文章简书账号",
        `${account.nickname || account.alias}${account.unverified ? " · 待核验" : account.status === "connected" ? "" : " · 待登录"}`,
      );
      if (await button("检查登录").isVisible())
        await button("检查登录").click();
      await page
        .getByRole("region", { name: "简书账号登录状态" })
        .getByText("身份已核实", { exact: true })
        .waitFor({ timeout: 45000 });
      report.checks.push("真实简书账号核验通过");
      await record("account-verified");

      await page.getByRole("tab", { name: "第三方采集", exact: true }).click();
      await choose("采集来源", "书格 · RSS");
      await button("采集新内容").click();
      await page
        .getByRole("checkbox")
        .filter({ visible: true })
        .first()
        .waitFor({ timeout: 45000 });
      const source = (await ipc("jianshu.sources")).find((s) =>
        s.sourceName.includes("书格"),
      );
      assert.ok(source && source.body && source.url.startsWith("https://"));
      report.source = {
        id: source.id,
        title: source.title,
        url: source.url,
        characters: source.body.length,
      };
      await page
        .getByRole("checkbox", { name: source.title, exact: true })
        .check();
      let ids = (await ipc("jianshu.list")).map((row) => row.id);
      await button("使用所选内容创作").click();
      await page.getByLabel("简书文章正文", { exact: true }).waitFor();
      const sourceDraft = await newDraft(ids);
      report.sourceArticleId = sourceDraft.article.id;
      assert.ok(sourceDraft.delivery.text.includes(source.url));
      assert.equal(sourceDraft.delivery.resourceUrl, null);
      await page
        .getByLabel("简书文章标题", { exact: true })
        .fill(`[功能测试] ${source.title}`);
      await button("保存草稿").click();
      await page.getByText("当前稿件已保存。", { exact: false }).waitFor();
      report.checks.push("真实RSS采集、来源预览和无网盘文章归档");
      await record("source-draft-saved");

      await button("新建文章").click();
      await page.getByRole("tab", { name: "资源库", exact: true }).click();
      await openNewDraftSettings(page);
      await choose("新文章模板", "使用指南");
      const matches = await ipc("jianshu.matches", { keyword: "英语" });
      const resource =
        matches.find((r) => r.title === "英语语法宝典") || matches[0];
      assert.ok(resource, "没有可测试的已核验本人英语资源");
      report.resource = { copyId: resource.copyId, title: resource.title };
      await page
        .getByLabel("搜索简书创作资源", { exact: true })
        .fill(resource.title);
      await page
        .getByRole("option", {
          name: `${resource.title} · ${resource.accountAlias}`,
          exact: true,
        })
        .click();
      ids = (await ipc("jianshu.list")).map((row) => row.id);
      await button("使用所选内容创作").click();
      await page.getByLabel("简书文章正文", { exact: true }).waitFor();
      draft = await newDraft(ids);
      report.resourceArticleId = draft.article.id;
      await record("resource-draft-created");
      await page
        .getByLabel("简书补充要求", { exact: true })
        .fill(
          "本轮为功能测试。为英语自学者写一篇约500字的资料使用指南，依据仅限已给出的资料标题和实际文件目录，区分已知信息与学习建议，不编造资料内容、页数、版权或效果。使用三个清楚的小标题，不写夸张营销表达。",
        );
      report.aiRequests++;
      await record("first-ai-request-started");
      await button("按要求生成新版本").click();
      await button("正在生成…").waitFor();
      await button("正在生成…").waitFor({ state: "hidden", timeout: 180000 });
      await page
        .getByText("新版本已生成，原稿已保留。", { exact: false })
        .waitFor({ timeout: 180000 });
      draft = await details();
      const first = {
        title: draft.article.title,
        body: draft.article.body,
        revision: draft.article.revision,
      };
      assert.ok(first.body.length >= 200);
      await writeFile(
        join(evidence, "first-draft.md"),
        `# ${first.title}\n\n${first.body}`,
      );
      report.checks.push("真实OpenRouter初稿生成并保存历史版本");
      await record("first-ai-request-completed", {
        firstRevision: first.revision,
      });
      await page
        .getByLabel("简书补充要求", { exact: true })
        .fill(
          "在当前版本基础上重新校准：正文控制在350至500个汉字，面向工作日只有20分钟的自学者，加入明确标为建议的三步练习安排，删除空泛宣传和不能从资料目录验证的事实。保留克制自然的表达。",
        );
      report.aiRequests++;
      await record("calibration-started");
      await button("按要求生成新版本").click();
      await button("正在生成…").waitFor();
      await button("正在生成…").waitFor({ state: "hidden", timeout: 180000 });
      await page
        .getByText("新版本已生成，原稿已保留。", { exact: false })
        .waitFor({ timeout: 180000 });
      draft = await details();
      assert.ok(draft.article.revision > first.revision);
      assert.ok(draft.article.versions.some((v) => v.body === first.body));
      assert.notEqual(draft.article.body, first.body);
      await page
        .getByLabel("简书文章标题", { exact: true })
        .fill(`[功能测试] ${draft.article.title}`);
      await button("保存草稿").click();
      await page.getByText("当前稿件已保存。", { exact: false }).waitFor();
      draft = await details();
      const savedTitle = draft.article.title,
        savedBody = draft.article.body;
      await page.reload();
      await page.getByLabel("简书文章正文", { exact: true }).waitFor();
      assert.equal(
        await page.getByLabel("简书文章正文", { exact: true }).inputValue(),
        savedBody,
      );
      assert.equal(
        await page.getByLabel("简书文章标题", { exact: true }).inputValue(),
        savedTitle,
      );
      report.checks.push("真实AI补充要求校准、旧版保留、编辑保存与刷新恢复");
      await record("calibration-saved");
    }

    draft = await details();
    if (!draft.article.images.length) {
      await record("image-picker-awaiting");
      await button("添加本地图片").scrollIntoViewIfNeeded();
      await button("添加本地图片").click();
      await page
        .locator(".jianshu-image-list img")
        .first()
        .waitFor({ timeout: 600000 });
    }
    draft = await details();
    assert.ok(draft.article.images.length);
    await button("预览最终文章").click();
    const preview = page.locator(".jianshu-article-preview");
    await preview.waitFor();
    assert.ok((await preview.innerText()).includes(draft.delivery.resourceUrl));
    if (draft.delivery.resourceCode)
      assert.ok(
        (await preview.innerText()).includes(draft.delivery.resourceCode),
      );
    await preview.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(evidence, "delivery-preview-1440.png"),
    });
    await button("复制正文").click();
    await page
      .getByText("正文已复制，包含资料入口与来源；配图可单独导出。", {
        exact: false,
      })
      .waitFor();
    await page.getByLabel("简书补充要求", { exact: true }).fill("");
    await page
      .getByLabel("简书补充要求", { exact: true })
      .press("ControlOrMeta+V");
    assert.equal(
      await page.getByLabel("简书补充要求", { exact: true }).inputValue(),
      draft.delivery.text,
      "真实系统剪贴板粘贴应与最终正文完全一致",
    );
    await page.getByLabel("简书补充要求", { exact: true }).fill("");
    report.checks.push(
      "真实配图读取、最终网盘入口/提取码预览与系统剪贴板复制粘贴",
    );
    await record("export-picker-awaiting");
    await button("导出文章与配图").click();
    await page
      .getByText("文章与配图已导出。", { exact: false })
      .waitFor({ timeout: 600000 });
    const dirs = (await readdir(evidence, { withFileTypes: true })).filter(
      (e) => e.isDirectory() && e.name.startsWith("简书文章-"),
    );
    assert.equal(dirs.length, 1, "请将实际导出目录选择为日志中的证据目录");
    report.exportPath = join(evidence, dirs[0].name);
    assert.equal(
      await readFile(join(report.exportPath, "正文.txt"), "utf8"),
      draft.delivery.text,
    );
    assert.equal(
      await readFile(join(report.exportPath, "标题.txt"), "utf8"),
      draft.article.title,
    );
    assert.ok((await readdir(join(report.exportPath, "images"))).length);
    report.checks.push("真实系统目录选择及Markdown/文本/配图/出处文件导出");
    await record("export-completed");
    assert.equal(
      process.env.PANXU_QA_JIANSHU_FILL,
      "1",
      "官网自动填写需另设 PANXU_QA_JIANSHU_FILL=1；已完成的本地稿和导出会保留",
    );
    await button("填写到简书").click();
    await page
      .getByRole("region", { name: "当前简书文章", exact: true })
      .getByText("待官网发布", { exact: true })
      .filter({ visible: true })
      .waitFor({ timeout: 60000 });
    draft = await details();
    assert.equal(draft.article.stage, "prepared");
    assert.equal(draft.article.receiptUrl, null);
    assert.equal(draft.article.preparedFill?.filled, true);
    assert.equal(
      draft.article.preparedFill?.uploadedImages,
      draft.article.images.length,
    );
    assert.ok(draft.article.editorUrl?.startsWith("https://www.jianshu.com/"));
    await writeFile(
      join(evidence, "final-delivery.md"),
      `# ${draft.article.title}\n\n${draft.delivery.text}`,
    );
    const after = await ipc("snapshot");
    report.calls = after.apiCalls.filter(
      (c) =>
        c.phase === "jianshu_article" && !report.callsBefore.includes(c.id),
    );
    assert.equal(report.calls.length, 2);
    assert.ok(report.calls.every((c) => c.status === "success"));
    report.checks.push(
      "真实官网标题正文配图自动填写，仅待官网发布，无发布回执",
    );
    await checkpoint();
    await record("passed");
    return report;
  } catch (error) {
    await record("failed", { error: String(error.stack || error) });
    await page
      .screenshot({ path: join(evidence, "failure.png") })
      .catch(() => {});
    throw error;
  }
}
