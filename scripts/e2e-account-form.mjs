/** Account creation is progressively disclosed; exercise the same entry as a user. */
export async function openAccountForm(page) {
  await page.getByRole("heading", { name: "网盘账号", exact: true }).waitFor();
  if (!(await page.getByLabel("新增账号别名").isVisible())) {
    await page.getByRole("button", { name: "新增账号", exact: true }).click();
  }
  await page.getByLabel("新增账号别名").waitFor();
}
