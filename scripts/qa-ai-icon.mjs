import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

export async function run({ page, checkpoint, windowId }) {
  await page.setViewportSize({ width: 1440, height: 900 });
  const action = page.getByRole("button", { name: "AI生成清单", exact: true });
  await action.waitFor();
  const icon = action.locator("svg.lucide-cpu");
  assert.equal(await icon.count(), 1);
  assert.equal(await icon.getAttribute("aria-hidden"), "true");
  assert.equal(
    await action
      .locator("svg.lucide-sparkles, svg.lucide-wand-sparkles")
      .count(),
    0,
  );
  const sizes = await icon.evaluate((el) => {
    const bounds = el.getBoundingClientRect();
    return {
      width: bounds.width,
      height: bounds.height,
      color: getComputedStyle(el).color,
    };
  });
  assert.equal(sizes.width, 16);
  assert.equal(sizes.height, 16);
  await action.focus();
  await checkpoint();
  const evidence = resolve("test-results/ai-icon");
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: resolve(evidence, "resource-catalog.png") });
  return {
    windowId,
    icon: "Cpu",
    sizes,
    evidence,
    note: "仅核对图标与按钮呈现；未触发生成或修改数据。",
  };
}
