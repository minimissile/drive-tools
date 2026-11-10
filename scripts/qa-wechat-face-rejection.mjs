import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { wechatArticleImages } from "../shared/wechat-markup.ts";

/** Isolated page business transport; no real image request, draft write or upload. */
export async function run({ page, windowId }) {
  const out = join(tmpdir(), `panxu-wechat-face-rejection-${windowId}`);
  await mkdir(out, { recursive: true });
  const snapshot = await page.evaluate(() => window.panxu.invoke("snapshot"));
  const source = await page.evaluate(async () => {
    const list = await window.panxu.invoke("wechat.list");
    return window.panxu.invoke("wechat.get", { id: list[0].id });
  });
  const detail = structuredClone(source),
    images = wechatArticleImages(source.article.body),
    url = images[0]?.url || source.article.coverUrl;
  assert(url, "需要一张现有图片用于界面预览");
  const newUrl = images[1]?.url || url;
  Object.assign(detail.article, {
    id: `face-${windowId}`,
    stage: "editing",
    revision: 1,
    body: `正文说明。\n\n![插图](${url})`,
    coverUrl: url,
    remote: null,
    pendingAccount: null,
    pendingDraft: null,
    edition: undefined,
    links: [],
    message: "",
  });
  detail.editions = undefined;
  detail.issues = [];
  detail.resources = [];
  let references = 0,
    themes = 0,
    release;
  const calls = [];
  const originalBody = detail.article.body;
  await page.exposeFunction("__faceQaInvoke", async (method, args) => {
    calls.push({ method, args });
    if (method === "wechat.list")
      return [{ ...detail.article, sentRevision: null }];
    if (method === "wechat.get") return detail;
    if (method === "wechat.save") {
      const { id, revision, ...text } = args;
      Object.assign(detail.article, text, { revision: revision + 1 });
      return detail;
    }
    if (method === "wechat.regenerateImages") {
      references++;
      await new Promise((resolve) => {
        release = resolve;
      });
      return {
        detail,
        replaced: 0,
        failed: args.targets.map(({ position }) => ({
          position,
          code: "MEDIA_FACE_REJECTED",
          message:
            "图片服务检测到输入中疑似包含真人面孔，拒绝了本次生成。请更换其他素材；也可单独创作不含人物的主题插画。",
        })),
      };
    }
    if (method === "wechat.generateThemeImages") {
      themes++;
      assert.match(args.description, /不描绘人物、人脸/);
      detail.article.body = detail.article.body.replace(url, newUrl);
      detail.article.coverUrl = newUrl;
      detail.article.revision++;
      return { detail, replaced: args.targets.length, failed: [] };
    }
    throw Error(`本轮页面未启用 ${method}`);
  });
  await page.route("**/src/api/client.ts*", async (route) => {
    const response = await route.fetch(),
      source = await response.text(),
      needle = "return window.panxu.invoke(method, args);";
    assert(source.includes(needle));
    await route.fulfill({
      response,
      body: source.replace(
        needle,
        'return method.startsWith("wechat.") ? window.__faceQaInvoke(method,args) : window.panxu.invoke(method,args);',
      ),
    });
  });
  await page.evaluate(
    ({ windowId, dataPath, id }) =>
      localStorage.setItem(
        `panxu-window:${encodeURIComponent(windowId)}:panxu:wechat:${dataPath}:selection`,
        JSON.stringify({ url: "", selected: id, query: "", page: 1 }),
      ),
    { windowId, dataPath: snapshot.dataPath, id: detail.article.id },
  );
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.reload();
  try {
    const editor = page.locator(".wechat-editor");
    await editor.getByRole("tab", { name: "插图与封面", exact: true }).click();
    await editor
      .getByRole("button", { name: "AI 换图（插图 1）", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "AI 生成替换图",
      exact: true,
    });
    await dialog
      .getByRole("button", { name: "开始生成并替换", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "正在生成…", exact: true })
      .waitFor();
    for (let n = 0; !release && n < 30; n++) await page.waitForTimeout(50);
    assert(release);
    release();
    const action = editor.getByRole("button", {
      name: "生成无人物主题插画",
      exact: true,
    });
    await action.waitFor();
    await dialog.waitFor({ state: "hidden" });
    await action.scrollIntoViewIfNeeded();
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    assert.equal(references, 1);
    assert.equal(themes, 0, "拒绝后不自动生成其他内容");
    assert.equal(detail.article.body, originalBody);
    await page.screenshot({ path: join(out, "face-rejection.png") });
    await action.click();
    await dialog.getByRole("textbox", { name: "画面描述" }).waitFor();
    assert.match(
      await dialog.getByRole("textbox", { name: "画面描述" }).inputValue(),
      /不描绘人物、人脸/,
    );
    assert.equal(themes, 0, "打开替代方案不产生调用");
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    assert.equal(themes, 0);
    await action.click();
    await dialog
      .getByRole("button", { name: "开始生成并替换", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal(themes, 1);
    assert.equal(references, 1);
    assert.equal(await action.count(), 0);
    const report = {
      windowId,
      out,
      checks: [
        "中文人脸拒绝原因",
        "原图保留",
        "不自动重试或切模型",
        "无人物主题入口",
        "打开和取消不调用模型",
        "显式提交后仅调用主题接口",
        "生成成功清除旧警告",
      ],
      realPaidCalls: 0,
    };
    await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
    return report;
  } catch (error) {
    await page.screenshot({ path: join(out, "failure.png") }).catch(() => {});
    throw error;
  }
}
