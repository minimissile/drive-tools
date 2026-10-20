import assert from "node:assert/strict";

/** Exercise the visible Base UI popup rather than changing hidden form state. */
export async function chooseOption(control, value) {
  const page = control.page();
  await control.click();
  const option = page
    .getByRole("option")
    .filter({ visible: true })
    .and(page.locator(`[data-value=${JSON.stringify(String(value))}]`));
  await option.scrollIntoViewIfNeeded();
  await option.click();
  await page.getByRole("listbox").waitFor({ state: "hidden" });
  assert.equal(await control.getAttribute("data-value"), String(value));
}
