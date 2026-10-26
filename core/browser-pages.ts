import type { BrowserContext, Page } from "playwright-core";

export const officialBrowserPage = (page: Page, hosts: string[]) => {
  const u = new URL(page.url());
  return (
    u.protocol === "https:" &&
    !u.username &&
    !u.password &&
    !u.port &&
    hosts.includes(u.hostname)
  );
};

export const findEnvironmentPage = async (
  context: BrowserContext,
  key: string,
  url: string,
) => {
  const origin = new URL(url).origin;
  for (const page of context.pages()) {
    if (page.isClosed() || new URL(page.url()).origin !== origin) continue;
    if (
      await page
        .evaluate((name) => window.name === name, key)
        .catch(() => false)
    )
      return page;
  }
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.evaluate((name) => {
      window.name = name;
    }, key);
    return page;
  } catch (error) {
    await page.close().catch(() => {});
    throw error;
  }
};
