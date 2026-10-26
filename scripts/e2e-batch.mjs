import { navigateTo } from "./e2e-navigation.mjs";
// Browser plugin unavailable: test only this script's isolated Electron + temporary workspace.
import { _electron as electron } from "playwright-core";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { chooseOption } from "./e2e-select.mjs";
const require = createRequire(import.meta.url),
  root = process.cwd(),
  evidence = await mkdtemp(join(tmpdir(), "panxu-batch-ui-")),
  dataPath = join(evidence, "data");
await mkdir(dataPath);
assert.equal(
  (await fetch("http://127.0.0.1:8070/__panxu_dev").then((r) => r.json())).root,
  root,
);
const env = {
  ...process.env,
  PANXU_DATA_DIR: dataPath,
  PANXU_DEV_URL: "http://127.0.0.1:8070",
  PANXU_DEV_ROOT: root,
};
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath: require("electron"),
  args: [join(root, "dist-dev")],
  env,
  timeout: 45000,
});
const errors = [],
  checks = [];
console.log("Batch UI evidence:", evidence);
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (e) => errors.push(e.message));
  await app.evaluate(({ session }) => {
    globalThis.fetch = async () => {
      throw Error("Isolated batch QA blocks external traffic");
    };
    session.defaultSession.webRequest.onBeforeRequest((d, cb) => {
      const u = new URL(d.url);
      cb({
        cancel:
          ["http:", "https:"].includes(u.protocol) &&
          u.origin !== "http://127.0.0.1:8070",
      });
    });
  });
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "资源库", exact: true }).click();
  await page.locator(".resource-list").waitFor();
  const account = await page.evaluate(() =>
    window.panxu.invoke("account.add", {
      provider: "quark",
      alias: "批量测试本人账号",
    }),
  );
  await app.evaluate(({ session }, accountId) => {
    const s = session.fromPartition(`persist:panxu-${accountId}`),
      folders = new Map([
        [
          "0",
          [
            {
              fid: "a",
              file_name: "学习资料合集与超长目录名称的可读性验证",
              dir: 1,
              size: 0,
            },
            { fid: "b", file_name: "第二个资料目录", dir: 1, size: 0 },
          ],
        ],
        ["a", []],
        ["b", []],
      ]),
      tasks = new Map();
    let writes = 0;
    globalThis.__batchQa = {
      get writes() {
        return writes;
      },
    };
    s.fetch = async (text, init = {}) => {
      const u = new URL(String(text)),
        body = init.body ? JSON.parse(String(init.body)) : {},
        path = u.pathname.replace("/1/clouddrive/", "");
      const response = (data) =>
          new Response(JSON.stringify(data), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ok = (data) => response({ code: 0, status: 200, data });
      if (u.pathname === "/account/info")
        return response({
          code: "OK",
          success: true,
          data: { uid: "isolated-batch-owner", nickname: "测试本人" },
        });
      if (path === "file/sort")
        return ok({ list: folders.get(u.searchParams.get("pdir_fid")) ?? [] });
      if (path === "file" && init.method === "POST") {
        const row = {
          fid: "created-" + ++writes,
          file_name: body.file_name,
          dir: 1,
          size: 0,
        };
        folders.get(body.pdir_fid).push(row);
        return ok({ fid: row.fid });
      }
      if (path === "file/upload/pre") {
        const taskId = "task-" + tasks.size;
        tasks.set(taskId, body);
        return ok({ task_id: taskId });
      }
      if (path === "file/update/hash") {
        const b = tasks.get(body.task_id);
        folders.get(b.pdir_fid).push({
          fid: "uploaded-" + ++writes,
          file_name: b.file_name,
          dir: 0,
          size: b.size,
        });
        return ok({ finish: true });
      }
      if (path === "member")
        return ok({ total_capacity: 1000000, use_capacity: 0 });
      throw Error("Unmocked request " + u.pathname);
    };
  }, account.id);
  await page.evaluate(
    (id) => window.panxu.invoke("account.check", { id }),
    account.id,
  );
  await page.reload();
  const nav = page.getByRole("navigation", { name: "主导航" });
  await navigateTo(page, "批量处理");
  assert.equal(
    await nav.getByRole("button", { name: "批量录入", exact: true }).count(),
    0,
  );
  assert.equal(
    await nav.getByRole("button", { name: "批量转存", exact: true }).count(),
    0,
  );
  await page.getByRole("tab", { name: "1 · 添加资料" }).click();
  await page
    .getByLabel("批量资源CSV")
    .fill(
      "标题,链接,分类\n批量示例,https://pan.quark.cn/s/example123,测试资料",
    );
  await page.getByRole("button", { name: "预检CSV", exact: true }).click();
  await page.getByRole("button", { name: /导入所选1份资料草稿/ }).click();
  await page.getByRole("button", { name: /继续检查并转存/ }).click();
  await page
    .getByRole("heading", { name: "选择待转存草稿", exact: true })
    .waitFor();
  checks.push("单一批量入口：CSV预检→本地导入→同页转存选择");
  assert.equal(await app.evaluate(() => globalThis.__batchQa.writes), 0);
  await page.getByRole("tab", { name: "批量插入", exact: true }).click();
  await page.getByLabel("插入素材名称").fill("更多资料 · 请阅读使用说明");
  await page
    .getByRole("button", { name: "加入本地素材库", exact: true })
    .click();
  await chooseOption(page.getByLabel("插入素材类型", { exact: true }), "txt");
  await page.getByLabel("插入素材名称").fill("资料使用与获取说明.txt");
  await page
    .getByLabel("插入TXT内容")
    .fill(
      "这是一份自有资料的说明。更多学习资料请查看本人主页，欢迎反馈资源更新建议。",
    );
  await page
    .getByRole("button", { name: "加入本地素材库", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "预览素材 资料使用与获取说明.txt",
      exact: true,
    })
    .click();
  await page
    .getByRole("dialog")
    .getByText(
      "这是一份自有资料的说明。更多学习资料请查看本人主页，欢迎反馈资源更新建议。",
      { exact: true },
    )
    .waitFor();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await chooseOption(page.getByLabel("插入素材类型", { exact: true }), "image");
  const png = await app.evaluate(({ nativeImage }) =>
    nativeImage
      .createFromBitmap(Buffer.alloc(32 * 32 * 4, 200), {
        width: 32,
        height: 32,
      })
      .toPNG()
      .toString("base64"),
  );
  await page
    .getByLabel("插入图片", { exact: true })
    .setInputFiles({
      name: "推广海报.png",
      mimeType: "image/png",
      buffer: Buffer.from(png, "base64"),
    });
  await page
    .getByRole("button", { name: "加入本地素材库", exact: true })
    .click();
  await page
    .getByRole("button", { name: "预览素材 推广海报.png", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("img", { name: "推广海报.png" })
    .waitFor();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await chooseOption(page.getByLabel("插入目标来源", { exact: true }), "drive");
  await chooseOption(
    page.getByLabel("浏览插入账号", { exact: true }),
    account.id,
  );
  await page.getByRole("button", { name: "展开 /", exact: true }).click();
  await page
    .getByLabel("选择目录 /学习资料合集与超长目录名称的可读性验证", {
      exact: true,
    })
    .check();
  await page.getByLabel("选择目录 /第二个资料目录", { exact: true }).check();
  await page.getByRole("button", { name: "预检插入明细", exact: true }).click();
  await page
    .getByRole("button", { name: "开始插入 6 项", exact: true })
    .waitFor();
  assert.equal(await app.evaluate(() => globalThis.__batchQa.writes), 0);
  assert.equal(
    await page
      .getByRole("button", { name: "开始插入 6 项", exact: true })
      .isEnabled(),
    false,
  );
  checks.push(
    "目标目录树多选、文件夹、TXT与图片素材及预览、预检无写入且需要本次确认",
  );
  for (const width of [1440, 840]) {
    await app.evaluate(({ BrowserWindow }, width) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.unmaximize();
      win.setSize(width, 960);
    }, width);
    await page.locator("main").evaluate((el) => el.scrollTo(0, 0));
    await page.screenshot({
      path: join(evidence, `insertion-top-${width}.png`),
      fullPage: true,
    });
    await page
      .getByRole("heading", { name: "3 · 确认与执行", exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(evidence, `insertion-${width}.png`),
      fullPage: true,
    });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    );
  }
  await page
    .getByText("我已核对上方目录和素材，确认有权向这些本人目录插入内容。", {
      exact: true,
    })
    .check();
  await page
    .getByRole("button", { name: "开始插入 6 项", exact: true })
    .click();
  await page.getByText("处理已结束", { exact: true }).waitFor();
  await page
    .getByText("已插入并核对目录结果。", { exact: true })
    .first()
    .waitFor();
  assert.equal(await app.evaluate(() => globalThis.__batchQa.writes), 6);
  await page.screenshot({
    path: join(evidence, "insertion-results-840.png"),
    fullPage: true,
  });
  await page.reload();
  await navigateTo(page, "批量处理");
  await page.getByRole("tab", { name: "批量插入", exact: true }).click();
  await page.getByText("处理已结束", { exact: true }).waitFor();
  assert.equal(await app.evaluate(() => globalThis.__batchQa.writes), 6);
  checks.push("显式启动完成6项、刷新恢复历史与目标、不重复写入");
  assert.deepEqual(errors, []);
  await writeFile(
    join(evidence, "checks.json"),
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors, evidence }, null, 2));
} finally {
  await app.close();
}
