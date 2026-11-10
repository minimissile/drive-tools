import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database, now } from "../core/database.ts";
import { RuntimeLog } from "../core/runtime-log.ts";
import { SystemLogs } from "../core/system-logs.ts";

/** Tests only this window's business transport, backed by an isolated log DB. */
export async function run({ page, windowId, checkpoint }) {
  const dir = await mkdtemp(join(tmpdir(), "panxu-system-logs-db-"));
  const out = join(tmpdir(), `panxu-system-logs-${windowId}`);
  await mkdir(out, { recursive: true });
  const db = new Database(join(dir, "panxu.db")),
    logs = new SystemLogs(db, dir);
  let release,
    first = true,
    failNext = false,
    copied = "";
  const calls = [];
  try {
    for (let n = 0; n < 52; n++)
      new RuntimeLog(db, dir, "wechat").record({
        level: n === 1 ? "warning" : "error",
        event: "rewrite.failed",
        message:
          n === 1
            ? "正文排版未通过，原稿已保留。"
            : `文章改写暂未完成，原稿已保留。`,
        taskId: `article-${n}`,
        details: { styleId: "commentary", code: "INVALID_AI_RESPONSE" },
      });
    db.run(
      "INSERT INTO api_calls(id,endpoint,phase,units,status,message,confirmed_micros,created_at) VALUES(?,?,?,?,?,?,?,?)",
      "ai-interrupted",
      "openrouter",
      "wechat_article_copy",
      1,
      "success",
      "AI 服务在生成过程中异常中断，原稿已保留。 返回内容校验未通过。",
      0,
      now(),
    );
    db.run(
      "INSERT INTO api_cache(key,value,expires_at) VALUES(?,?,?)",
      "ai-response:ai-interrupted",
      JSON.stringify({
        model: "qwen/qwen3.8-max-0902",
        finishReason: "error",
        raw: "private-body-not-in-logs",
      }),
      now(),
    );
    await page.exposeFunction("__systemLogsQa", async (method, args) => {
      if (method === "system.copyText") {
        copied = args.text;
        return true;
      }
      calls.push(args);
      if (first) {
        first = false;
        await new Promise((resolve) => {
          release = resolve;
        });
      }
      if (failNext) {
        failNext = false;
        throw Error("本地日志暂时无法读取，请重试。");
      }
      return logs.read(args);
    });
    await page.route("**/src/api/client.ts*", async (route) => {
      const response = await route.fetch(),
        source = await response.text(),
        needle = "return window.panxu.invoke(method, args);";
      assert(source.includes(needle), "使用现有页面级业务传输接口");
      await route.fulfill({
        response,
        body: source.replace(
          needle,
          'return ["systemLogs.list","system.copyText"].includes(method) ? window.__systemLogsQa(method,args) : window.panxu.invoke(method,args);',
        ),
      });
    });
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.reload();
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: "异常日志", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "异常日志", exact: true })
      .waitFor();
    await page.getByText("正在读取本地异常日志…", { exact: true }).waitFor();
    assert.equal(
      await page.getByText(/共 0 条异常记录/).count(),
      0,
      "首次加载不虚构空结果",
    );
    for (let n = 0; !release && n < 30; n++) await page.waitForTimeout(50);
    assert(release);
    release();
    await page
      .getByText("共 53 条异常记录 · 每 10 秒更新", { exact: true })
      .waitFor();
    const list = page.getByRole("list", { name: "异常记录" });
    assert.equal(await list.locator(":scope > li").count(), 50);
    const ai = list
      .locator("details")
      .filter({ hasText: "AI 服务在生成过程中异常中断" });
    await ai.locator("summary").click();
    await ai
      .getByText("模型：qwen/qwen3.8-max-0902 · 结束状态：error", {
        exact: true,
      })
      .waitFor();
    await ai.getByRole("button", { name: "复制此条", exact: true }).click();
    await page
      .getByRole("status")
      .filter({ hasText: "异常详情已复制。" })
      .waitFor();
    assert(copied.includes('"finishReason": "error"'));
    assert(!copied.includes("private-body-not-in-logs"));
    await page.screenshot({ path: join(out, "exceptions.png") });
    await checkpoint();
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await page.getByText("第 2 / 2 页 · 共 53 项", { exact: true }).waitFor();
    assert.equal(await list.locator(":scope > li").count(), 3);
    await page.getByRole("textbox", { name: "搜索异常" }).fill("qwen3.8");
    await page
      .getByText("共 1 条异常记录 · 每 10 秒更新", { exact: true })
      .waitFor();
    assert.equal(calls.at(-1).page, 1, "筛选重置页码");
    await page.getByRole("textbox", { name: "搜索异常" }).fill("");
    await page.getByRole("combobox", { name: "来源模块" }).click();
    await page.getByRole("option", { name: "微信公众号", exact: true }).click();
    await page
      .getByText("共 52 条异常记录 · 每 10 秒更新", { exact: true })
      .waitFor();
    await page.getByRole("combobox", { name: "级别", exact: true }).click();
    await page.getByRole("option", { name: "仅警告", exact: true }).click();
    await page
      .getByText("共 1 条异常记录 · 每 10 秒更新", { exact: true })
      .waitFor();
    await list
      .getByText("正文排版未通过，原稿已保留。", { exact: true })
      .waitFor();
    await page.getByRole("combobox", { name: "时间范围", exact: true }).click();
    await page.getByRole("option", { name: "最近 30 天", exact: true }).click();
    await page
      .getByRole("textbox", { name: "搜索异常" })
      .fill("不存在的日志关键字");
    await page.getByText("没有匹配的异常记录", { exact: true }).waitFor();
    await page.getByRole("textbox", { name: "搜索异常" }).fill("");
    await page
      .getByText("共 1 条异常记录 · 每 10 秒更新", { exact: true })
      .waitFor();
    failNext = true;
    await page.getByRole("button", { name: "刷新日志", exact: true }).click();
    await page.getByText("异常日志读取失败", { exact: true }).waitFor();
    assert.equal(
      await list
        .getByText("正文排版未通过，原稿已保留。", { exact: true })
        .count(),
      1,
      "刷新失败保留已有内容",
    );
    await page.getByRole("button", { name: "重试读取", exact: true }).click();
    await page
      .getByText("异常日志读取失败", { exact: true })
      .waitFor({ state: "hidden" });
    await page.reload();
    await page
      .getByText("共 1 条异常记录 · 每 10 秒更新", { exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("combobox", { name: "时间范围", exact: true })
        .getAttribute("data-value"),
      "30d",
    );
    assert.equal(
      await page
        .getByRole("combobox", { name: "来源模块", exact: true })
        .getAttribute("data-value"),
      "wechat",
    );
    copied = "";
    await page.getByRole("button", { name: "复制本页", exact: true }).click();
    for (let n = 0; !copied && n < 30; n++) await page.waitForTimeout(50);
    assert(copied.includes("正文排版未通过"));
    const overflow = await page
      .locator(".system-logs")
      .evaluate((e) => e.scrollWidth > e.clientWidth + 1);
    assert(!overflow, "1366桌面无横向溢出");
    const report = {
      windowId,
      out,
      checks: [
        "侧边栏入口",
        "首次加载无虚构0条",
        "历史AI结束状态与模型",
        "单条和整页复制且无正文",
        "跨页与筛选重置",
        "模块级别时间与关键词筛选",
        "空结果",
        "刷新失败保留内容与重试",
        "刷新恢复筛选",
        "1366桌面布局",
      ],
      paidRequests: 0,
    };
    await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
    return report;
  } catch (error) {
    await page.screenshot({ path: join(out, "failure.png") }).catch(() => {});
    throw error;
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}
