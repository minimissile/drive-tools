import assert from "node:assert/strict";
import { access, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

/** Run through test:session; only its own iframe's in-memory transport is used. */
// Native mouse/keyboard events currently fail to reach Electron's child frame.
// Dispatch DOM events intentionally: these checks cover component state and layout,
// not the native input path, real business IPC, or video encoding.
export async function run({ page, checkpoint, windowId }) {
  const evidence = resolve("test-results/local-video-ui");
  try {
    await access(resolve("test-results/local-video/service-1080-video.mp4"));
    await access(resolve("test-results/local-video/service-1080-cover.png"));
  } catch {
    throw new Error(
      "缺少本机真实渲染产物，请先运行 npm run test:video:render，再执行视频界面专项。",
    );
  }
  await mkdir(evidence, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  const url = new URL(page.url());
  url.pathname = "/__qa-local-video.html";
  url.search = `?run=${encodeURIComponent(windowId)}`;
  await page.goto(url.href);
  await page.bringToFront();
  const frame = page.frameLocator('iframe[title="本地视频制作内存模拟页面"]');
  const root = frame.locator("main");
  const helper = async (method, value) =>
    root.evaluate(
      (_element, { method, value }) => window.__localVideoQa[method](value),
      { method, value },
    );
  try {
    await frame
      .getByRole("button", { name: "制作视频", exact: true })
      .waitFor();
    await frame
      .getByRole("button", { name: "制作视频", exact: true })
      .dispatchEvent("click");
    await frame
      .getByText("正在制作", { exact: true })
      .waitFor({ timeout: 5000 });
    assert.equal(
      await frame
        .getByRole("button", { name: "制作视频", exact: true })
        .isDisabled(),
      true,
    );
    await frame
      .getByRole("button", { name: "取消制作", exact: true })
      .dispatchEvent("click");
    await frame.getByText("已取消", { exact: true }).waitFor();
    await helper("failNext");
    await frame
      .getByRole("button", { name: "使用当前设置重试", exact: true })
      .dispatchEvent("click");
    await frame.getByText("制作失败", { exact: true }).waitFor();
    await frame
      .getByText("模拟渲染失败，素材与设置已保留。", { exact: true })
      .waitFor();
    await frame
      .getByRole("button", { name: "使用当前设置重试", exact: true })
      .dispatchEvent("click");
    await frame.getByText("正在制作", { exact: true }).waitFor();
    await helper("complete");
    await frame.getByText("制作完成", { exact: true }).waitFor();
    const video = frame.getByLabel("本地制作视频预览", { exact: true });
    await video.evaluate(
      (element) =>
        new Promise((resolve, reject) => {
          if (element.readyState >= 1) return resolve();
          element.addEventListener("loadedmetadata", () => resolve(), {
            once: true,
          });
          element.addEventListener(
            "error",
            () => reject(new Error("真实视频素材未能加载")),
            { once: true },
          );
        }),
    );
    const metadata = await video.evaluate((element) => ({
      width: element.videoWidth,
      height: element.videoHeight,
      duration: element.duration,
    }));
    assert.equal(metadata.width, 1080);
    assert.equal(metadata.height, 1920);
    assert.ok(metadata.duration >= 6);
    await video.evaluate(async (element) => {
      element.muted = true;
      await element.play();
    });
    await video.evaluate(
      (element) =>
        new Promise((resolve) => {
          const ready = () => {
            if (element.currentTime <= 0.3) return;
            element.removeEventListener("timeupdate", ready);
            element.pause();
            resolve();
          };
          element.addEventListener("timeupdate", ready);
          ready();
        }),
    );
    await frame
      .getByRole("region", { name: "本地视频制作结果", exact: true })
      .scrollIntoViewIfNeeded();
    await frame
      .getByRole("button", { name: "导出视频", exact: true })
      .dispatchEvent("click");
    await frame
      .getByRole("button", { name: "导出封面", exact: true })
      .dispatchEvent("click");
    const events = await root.evaluate(() => window.__localVideoQa.events);
    assert.deepEqual(events, [
      "create",
      "cancel",
      "create",
      "create",
      "export:video",
      "export:cover",
    ]);
    await page.screenshot({
      path: `${evidence}/01-directory-completed.png`,
      fullPage: true,
    });
    await frame
      .getByLabel("本地视频模板", { exact: true })
      .scrollIntoViewIfNeeded();
    await frame
      .getByLabel("本地视频标题", { exact: true })
      .fill("英语阅读与口语实践活动配套资料（含课堂活动说明与练习示例）");
    const template = frame.getByLabel("本地视频模板", { exact: true });
    await template.dispatchEvent("click");
    const slideshow = frame
      .getByRole("option")
      .filter({ visible: true })
      .and(frame.locator('[data-value="slideshow"]'));
    await slideshow.dispatchEvent("pointerdown", {
      pointerType: "mouse",
      button: 0,
    });
    await slideshow.dispatchEvent("click");
    assert.equal(await template.getAttribute("data-value"), "slideshow");
    await frame
      .getByRole("button", { name: "添加图片", exact: true })
      .dispatchEvent("click");
    await frame
      .getByLabel("本地视频第1张图片说明", { exact: true })
      .fill("第一单元 · 阅读与课堂活动，先核对适用年级");
    await frame
      .getByRole("button", { name: "添加配乐", exact: true })
      .dispatchEvent("click");
    await frame.getByText("本地配乐.wav", { exact: true }).waitFor();
    await page.screenshot({
      path: `${evidence}/02-slideshow-assets.png`,
      fullPage: true,
    });
    await checkpoint();
    // Reload only the dedicated frame: it must recover the actual per-window draft stores.
    await root.evaluate(() => location.reload());
    await frame.getByLabel("本地视频第1张图片说明", { exact: true }).waitFor();
    assert.equal(
      await frame.getByLabel("本地视频标题", { exact: true }).inputValue(),
      "英语阅读与口语实践活动配套资料（含课堂活动说明与练习示例）",
    );
    assert.equal(
      await frame
        .getByLabel("本地视频第1张图片说明", { exact: true })
        .inputValue(),
      "第一单元 · 阅读与课堂活动，先核对适用年级",
    );
    await frame.getByText("本地配乐.wav", { exact: true }).waitFor();
    await helper("failRead", true);
    await frame.getByText("暂时无法读取视频任务", { exact: true }).waitFor();
    assert.equal(
      await frame
        .getByRole("button", { name: "制作视频", exact: true })
        .isDisabled(),
      true,
    );
    await helper("failRead", false);
    await frame
      .getByRole("button", { name: "重试读取", exact: true })
      .dispatchEvent("click");
    await helper("runtime", false);
    await frame
      .getByText("未找到本地浏览器，请准备浏览器后重新检查。", { exact: false })
      .waitFor();
    assert.equal(
      await frame
        .getByRole("button", { name: "制作视频", exact: true })
        .isDisabled(),
      true,
    );
    const overflow = await root.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    );
    assert.equal(overflow, false);
    await page.screenshot({
      path: `${evidence}/03-runtime-unavailable.png`,
      fullPage: true,
    });
    return {
      evidence,
      checks: [
        "真实源码界面通过内存IPC验证制作、取消、失败重试与导出",
        "本机真实1080p视频已加载元数据并实际播放推进后暂停",
        "图片和配乐在专用窗口刷新后由IndexedDB恢复",
        "任务读取失败及本地环境不可用时阻止新建任务",
        "1440×900布局与长内容无横向溢出",
      ],
      limitation:
        "本测试通过DOM事件覆盖UI状态；Electron子框原生输入未验证，不覆盖视频编码与真实业务IPC。",
    };
  } catch (error) {
    await page
      .screenshot({ path: `${evidence}/failure.png`, fullPage: true })
      .catch(() => {});
    console.error(await root.textContent().catch(() => "无法读取测试页面"));
    throw error;
  } finally {
    await helper("cleanup").catch(() => {});
  }
}
