import assert from "node:assert/strict";
import { join } from "node:path";
import { chooseOption } from "./e2e-select.mjs";
import { navigateTo } from "./e2e-navigation.mjs";

/** Exercise the reorganized UI through real IPC; replace only platform transport. */
export async function verifyZhidaoSubmissions(app, page, evidence) {
  const account = await page.evaluate(async () =>
    (await window.panxu.invoke("zhidao.accounts")).find(
      (item) => item.alias === "隔离知道账号",
    ),
  );
  assert.ok(account);
  await app.evaluate(async ({ session }, accountId) => {
    const profile = session.fromPartition(`persist:panxu-zhidao-${accountId}`);
    const state = (globalThis.__zhidaoSubmissionsQA = {
      loginWindows: 0,
      identities: 0,
      searches: 0,
      answers: 0,
      uploads: 0,
      external: 0,
      failUpload: true,
    });
    const json = (value) =>
      new Response(JSON.stringify(value), {
        headers: { "content-type": "application/json" },
      });
    await profile.protocol.handle("https", (request) => {
      if (request.url === "https://zhidao.baidu.com/favicon.ico")
        return new Response(null, { status: 204 });
      if (request.url !== "https://zhidao.baidu.com/") {
        state.external++;
        throw new Error("隔离登录窗口禁止未声明请求");
      }
      state.loginWindows++;
      return new Response(
        "<!doctype html><title>隔离知道登录</title><h1>模拟本人登录页面</h1>",
        {
          headers: { "content-type": "text/html;charset=utf-8" },
        },
      );
    });
    profile.fetch = async (raw, init = {}) => {
      const url = new URL(String(raw));
      if (url.origin !== "https://zhidao.baidu.com") {
        state.external++;
        throw new Error("隔离知道会话禁止外部请求");
      }
      if (url.pathname === "/api/logininfo") {
        state.identities++;
        return json({
          isLogin: true,
          userId: "qa-known-owner",
          userName: "隔离知道本人",
          stoken: "qa-session-token",
        });
      }
      if (url.pathname === "/qa/api/bulkqa/userinfo")
        return json({ code: 200, data: { hasPermission: true } });
      if (url.pathname === "/search") {
        state.searches++;
        return new Response(
          '<a href="https://zhidao.baidu.com/question/123456.html">《隔离学习教程》百度网盘分享</a>',
        );
      }
      if (url.pathname === "/question/123456.html")
        return new Response(
          "<p>https://pan.baidu.com/s/1qaCollectedResource 提取码：a1b2</p>",
        );
      if (url.pathname === "/qa/api/query/result/category")
        return json({
          code: 200,
          data: {
            list: [
              {
                qid: "qa-auto-question",
                question: "如何整理隔离学习教程？",
                answered: false,
              },
            ],
            base: 1,
            hasMore: false,
          },
        });
      if (url.pathname === "/msubmit/answer") {
        const body = new URLSearchParams(String(init.body));
        if (
          init.method !== "POST" ||
          body.get("qid") !== "qa-auto-question" ||
          !body.get("content") ||
          body.get("stoken") !== "qa-session-token"
        )
          throw new Error("自动答题请求缺少题目、回答或账号令牌");
        state.answers++;
        return json({ errno: 0, data: { aid: "qa-answer-accepted" } });
      }
      if (url.pathname === "/qa/api/bulkqa/upload") {
        const file = init.body?.get?.("file");
        if (init.method !== "POST" || !init.body?.get?.("taskName") || !file)
          throw new Error("上传缺少任务名称或问答文件");
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (bytes[0] !== 0x50 || bytes[1] !== 0x4b)
          throw new Error("上传内容不是XLSX工作表");
        state.uploads++;
        if (state.failUpload) throw new Error("模拟上传响应丢失");
        return json({ code: 200, data: { taskId: "qa-upload-accepted" } });
      }
      state.external++;
      throw new Error(`隔离测试禁止未声明的知道接口：${url.pathname}`);
    };
  }, account.id);

  await navigateTo(page, "智能问答");
  await page
    .getByRole("button", { name: "管理知道账号", exact: true })
    .first()
    .click();
  await page.getByRole("tab", { name: "百度知道", exact: true }).waitFor();
  const card = page
    .locator(".zhidao-account-list article")
    .filter({ hasText: account.alias });
  const opened = app.waitForEvent("window", {
    predicate: (candidate) => candidate !== page,
  });
  await card.getByRole("button", { name: "登录 / 扫码", exact: true }).click();
  const login = await opened;
  await login
    .getByRole("heading", { name: "模拟本人登录页面", exact: true })
    .waitFor();
  assert.equal(login.url(), "https://zhidao.baidu.com/");
  await page.bringToFront();
  await card.getByRole("button", { name: "检查账号", exact: true }).click();
  await card.getByText("登录有效", { exact: true }).waitFor();
  await card.getByText("具有快捷答题资格", { exact: true }).waitFor();
  assert.equal(
    await app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    ),
    1,
  );
  await page.screenshot({
    path: join(evidence, "zhidao-account-verified.png"),
  });

  await navigateTo(page, "资源采集");
  await page.getByRole("textbox", { name: /关键词列表/ }).fill("隔离学习教程");
  await page
    .getByRole("checkbox", { name: "PanSou 本地搜索与验活", exact: true })
    .uncheck();
  await page.getByRole("checkbox", { name: "百度知道", exact: true }).check();
  await page
    .getByRole("checkbox", { name: account.alias, exact: true })
    .check();
  await page.getByRole("button", { name: "开始采集", exact: true }).click();
  await page
    .getByText("https://pan.baidu.com/s/1qaCollectedResource?pwd=a1b2", {
      exact: true,
    })
    .waitFor();
  await page.getByText("提取码：a1b2", { exact: true }).waitFor();
  await page.getByText(/已完成，采集1条链接/).waitFor();

  await navigateTo(page, "智能问答");
  await page.getByRole("tab", { name: "自动回答", exact: true }).click();
  await chooseOption(
    page.getByRole("combobox", { name: "回答账号", exact: true }),
    account.id,
  );
  await page.getByRole("spinbutton", { name: /目标回答数/ }).fill("1");
  const startAnswer = page.getByRole("button", {
    name: "开始自动回答",
    exact: true,
  });
  assert.equal(await startAnswer.isDisabled(), true);
  await page
    .getByRole("checkbox", {
      name: "我已核对账号与数量，授权本次 AI 生成和自动提交",
      exact: true,
    })
    .check();
  await startAnswer.click();
  await page.getByText("回答ID：qa-answer-accepted", { exact: true }).waitFor();
  assert.equal(
    await app.evaluate(() => globalThis.__zhidaoSubmissionsQA.answers),
    1,
  );

  await navigateTo(page, "发布任务");
  await page
    .getByRole("checkbox", { name: "选择 如何整理本人学习资料？", exact: true })
    .check();
  await chooseOption(
    page.getByRole("combobox", { name: "发布账号", exact: true }),
    account.id,
  );
  await page.getByRole("checkbox", { name: /我已审核所选1条问答/ }).check();
  await page.getByRole("button", { name: "上传所选问答", exact: true }).click();
  await page.getByRole("button", { name: "核对结果", exact: true }).waitFor();
  await page.getByText("待核对", { exact: true }).waitFor();
  const publishId = await page.evaluate(
    async () =>
      (await window.panxu.invoke("zhidao.runs", { kind: "publish" })).items[0]
        .id,
  );
  await navigateTo(page, "工作台");
  await page
    .locator(".operation-recent-list button")
    .filter({ hasText: "问答模板发布" })
    .click();
  await page.getByRole("heading", { name: "发布任务", exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("combobox", { name: "选择历史运营任务", exact: true })
      .getAttribute("data-value"),
    publishId,
  );
  await page.getByRole("button", { name: "核对结果", exact: true }).waitFor();
  assert.equal(
    await app.evaluate(() => globalThis.__zhidaoSubmissionsQA.uploads),
    1,
  );
  await page.getByRole("button", { name: "继续任务", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "继续发布任务", exact: true });
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "确认继续", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "继续任务", exact: true }).waitFor();
  assert.equal(
    await app.evaluate(() => globalThis.__zhidaoSubmissionsQA.uploads),
    1,
  );
  await page.getByRole("button", { name: "核对结果", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "核对平台提交结果", exact: true });
  await dialog
    .getByRole("button", { name: "已核对，确认未提交", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  await app.evaluate(() => {
    globalThis.__zhidaoSubmissionsQA.failUpload = false;
  });
  await page.getByRole("button", { name: "继续任务", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "继续发布任务", exact: true });
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "确认继续", exact: true }).click();
  await page
    .getByText("上传任务ID：qa-upload-accepted", { exact: true })
    .waitFor();
  await page.getByText(/已提交1\/1条问答；上传任务已创建/).waitFor();
  const state = await app.evaluate(() => globalThis.__zhidaoSubmissionsQA);
  assert.equal(state.uploads, 2);
  assert.equal(state.external, 0);
  assert.equal(state.loginWindows, 1);
  assert.ok(state.identities > 0 && state.searches > 0);
  return [
    "操作页管理账号直达统一账号标签、官方登录窗口隔离模拟、检查身份及快捷答题资格",
    "重组后的资源采集使用知道账号提取链接和提取码，自动答题获得回答ID（平台传输模拟）",
    "审核问答上传XLSX、未知结果继续不重发、人工核对后恢复成功并记录任务ID（平台传输模拟）",
  ];
}
