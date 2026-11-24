import type { BrowserContext } from "playwright-core";
/** Extend small business fixtures with the CDP/page-lifecycle methods, without
 * treating lifecycle probes as business evaluations or remote submissions. */
export function withPageLifecycleFixture(
  context: BrowserContext,
): BrowserContext {
  const c = context as any;
  const ids = new WeakMap<object, string>();
  const pages = new Set<any>();
  const originalPages = c.pages?.bind(c);
  const decorate = (page: any) => {
    if (ids.has(page)) return page;
    ids.set(page, `fixture-${idsCounter++}`);
    pages.add(page);
    page.isClosed ??= () => false;
    page.context ??= () => c;
    page.addInitScript = async () => {};
    page.exposeFunction = async () => {};
    page.frames = () => [{ evaluate: async () => true }];
    const evaluate = page.evaluate?.bind(page);
    page.evaluate = async (fn: any, ...args: any[]) =>
      typeof fn === "function" && String(fn).includes("__panxuPageGuard")
        ? undefined
        : evaluate?.(fn, ...args);
    return page;
  };
  c.pages = () =>
    [...new Set([...(originalPages?.() ?? []), ...pages])].map(decorate);
  const newPage =
    c.newPage?.bind(c) ??
    (async () => {
      throw new Error("此业务夹具不应新建页面");
    });
  c.newPage = async () => decorate(await newPage());
  c.newCDPSession = async (page: any) => {
    decorate(page);
    return {
      send: async () => ({ targetInfo: { targetId: ids.get(page) } }),
      detach: async () => {},
    };
  };
  // A user's pre-existing tab is outside each temporary business fixture.
  const list = c.pages;
  c.pages = () => [
    ...list(),
    {
      isClosed: () => false,
      url: () => "about:blank",
      evaluate: async () => false,
    },
  ];
  return context;
}
let idsCounter = 0;
