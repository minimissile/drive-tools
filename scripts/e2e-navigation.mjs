// Operational tools live in Workbench; content planning remains in the sidebar.
export async function navigateTo(page, name) {
  const batchTab = name === "批量录入" ? "1 · 添加资料" : name === "批量转存" ? "2 · 检查并转存" : null;
  const sidebar = page.getByRole("navigation", { name: "主导航", exact: true });
  const direct = sidebar.getByRole("button", { name, exact: true });
  if (await direct.count()) {
    await direct.click();
    return;
  }
  await sidebar.getByRole("button", { name: "工作台", exact: true }).click();
  await page
    .locator(".workbench")
    .getByRole("button", { name: batchTab ? "批量处理" : name, exact: true })
    .click();
  if (batchTab) await page.getByRole("tab", { name: batchTab, exact: true }).click();
}
