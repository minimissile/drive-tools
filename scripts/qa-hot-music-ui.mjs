import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

/** Dedicated fixture only: no real backend, credentials, paid calls or global mocks. */
export async function run({ page, checkpoint, windowId }) {
  const evidence = resolve("test-results/hot-music-ui");
  await mkdir(evidence, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  const url = new URL(page.url());
  url.pathname = "/__qa-local-video.html";
  url.search = `?run=${encodeURIComponent(windowId)}`;
  await page.goto(url.href);
  const frame = page.frameLocator('iframe[title="本地视频制作内存模拟页面"]');
  const root = frame.locator("main");
  const picker = frame.locator(".hot-music-picker");
  const helper = async (method, value) =>
    root.evaluate(
      (_element, { method, value }) => window.__localVideoQa[method](value),
      { method, value },
    );
  const click = async (name) =>
    frame.getByRole("button", { name, exact: true }).dispatchEvent("click");
  const choose = async (id) => {
    const select = frame.getByLabel("抖音热门配乐", { exact: true });
    await select.dispatchEvent("click");
    const option = frame
      .getByRole("option")
      .filter({ visible: true })
      .and(frame.locator(`[data-value="${id}"]`));
    await option.dispatchEvent("pointerdown", {
      pointerType: "mouse",
      button: 0,
    });
    await option.dispatchEvent("click");
    assert.equal(await select.getAttribute("data-value"), id);
  };
  try {
    await picker.locator("summary").waitFor();
    assert.equal(await helper("musicRequests"), 0);
    await picker.locator("summary").dispatchEvent("click");
    await frame.getByText("本地还没有热门配乐", { exact: true }).waitFor();
    assert.equal(await helper("musicRequests"), 0);
    await click("启用每周更新");
    await frame.getByLabel("抖音热门配乐", { exact: true }).waitFor();
    await frame.getByText(/下次更新/).waitFor();
    assert.equal(await helper("musicRequests"), 1);
    await click("检查更新");
    await frame
      .getByRole("button", { name: "使用配乐", exact: true })
      .waitFor();
    assert.equal(await helper("musicRequests"), 1);
    await click("使用配乐");
    await frame.getByText("轻快钢琴与午后微风.wav", { exact: true }).waitFor();
    await frame
      .getByRole("button", { name: "使用本地配乐", exact: true })
      .waitFor();
    assert.equal(await helper("musicRequests"), 2);
    await click("使用本地配乐");
    assert.equal(await helper("musicRequests"), 2);
    await checkpoint();
    await choose("7136850194742315017");
    await helper("failMusicAudio");
    await click("使用配乐");
    await frame.getByText("配乐获取未完成", { exact: true }).waitFor();
    assert.equal(await helper("musicRequests"), 3);
    await choose("7136850194742315016");
    await choose("7136850194742315017");
    assert.equal(await helper("musicRequests"), 3);
    assert.equal(
      await frame
        .getByRole("button", { name: "使用配乐", exact: true })
        .count(),
      0,
    );
    await click("重试获取配乐");
    await frame
      .getByText("适合目录展示的轻音乐（长标题与作者名称排版示例）.wav", {
        exact: true,
      })
      .waitFor();
    assert.equal(await helper("musicRequests"), 4);
    const events = await root.evaluate(() => window.__localVideoQa.events);
    assert.ok(events.includes("music:audio:7136850194742315017:true"));
    await helper("musicError");
    await frame.getByText("音乐榜更新未完成", { exact: true }).waitFor();
    assert.equal(
      await frame.getByLabel("抖音热门配乐", { exact: true }).count(),
      1,
    );
    await picker.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `${evidence}/01-retained-library-error.png`,
      fullPage: true,
    });
    await click("重试更新");
    await frame
      .getByRole("button", { name: "检查更新", exact: true })
      .waitFor();
    assert.equal(await helper("musicRequests"), 5);
    await click("暂停每周更新");
    await frame
      .getByRole("button", { name: "启用每周更新", exact: true })
      .waitFor();
    assert.equal(await helper("musicRequests"), 5);
    await choose("7136850194742315016");
    const overflow = await root.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    );
    assert.equal(overflow, false);
    await page.screenshot({
      path: `${evidence}/02-cached-music-picker.png`,
      fullPage: true,
    });
    await frame
      .getByRole("button", { name: "移除本地视频配乐", exact: true })
      .dispatchEvent("click");
    await frame.getByText("无配乐", { exact: true }).waitFor();
    await helper("waitMusicAudio");
    await click("使用本地配乐");
    await frame
      .getByRole("button", { name: "正在获取配乐…", exact: true })
      .waitFor();
    assert.equal(
      await frame
        .getByRole("button", { name: "制作视频", exact: true })
        .isDisabled(),
      true,
    );
    await helper("switchSource");
    await helper("releaseMusicAudio");
    await frame.getByText("无配乐", { exact: true }).waitFor();
    assert.equal(
      await frame
        .getByRole("button", { name: "制作视频", exact: true })
        .isDisabled(),
      false,
    );
    assert.equal(
      await frame.getByText("轻快钢琴与午后微风.wav", { exact: true }).count(),
      0,
    );
    assert.equal(await helper("musicRequests"), 5);
    return {
      evidence,
      checks: [
        "首次展开只读本地库，启用每周更新后取得榜单",
        "一周内检查更新、重复选用本地配乐不增加模拟远端请求",
        "失败歌曲切换后仍需明确重试；旧榜单在更新失败时保留",
        "暂停更新保留缓存，跨资源晚回应不覆盖新视频草稿",
        "1440×900长配乐标题无横向溢出",
      ],
      limitation:
        "专用iframe内存IPC模拟，使用DOM事件验收组件状态及布局；不覆盖真实TikHub付费调用与后端调度。",
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
