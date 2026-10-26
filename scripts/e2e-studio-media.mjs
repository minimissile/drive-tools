import { navigateTo } from "./e2e-navigation.mjs";
import { chooseOption } from "./e2e-select.mjs";
// Browser plugin not available; use the existing isolated Electron/Playwright workflow.
// External model calls are mocked; ffmpeg only creates a local moving-video QA fixture.
import { _electron as electron } from "playwright-core";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url),
  dataPath = await mkdtemp(join(tmpdir(), "panxu-studio-e2e-")),
  evidence = await mkdtemp(join(tmpdir(), "panxu-studio-qa-")),
  videoPath = join(evidence, "fixture.mp4");
execFileSync(process.env.PANXU_FFMPEG_PATH ?? "ffmpeg", [
  "-hide_banner",
  "-loglevel",
  "error",
  "-f",
  "lavfi",
  "-i",
  "testsrc2=size=360x640:rate=12:duration=2",
  "-an",
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  "-movflags",
  "+faststart",
  "-y",
  videoPath,
]);
const videoBase64 = (await readFile(videoPath)).toString("base64"),
  dev = process.env.PANXU_E2E_DEV === "1",
  env = {
    ...process.env,
    PANXU_DATA_DIR: dataPath,
    ...(dev
      ? {
          PANXU_DEV_URL: "http://127.0.0.1:8070",
          PANXU_DEV_ROOT: process.cwd(),
        }
      : {}),
  };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath: process.env.PANXU_ELECTRON_PATH ?? require("electron"),
  args: [dev ? join(process.cwd(), "dist-dev") : process.cwd()],
  env,
  timeout: 45000,
});
let page;
const errors = [],
  checks = [];
try {
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "资源库", exact: true }).click();
  await page.locator(".resource-list").waitFor();
  if (dev)
    assert.equal(
      (await page.evaluate(() => window.panxu.invoke("dev.status"))).mode,
      "development",
    );
  await page.evaluate(() =>
    window.panxu.invoke("updater.configure", { autoCheck: false }),
  );
  const image = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 720;
    c.height = 960;
    const x = c.getContext("2d");
    x.fillStyle = "#f4f8f5";
    x.fillRect(0, 0, 720, 960);
    x.fillStyle = "#276d55";
    x.fillRect(45, 50, 70, 8);
    x.font = "bold 44px sans-serif";
    x.fillText("英语课堂练习", 45, 150);
    x.font = "23px sans-serif";
    x.fillStyle = "#334b42";
    x.fillText("先看资料主题，再安排课堂任务", 45, 210);
    for (let i = 0; i < 3; i++) {
      x.fillStyle = "white";
      x.fillRect(45, 270 + i * 160, 630, 125);
      x.fillStyle = "#276d55";
      x.font = "bold 26px sans-serif";
      x.fillText(`0${i + 1}  课堂教学要点`, 70, 320 + i * 160);
      x.font = "20px sans-serif";
      x.fillStyle = "#526960";
      x.fillText("根据已记录的资料说明整理", 70, 360 + i * 160);
    }
    x.font = "17px sans-serif";
    x.fillText("QA 模拟素材 · 验证图片保存与显示", 45, 900);
    return c.toDataURL("image/png").split(",")[1];
  });
  await app.evaluate(
    ({ dialog }, args) => {
      globalThis.__studioQa = {
        posts: 0,
        polls: 0,
        downloads: 0,
        texts: 0,
        external: 0,
        payloads: [],
        video: args.videoBase64,
        image: args.image,
      };
      dialog.showSaveDialog = async (_w, options) => ({
        canceled: false,
        filePath: `${args.evidence}/${options.defaultPath}`,
      });
      globalThis.fetch = async (url, init) => {
        const u = String(url),
          q = globalThis.__studioQa;
        if (u.endsWith("/api/v1/models"))
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: "qa/text",
                  supported_parameters: ["structured_outputs"],
                  pricing: { prompt: "0.0000001", completion: "0.0000001" },
                },
              ],
            }),
          );
        if (u.endsWith("/images/models"))
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: "qa/image",
                  name: "QA图片模型",
                  supported_parameters: {
                    aspect_ratio: { values: ["3:4", "9:16"] },
                    input_references: { max: 1 },
                  },
                },
              ],
            }),
          );
        if (u.endsWith("/videos/models"))
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: "qa/video",
                  name: "QA动态视频模型",
                  supported_aspect_ratios: ["9:16"],
                  supported_durations: [8],
                  supported_resolutions: ["720p"],
                  generate_audio: true,
                  supported_frame_images: ["first_frame"],
                  pricing_skus: { "per-video-second": "0.1" },
                },
              ],
            }),
          );
        if (u.endsWith("/chat/completions")) {
          q.texts++;
          const p = JSON.parse(init.body),
            input = JSON.parse(p.messages[1].content);
          q.payloads.push(input);
          return new Response(
            JSON.stringify({
              usage: { cost: 0.001 },
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      title: `英语课堂${input.format}营销内容`,
                      body: "根据已记录的英语口语资料整理，按教学场景选择练习主题，先核对实际资料内容再备课。",
                      tags: ["英语教学"],
                      coverText: "口语练习",
                      cards: Array.from(
                        { length: input.pageCount },
                        (_, i) => ({
                          heading: `英语课堂第${i + 1}页`,
                          copy: "先选择口语主题，再安排课堂任务。",
                          imagePrompt:
                            "绿色编辑式版面，英语课堂主题的概念插图，统一留白与字体风格",
                        }),
                      ),
                      videoPrompt:
                        input.format === "video"
                          ? "一个明亮的教室中，老师翻开练习册，镜头缓慢推进，学生在白板前进行口语对话，纸页自然翻动。"
                          : "",
                      voiceover:
                        input.format === "video"
                          ? "从口语练习主题出发，选择适合课堂的资料。"
                          : "",
                    }),
                  },
                },
              ],
            }),
          );
        }
        if (u.endsWith("/images") && init?.method === "POST") {
          q.posts++;
          q.payloads.push(JSON.parse(init.body));
          return new Response(
            JSON.stringify({
              data: [{ b64_json: q.image }],
              usage: { cost: 0.02 },
            }),
          );
        }
        if (u.endsWith("/videos") && init?.method === "POST") {
          q.posts++;
          q.payloads.push(JSON.parse(init.body));
          return new Response(
            JSON.stringify({ id: "qa-motion-job", status: "pending" }),
          );
        }
        if (u.endsWith("/videos/qa-motion-job")) {
          q.polls++;
          return new Response(
            JSON.stringify({
              id: "qa-motion-job",
              status: "completed",
              usage: { cost: 0.8 },
            }),
          );
        }
        if (u.endsWith("/videos/qa-motion-job/content?index=0")) {
          q.downloads++;
          return new Response(Buffer.from(q.video, "base64"), {
            headers: { "Content-Type": "video/mp4" },
          });
        }
        q.external++;
        throw new Error("QA禁止其他外部请求");
      };
    },
    { image, videoBase64, evidence },
  );
  const saved = await page.evaluate(async () => {
    const a = await window.panxu.invoke("account.add", {
        provider: "quark",
        alias: "营销素材测试账号",
      }),
      s = await window.panxu.invoke("resource.save", {
        title: "英语口语课堂资料",
        sourceText: "https://pan.quark.cn/s/studio-source",
        category: "英语教学",
        summary: "已整理的英语口语练习主题与目录",
        tags: ["英语"],
        accountId: a.id,
        directory: "/盘序资源",
        rightsConfirmed: false,
        enqueue: false,
      });
    await window.panxu.invoke("secret.save", {
      kind: "openrouter",
      value: "test-only-studio-key",
    });
    await window.panxu.invoke("ai.models");
    await window.panxu.invoke("settings.save", {
      model: "qa/text",
      exportCodes: false,
      bitUrl: "",
      dailyAiBudgetMicros: 20_000_000,
    });
    return { ...s, accountId: a.id };
  });
  await app.evaluate(async ({ app }, s) => {
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite"),
      db = new DatabaseSync(`${app.getPath("userData")}/panxu.db`),
      time = new Date().toISOString();
    db.prepare(
      "UPDATE accounts SET uid='qa-owner',status='connected',verified_at=? WHERE id=?",
    ).run(time, s.accountId);
    db.prepare(
      "UPDATE copies SET status='ready',owner_uid='qa-owner',verified_at=?,share_id='qa-share',share_url='https://pan.quark.cn/s/studio-own',share_owner_uid='qa-owner',share_verified_at=?,files=? WHERE id=?",
    ).run(
      time,
      time,
      JSON.stringify([
        {
          id: "qa-file",
          name: "口语练习.pdf",
          isDirectory: false,
          parentId: "qa-folder",
        },
      ]),
      s.copyId,
    );
    db.close();
  }, saved);
  await navigateTo(page, "内容工作室");
  await page.getByRole("button", { name: "AI 图片", exact: true }).click();
  await page
    .getByRole("button", { name: "保存自定义模板", exact: true })
    .click();
  await page.getByLabel("自定义模板名称").fill("英语老师推荐模板");
  await page
    .getByLabel("自定义模板风格")
    .fill("暖白背景与绿色重点，版面适合老师快速阅读");
  await page
    .getByLabel("自定义模板要求")
    .fill("先说适合谁，再说课堂用途，最后给出使用提醒");
  await page.getByRole("button", { name: "另存模板", exact: true }).click();
  await page.getByRole("button", { name: /英语老师推荐模板/ }).waitFor();
  await page
    .locator(".creative-setup")
    .evaluate((e) => e.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: join(evidence, "01-formats-templates.png") });
  await page
    .getByLabel("营销创作要求")
    .fill("面向小学英语教师，重点说明口语练习的课堂用途");
  await page.getByRole("button", { name: "生成AI草稿", exact: true }).click();
  await page.getByLabel("第1页画面要求").waitFor();
  assert.equal(
    await page.getByLabel("已人工审阅", { exact: true }).isDisabled(),
    true,
  );
  await page.getByRole("button", { name: "刷新素材模型", exact: true }).click();
  await chooseOption(page.getByLabel("素材生成模型"), "qa/image");
  await page.getByLabel("素材费用预留").fill("0.10");
  await page.getByRole("button", { name: "生成此图", exact: true }).click();
  await page.getByRole("img", { name: "营销图片1", exact: true }).waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector(".creative-asset-preview img")?.naturalWidth ===
      720,
  );
  await page.getByRole("button", { name: "导出图片", exact: true }).click();
  const imageBytes = await readFile(join(evidence, "营销素材.png"));
  assert.equal(imageBytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  await page.getByLabel("已人工审阅", { exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('input[aria-label="已人工审阅"]')?.checked,
  );
  await page
    .locator(".creative-asset")
    .evaluate((e) => e.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: join(evidence, "02-image-complete.png") });
  checks.push(
    "四种形式与自定义模板 → AI方案 → 实际PNG生成、显示、导出及审阅门槛",
  );
  await page
    .getByLabel("内容正文")
    .fill("人工修改后的营销文案，仍使用原来已核对的图片。");
  const previousVersion = await page
    .getByLabel("内容版本", { exact: true })
    .getAttribute("data-value");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await page.waitForFunction((previousVersion) => {
    const version = document.querySelector('[aria-label="内容版本"]')?.dataset.value;
    return version && version !== previousVersion;
  }, previousVersion);
  await page.getByRole("img", { name: "营销图片1", exact: true }).waitFor();
  assert.equal(await app.evaluate(() => globalThis.__studioQa.posts), 1);
  checks.push("文案另存版本保留已有图片，不重新生成或增加素材费用");
  if (
    !(await page.locator(".studio-creation").getAttribute("open")) &&
    !(await page
      .getByRole("button", { name: "图文组图", exact: true })
      .isVisible())
  )
    await page.locator(".studio-creation > summary").click();
  await page.getByRole("button", { name: "图文组图", exact: true }).click();
  await page.getByLabel("图文页数").fill("2");
  await page.getByRole("button", { name: "生成AI草稿", exact: true }).click();
  await page.getByText("第 2 页", { exact: false }).first().waitFor();
  await page.getByRole("button", { name: /依次生成剩余/ }).click();
  await page.getByRole("img", { name: "营销图片2", exact: true }).waitFor();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll(".creative-asset-preview img")].length ===
        2 &&
      [...document.querySelectorAll(".creative-asset-preview img")].every(
        (i) => i.naturalWidth > 0,
      ),
  );
  checks.push("图文组图按所选页数生成独立图片并保留页面文案与画面要求");
  if (
    !(await page
      .getByRole("button", { name: "AI 动态视频", exact: true })
      .isVisible())
  )
    await page.locator(".studio-creation > summary").click();
  await page.getByRole("button", { name: "AI 动态视频", exact: true }).click();
  await page.getByRole("button", { name: /动态展示/ }).click();
  await page.getByRole("button", { name: "生成AI草稿", exact: true }).click();
  await page.getByLabel("视频画面要求").waitFor();
  await chooseOption(page.getByLabel("素材生成模型"), "qa/video");
  await page.getByLabel("素材费用预留").fill("1");
  await page
    .getByRole("button", { name: "生成AI动态视频", exact: true })
    .click();
  await page.getByText("远端排队中", { exact: true }).waitFor();
  assert.equal(await app.evaluate(() => globalThis.__studioQa.posts), 4);
  await page.reload();
  await page.getByText("远端排队中", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "查询进度 / 下载", exact: true })
    .click();
  const video = page.getByLabel("AI营销视频", { exact: true });
  await video.waitFor();
  await page.waitForFunction(() => {
    const v = document.querySelector(".creative-asset-preview video");
    return v?.readyState >= 2 && v.duration > 1;
  });
  await video.evaluate(async (v) => {
    v.muted = true;
    await v.play();
  });
  await page.waitForFunction(
    () =>
      document.querySelector(".creative-asset-preview video")?.currentTime >
      0.3,
  );
  await video.evaluate((v) => v.pause());
  await page.getByRole("button", { name: "导出视频", exact: true }).click();
  const output = await readFile(join(evidence, "营销素材.mp4"));
  assert.equal(output.toString("ascii", 4, 8), "ftyp");
  assert.equal(await app.evaluate(() => globalThis.__studioQa.posts), 4);
  assert.equal(await app.evaluate(() => globalThis.__studioQa.polls), 1);
  assert.equal(await app.evaluate(() => globalThis.__studioQa.downloads), 1);
  checks.push(
    "真实动态视频接口任务 → 重载保留ID → 查询下载MP4 → 本地播放器实际播放、导出且无重复提交",
  );
  await page.getByLabel("已人工审阅", { exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('input[aria-label="已人工审阅"]')?.checked,
  );
  await page.getByRole("button", { name: "准备发布", exact: true }).click();
  await page.locator(".creative-gallery video").waitFor();
  await page.waitForFunction(
    () => document.querySelector(".creative-gallery video")?.duration > 1,
  );
  checks.push("发布准备显示当前已审阅版本的视频成品");
  await navigateTo(page, "内容工作室");
  await page.getByLabel("AI营销视频", { exact: true }).waitFor();
  await page
    .locator(".creative-asset")
    .evaluate((e) => e.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: join(evidence, "03-video-desktop.png") });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(840, 760),
  );
  await page
    .locator(".creative-asset")
    .evaluate((e) => e.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: join(evidence, "04-video-compact.png") });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  assert.equal(await app.evaluate(() => globalThis.__studioQa.external), 0);
  if (dev) assert.equal(new URL(page.url()).origin, "http://127.0.0.1:8070");
  else assert.match(page.url(), /dist\/index.html/);
  assert.match(await page.title(), /盘序/);
  assert.equal(await page.locator("vite-error-overlay").count(), 0);
  assert.deepEqual(errors, []);
  checks.push("1320px与840px布局、页面身份、无前端异常、无真实外部调用");
  console.log(
    JSON.stringify(
      { passed: checks.length, checks, evidence, dataPath, errors },
      null,
      2,
    ),
  );
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(evidence, "failure.png") });
    console.error({ evidence });
  }
  throw error;
} finally {
  await app.close();
}
