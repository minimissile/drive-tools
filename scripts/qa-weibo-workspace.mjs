import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { weiboFixture } from "../tests/weibo-fixture.ts";

// Run through test:session --page weibo-marketing --close. Only this page's
// business transport is connected to an isolated temporary AppService fixture.
// The shared source backend is never mutated, restarted or replaced.
export async function run({ page, windowId }) {
  const dir = new URL(
    "../.impeccable/review/weibo-workspace-2026-11-07/",
    import.meta.url,
  ).pathname;
  await mkdir(dir, { recursive: true });
  const f = await weiboFixture();
  const errors = [],
    calls = [];
  let failList = false;
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    const updates = await page.evaluate(() =>
      window.panxu.invoke("dev.updates"),
    );
    const liveSupport = await page.evaluate(async () => {
      try {
        const rows = await window.panxu.invoke("weiboWorkspace.list");
        return Array.isArray(rows);
      } catch {
        return false;
      }
    });
    const a = f.websiteAccount;
    const b = await f.invoke("websiteAccounts.add", {
      provider: "weibo",
      alias: "模拟·音乐资料号B",
    });
    f.setSession({ uid: "2234567890", nickname: "模拟·音乐资料号B" });
    await f.invoke("websiteAccounts.check", { id: b.id });
    f.setSession({ uid: "1234567890", nickname: "模拟·资源分享号A" });
    await f.invoke("websiteAccounts.check", { id: a.id });
    const resource = await f.reviewed("模拟·资源推荐");
    await f.invoke("pool.manual", {
      name: "模拟·本地选题",
      resourceId: f.saved.resourceId,
      words: "模拟·清单选题",
    });
    await f.invoke("pool.manual", {
      name: "模拟·另一词池",
      resourceId: f.saved.resourceId,
      words: "模拟·清单选题",
    });
    const duplicateWords = await f.invoke("weibo.words", {
      query: "模拟·清单选题",
    });
    const expectedWord = duplicateWords.findLast(
      (word) => word.word === "模拟·清单选题",
    );
    assert.ok(
      duplicateWords.filter((word) => word.word === expectedWord.word).length >=
        2,
    );
    for (let i = 0; i < 14; i++)
      await f.invoke("weiboWorkspace.save", {
        title:
          i === 0
            ? "模拟·[资料名称与已知规格] 较长的资源名称用于检查表格换行与账号版本的独立展示"
            : `模拟·资料整理技巧 ${i + 1}`,
        accountId: i % 2 ? b.id : a.id,
        kind: i % 3 ? "resource" : "tutorial",
        text: i % 2 ? "简短介绍资料内容与用途，保留客观自然表达。" : "",
        plannedAt: i === 0 ? "2026-11-06T06:00:00.000Z" : null,
      });
    const p = await f.invoke("weiboPosts.save", {
      accountId: a.id,
      text: "模拟·[本人练习清单]\n\n基础练习与配套清单。",
      visibility: "self",
    });
    const p2 = await f.invoke("weiboPosts.save", {
      accountId: a.id,
      text: "模拟·[待采集的历史内容]\n\n保留原有目录分享风格。",
      visibility: "self",
    });
    f.app.db.setSetting(`weiboPosts:v1:${p.id}`, {
      ...p,
      stage: "submitted",
      url: "https://weibo.com/1234567890/Abc123456",
    });
    f.app.db.setSetting(`weiboPosts:v1:${p2.id}`, {
      ...p2,
      stage: "submitted",
      url: "https://weibo.com/1234567890/Xyz123456",
    });
    f.ports.weiboStatistics = {
      read: async (_account, url) => ({
        uid: "1234567890",
        url,
        metrics: {
          reads: { value: 0, display: "0", approximate: false },
          reposts: { value: 0, display: "0", approximate: false },
          comments: { value: null, display: null, approximate: false },
          likes: { value: 2, display: "2", approximate: false },
          linkClicks: { value: null, display: null, approximate: false },
        },
      }),
    };
    await f.invoke("weiboStats.refresh", {
      accountId: a.id,
      url: "https://weibo.com/1234567890/Abc123456",
    });
    const historicalUrl = "https://weibo.com/1234567890/His123456";
    await f.invoke("weiboStats.refresh", {
      accountId: a.id,
      url: historicalUrl,
    });
    const allowed = new Set([
      "snapshot",
      "websiteAccounts.list",
      "cover.get",
      "weibo.matches",
      "weibo.words",
      "weibo.get",
      "weibo.configure",
      "weibo.prepare",
      "weiboStats.get",
      "weiboStats.list",
      "weiboStats.refresh",
      "studio.workingCopy",
      "weiboPosts.list",
    ]);
    const writable = new Set([
      "weiboWorkspace.save",
      "weiboWorkspace.variant",
      "weiboWorkspace.saveStyle",
      "weiboWorkspace.deliver",
    ]);
    const readWorkspace = new Set([
      "weiboWorkspace.list",
      "weiboWorkspace.get",
      "weiboWorkspace.style",
    ]);
    await page.exposeFunction("__qaWeiboInvoke", async (method, args) => {
      calls.push({ method, args });
      if (method === "weiboWorkspace.list" && failList) {
        failList = false;
        throw Error("模拟本地读取失败，历史内容保留。");
      }
      if (
        !allowed.has(method) &&
        !writable.has(method) &&
        !readWorkspace.has(method)
      )
        throw Error(`本轮测试禁止此操作：${method}`);
      return f.invoke(method, args);
    });
    await page.route("**/src/api/client.ts*", async (route) => {
      const response = await route.fetch();
      const source = await response.text();
      const body = source.replace(
        "return window.panxu.invoke",
        `if (method === "snapshot" || method === "websiteAccounts.list" || method === "cover.get" || method.startsWith("weibo") || method.startsWith("studio.working")) return window.__qaWeiboInvoke(method, args); return window.panxu.invoke`,
      );
      assert.notEqual(body, source);
      await route.fulfill({ response, body });
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.reload();
    page.setDefaultTimeout(10000);
    const wait = async (fn) => {
      for (let i = 0; i < 80; i++) {
        if (await fn()) return;
        await page.waitForTimeout(100);
      }
      throw Error("界面断言超时");
    };
    const shot = async (name) => {
      const toast = page.locator(".toast").getByRole("button");
      if (await toast.count()) await toast.click();
      await page.locator(".main-content").evaluateAll((elements) =>
        elements.forEach((el) => {
          el.scrollTop = 0;
        }),
      );
      await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
    };
    const select = async (label, name) => {
      await page.getByLabel(label, { exact: true }).click();
      await page.getByRole("option", { name, exact: true }).click();
    };
    const back = () =>
      page.getByRole("button", { name: "返回内容列表", exact: true }).click();
    const search = page.getByRole("searchbox", {
      name: "搜索微博内容",
      exact: true,
    });
    await page
      .getByRole("heading", { name: "微博内容", exact: true })
      .waitFor();
    await wait(
      async () =>
        (await page.locator(".weibo-content-table tbody tr").count()) === 12,
    );
    await shot("01-content-list");
    await page
      .getByRole("navigation", { name: "微博内容分页" })
      .getByRole("button", { name: "下一页" })
      .click();
    assert.ok(
      (await page.locator(".weibo-content-table tbody tr").count()) < 12,
    );
    await select("筛选微博账号", "模拟·音乐资料号B");
    await wait(async () =>
      (await page.locator(".weibo-content-table tbody").innerText()).includes(
        "模拟·音乐资料号B",
      ),
    );
    assert.ok(
      !(await page.locator(".weibo-content-table tbody").innerText()).includes(
        "模拟·资源分享号A",
      ),
    );
    await select("筛选微博账号", "全部微博账号");
    await page.getByRole("button", { name: "新建内容", exact: true }).click();
    const titleInput = page.getByLabel("微博内容名称", { exact: true });
    await titleInput.fill("较长的选题名称".repeat(20));
    await titleInput.blur();
    await wait(async () =>
      calls.some(
        (c) => c.method === "weibo.matches" && c.args.keyword.length === 100,
      ),
    );
    assert.ok(
      !(await page.getByText("暂时无法读取数据", { exact: true }).count()),
    );
    await titleInput.fill("周末想看的片单");
    const resourcesInput = page.getByLabel("内容关联资料", { exact: true });
    await resourcesInput.fill("Python");
    await page
      .getByRole("option", { name: "Python 入门练习资料", exact: true })
      .click();
    await wait(async () =>
      calls.some(
        (c) => c.method === "weibo.matches" && c.args.keyword === "Python",
      ),
    );
    assert.equal(await resourcesInput.inputValue(), "Python 入门练习资料");
    await shot("09-independent-resource-search");
    await resourcesInput.fill("");
    await resourcesInput.press("ArrowDown");
    await page
      .getByRole("option", { name: "暂不关联资料", exact: true })
      .click();
    await titleInput.fill("模拟·清单");
    await page
      .getByRole("option", {
        name: `${expectedWord.word} · ${expectedWord.source}`,
        exact: false,
      })
      .click();
    await wait(async () => (await titleInput.inputValue()) === "模拟·清单选题");
    await page
      .getByText(`来源：${expectedWord.source}`, { exact: false })
      .waitFor();
    await shot("10-keyword-source");
    await select("微博内容类型", "问题解答");
    assert.equal(
      await page.getByRole("button", { name: "按账号文风生成" }).isDisabled(),
      true,
    );
    await page.getByRole("button", { name: "保存选题", exact: true }).click();
    await wait(async () =>
      f.app.weiboWorkspace.list().some((r) => r.title === "模拟·清单选题"),
    );
    const selectedIdea = f.app.weiboWorkspace
      .list()
      .find((r) => r.title === "模拟·清单选题");
    assert.match(f.app.weiboWorkspace.get(selectedIdea.id).sourceId, /^pool:/);
    assert.equal(
      f.app.weiboWorkspace.get(selectedIdea.id).sourceId,
      expectedWord.id,
    );
    assert.equal(f.app.weiboWorkspace.get(selectedIdea.id).copyId, "");
    await page
      .getByRole("heading", { name: "编辑内容", exact: true })
      .waitFor();
    await back();
    await page.getByRole("button", { name: "新建内容", exact: true }).click();
    assert.equal(
      await page.getByLabel("微博内容名称", { exact: true }).inputValue(),
      "",
    );
    await page
      .getByLabel("微博内容名称", { exact: true })
      .fill("模拟·未提交的自然表达");
    await page
      .getByLabel("微博内容文案", { exact: true })
      .fill("[本人练习资料]\n\n包含基础练习与配套清单，适合按自己的进度完成。");
    await select("内容目标账号", "模拟·资源分享号A");
    await page
      .getByLabel("微博内容依据", { exact: true })
      .fill("本人制作的基础练习和清单，已核对内容与适合人群。");
    await wait(
      async () =>
        !(await page
          .getByRole("button", { name: "继续审阅与发布", exact: true })
          .isDisabled()),
    );
    await page.reload();
    await page.getByLabel("微博内容名称", { exact: true }).waitFor();
    assert.equal(
      await page.getByLabel("微博内容名称", { exact: true }).inputValue(),
      "模拟·未提交的自然表达",
    );
    await shot("02-content-editor");
    await back();
    await page.getByRole("button", { name: "新建内容", exact: true }).click();
    assert.equal(
      await page.getByLabel("微博内容名称", { exact: true }).inputValue(),
      "模拟·未提交的自然表达",
    );
    await page.getByRole("button", { name: "保存草稿", exact: true }).click();
    await wait(async () =>
      f.app.weiboWorkspace
        .list()
        .some((r) => r.title === "模拟·未提交的自然表达"),
    );
    await page
      .getByRole("heading", { name: "编辑内容", exact: true })
      .waitFor();
    await back();
    await search.fill("模拟·未提交的自然表达");
    await page.getByRole("button", { name: "另存版本", exact: true }).click();
    await select("版本目标账号", "模拟·音乐资料号B");
    await page
      .getByRole("button", { name: "保存独立草稿", exact: true })
      .click();
    await wait(
      async () =>
        f.app.weiboWorkspace
          .list()
          .filter((r) => r.title === "模拟·未提交的自然表达").length === 2,
    );
    assert.equal(
      f.app.weiboWorkspace
        .list()
        .filter(
          (r) => r.title === "模拟·未提交的自然表达" && r.accountId === b.id,
        ).length,
      1,
    );
    await search.fill("");
    await page.getByRole("tab", { name: "账号文风", exact: true }).click();
    await select("筛选微博账号", "模拟·资源分享号A");
    const instructions =
      "资源名称与已知规格在最前，标题之后放本人核验链接，再写简短客观介绍。保持目录分享风格与原封面，不写营销口号。";
    await page
      .getByRole("textbox", { name: "账号文风要求" })
      .fill(instructions);
    await page
      .getByRole("button", { name: "保存此账号文风", exact: true })
      .click();
    await wait(
      async () =>
        f.app.weiboWorkspace.style(a.id).instructions === instructions,
    );
    await page.getByText("此账号已保存独立文风。", { exact: false }).waitFor();
    await wait(
      async () =>
        !(await page
          .getByRole("button", { name: "保存此账号文风", exact: true })
          .isDisabled()),
    );
    await shot("03-account-style");
    await select("筛选微博账号", "模拟·音乐资料号B");
    await wait(
      async () =>
        (await page
          .getByRole("textbox", { name: "账号文风要求" })
          .inputValue()) !== instructions,
    );
    await select("筛选微博账号", "全部微博账号");
    await page.getByRole("tab", { name: "数据复盘", exact: true }).click();
    await wait(
      async () =>
        (await page.locator(".weibo-content-table tbody tr").count()) === 2,
    );
    const statsText = await page
      .locator(".weibo-content-table tbody")
      .innerText();
    assert.match(statsText, /0 \/ — \/ 2/);
    assert.match(statsText, /尚未采集/);
    await shot("04-content-statistics");
    await select("筛选微博账号", "模拟·资源分享号A");
    await page.getByText("本人历史微博与统计快照", { exact: true }).click();
    await page
      .getByRole("combobox", { name: "统计目标微博", exact: true })
      .click();
    await page
      .getByRole("option", { name: "已采集的微博", exact: true })
      .click();
    assert.equal(
      await page
        .getByRole("textbox", { name: "微博统计链接", exact: true })
        .inputValue(),
      historicalUrl,
    );
    await page.getByText("上次采集：", { exact: false }).waitFor();
    assert.equal(
      calls.filter((c) => c.method === "weiboStats.refresh").length,
      0,
    );
    await page
      .getByRole("textbox", { name: "微博统计链接", exact: true })
      .fill("https://weibo.com/9999999999/Other123");
    await page
      .getByRole("button", { name: "读取最新数据", exact: true })
      .click();
    await page
      .getByText(
        "请填写该账号的单条微博桌面链接：https://weibo.com/数字UID/微博ID，不接受主页或其他账号地址。",
        { exact: true },
      )
      .waitFor();
    await page
      .getByRole("textbox", { name: "微博统计链接", exact: true })
      .fill(historicalUrl);
    await wait(
      async () =>
        !(await page
          .getByRole("button", { name: "读取最新数据", exact: true })
          .isDisabled()),
    );
    await page
      .getByRole("button", { name: "读取最新数据", exact: true })
      .click();
    await wait(
      async () =>
        calls.filter((c) => c.method === "weiboStats.refresh").length === 2,
    );
    await page
      .getByRole("button", { name: "读取最新数据", exact: true })
      .waitFor();
    await shot("11-historical-statistics");
    await select("筛选微博账号", "全部微博账号");
    await page.getByRole("tab", { name: "内容列表", exact: true }).click();
    failList = true;
    await page
      .getByRole("button", { name: "刷新本地记录", exact: true })
      .click();
    await page
      .getByText("模拟本地读取失败，历史内容保留。", { exact: true })
      .waitFor();
    assert.equal(
      await page.locator(".weibo-content-table tbody tr").count(),
      12,
    );
    await shot("05-refresh-error");
    await page.getByRole("button", { name: "重试读取", exact: true }).click();
    await page
      .getByText("模拟本地读取失败，历史内容保留。", { exact: true })
      .waitFor({ state: "hidden" });
    await search.fill("查无此内容");
    await page.getByText("没有符合筛选的内容", { exact: true }).waitFor();
    await shot("06-filter-empty");
    await search.fill("模拟·资源推荐");
    await page.getByRole("button", { name: "继续编辑", exact: true }).click();
    await page.getByRole("textbox", { name: "内容正文" }).waitFor();
    await wait(
      async () =>
        !(await page
          .getByRole("button", { name: "核验并准备发布", exact: true })
          .isDisabled()),
    );
    await page
      .getByRole("button", { name: "核验并准备发布", exact: true })
      .click();
    await page.getByRole("region", { name: "实际交付微博文案" }).waitFor();
    assert.equal(
      calls.findLast((c) => c.method === "weibo.prepare").args.export,
      false,
    );
    const preview = await page
      .getByRole("region", { name: "实际交付微博文案" })
      .innerText();
    assert.ok(preview.indexOf("链接：") < preview.indexOf(resource.draft.body));
    await page
      .getByRole("heading", { name: "发布设置", exact: true })
      .scrollIntoViewIfNeeded();
    await page
      .getByRole("heading", { name: "发布设置", exact: true })
      .evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.screenshot({
      path: `${dir}/07-managed-delivery.png`,
      fullPage: true,
    });
    await page
      .getByRole("region", { name: "实际交付微博文案" })
      .evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.screenshot({
      path: `${dir}/08-prepared-preview.png`,
      fullPage: true,
    });
    assert.equal(
      calls.filter((c) => /(?:generate|fill|submit|handoff)$/.test(c.method))
        .length,
      0,
    );
    assert.deepEqual(errors, []);
    const report = {
      windowId,
      viewport: "1440x900",
      sharedBackendUpdates: updates,
      sharedBackendSupportsWorkspace: liveSupport,
      backend:
        "isolated temporary AppService via this page's business transport",
      realBusinessMutations: 0,
      generatedDuringUi: 0,
      uploadOrPublish: 0,
      checks: [
        "list pagination and account filtering",
        "save topic without resource or account",
        "new saved item starts a fresh editor",
        "unsaved form restores after leaving",
        "account variants independent",
        "style isolated per account",
        "stats zero distinct from unavailable",
        "refresh failure retains records and retries",
        "filter empty recovery",
        "managed preparation and link ordering",
        "independent resource search unrelated to topic title",
        "200-character topic bounded to matching API contract",
        "local keyword source retained in saved idea",
        "duplicate keyword keeps the displayed source identity",
        "snapshot-only historical link discoverable and explicit read",
        "historical link with wrong author rejected",
      ],
      calls: calls.map((c) => c.method),
      errors,
    };
    await writeFile(`${dir}/ui-test.json`, JSON.stringify(report, null, 2));
    return report;
  } catch (e) {
    await page
      .screenshot({ path: `${dir}/failure.png`, fullPage: true })
      .catch(() => {});
    await writeFile(
      `${dir}/failure.txt`,
      `${e.stack}\n${await page
        .locator("body")
        .innerText()
        .catch(() => "")}\n${JSON.stringify(errors)}`,
    );
    throw e;
  } finally {
    await f.cleanup();
  }
}
