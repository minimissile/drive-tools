import type { BrowserContext, Page } from "playwright-core";
import {
  pageLedger,
  pageTarget,
  recordManagedPage,
  type ManagedPageRole,
} from "./browser-page-lifecycle";

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
  accepts?: (page: Page) => boolean,
  role: ManagedPageRole = "interactive",
): Promise<Page> => {
  const ledger = pageLedger(context);
  const pending = ledger.pending.get(key);
  if (pending) {
    const page = await pending;
    if (!page.isClosed() && (!accepts || accepts(page))) return page;
    return findEnvironmentPage(context, key, url, accepts, role);
  }
  const run = async () => {
    const origin = new URL(url).origin;
    for (const page of context.pages()) {
      if (page.isClosed() || (accepts && !accepts(page))) continue;
      const record = ledger.records.get(await pageTarget(context, page));
      // Target identity survives redirects and CDP reconnects. Legacy/restored
      // page names are used only for reuse, never as permission to close a tab.
      if (record?.key === key) return page;
      if (new URL(page.url()).origin !== origin) continue;
      if (
        await page
          .evaluate((name) => {
            if (window.name === name) return true;
            try {
              return sessionStorage.getItem("panxu:page-key") === name;
            } catch {
              return false;
            }
          }, key)
          .catch(() => false)
      )
        return page;
    }
    const page = await context.newPage();
    try {
      const record = {
        key,
        role,
        navigationStatus: undefined as number | undefined,
      };
      await recordManagedPage(context, page, record);
      const navigation = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      record.navigationStatus = navigation?.status();
      await page.evaluate((name) => {
        window.name = name;
        try {
          sessionStorage.setItem("panxu:page-key", name);
        } catch {}
      }, key);
      return page;
    } catch (error) {
      // Navigation errors can be a login/security page; retain it for inspection.
      throw error;
    }
  };
  const result = run();
  ledger.pending.set(key, result);
  try {
    return await result;
  } finally {
    if (ledger.pending.get(key) === result) ledger.pending.delete(key);
  }
};

export async function environmentPageStatus(
  context: BrowserContext,
  page: Page,
) {
  // Read the current document first: manually recovering a failed editor must
  // not keep reporting the original HTTP failure after a successful refresh.
  const current = await page
    .evaluate(() => {
      const navigation = performance.getEntriesByType("navigation")[0] as
        PerformanceNavigationTiming | undefined;
      const status = (navigation as { responseStatus?: number } | undefined)
        ?.responseStatus;
      return typeof status === "number" && status > 0 ? status : undefined;
    })
    .catch(() => undefined);
  return (
    current ??
    pageLedger(context).records.get(await pageTarget(context, page))
      ?.navigationStatus
  );
}
