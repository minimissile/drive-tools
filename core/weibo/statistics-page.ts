/** Read the selected post only. No clicks, requests, credentials or other feed content. */
export async function weiboStatisticsPage(input: { uid: string; url: string }) {
  const expected = new URL(input.url);
  if (
    location.protocol !== "https:" ||
    !["weibo.com", "www.weibo.com"].includes(location.hostname) ||
    location.pathname.replace(/\/$/, "") !== expected.pathname
  )
    throw Error("微博详情页发生跳转，请在官方窗口核对链接。");
  const viewer = String(
    (window as any).$CONFIG?.uid ?? (window as any).$CONFIG?.user?.idstr ?? "",
  );
  if (viewer !== input.uid)
    throw Error("当前微博登录身份与统计账号不一致，请检查登录。");
  const bid = expected.pathname.split("/").pop();
  const metric = (raw: unknown) => {
    const display =
      typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0
        ? String(raw)
        : typeof raw === "string"
          ? raw.trim().slice(0, 60)
          : "";
    if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?(?:万|亿)?\+?$/.test(display))
      return { value: null, display: null, approximate: false };
    const exact = /^\d+$/.test(display.replace(/,/g, ""));
    const value = exact ? Number(display.replace(/,/g, "")) : null;
    return {
      value: value !== null && Number.isSafeInteger(value) ? value : null,
      display,
      approximate: !exact || (value !== null && !Number.isSafeInteger(value)),
    };
  };
  let partial: {
    uid: string;
    url: string;
    metrics: {
      reads: ReturnType<typeof metric>;
      reposts: ReturnType<typeof metric>;
      comments: ReturnType<typeof metric>;
      likes: ReturnType<typeof metric>;
      linkClicks: ReturnType<typeof metric>;
    };
  } | null = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    let status: any = null;
    const targetRoots = new Set<HTMLElement>();
    const otherPostRoots = new Set<HTMLElement>();
    const matches = (value: any) =>
      value &&
      typeof value === "object" &&
      String(value.mblogid ?? value.bid ?? "") === bid &&
      String(value.user?.idstr ?? value.user?.id ?? "") === input.uid;
    const accept = (value: any, element?: any) => {
      const raw = value?.value ?? value;
      if (matches(raw)) {
        status = raw;
        if (element instanceof HTMLElement) targetRoots.add(element);
      } else if (
        element instanceof HTMLElement &&
        /^[a-zA-Z0-9]+$/.test(String(raw?.mblogid ?? raw?.bid ?? "")) &&
        /^\d+$/.test(String(raw?.user?.idstr ?? raw?.user?.id ?? ""))
      ) otherPostRoots.add(element);
    };
    const seen = new Set<any>();
    const visit = (vnode: any) => {
      if (
        !vnode ||
        typeof vnode !== "object" ||
        seen.has(vnode) ||
        seen.size > 15000
      )
        return;
      seen.add(vnode);
      const component = vnode.component;
      if (component) {
        for (const source of [
          component.props,
          component.setupState,
          component.proxy?.$data,
        ]) {
          for (const name of ["data", "status", "mblog", "weibo"])
            accept(source?.[name], component.proxy?.$el);
        }
        visit(component.subTree);
      }
      if (Array.isArray(vnode.children)) vnode.children.forEach(visit);
      if (Array.isArray(vnode.dynamicChildren))
        vnode.dynamicChildren.forEach(visit);
      visit(vnode.suspense?.activeBranch);
    };
    for (const root of document.querySelectorAll("[data-v-app]"))
      visit(
        (root as any)._vnode ?? (root as any).__vue_app__?._container?._vnode,
      );
    const permalink = [
      ...document.querySelectorAll<HTMLAnchorElement>("a[href]"),
    ].find((link) => {
      try {
        const url = new URL(link.href);
        return (
          ["weibo.com", "www.weibo.com"].includes(url.hostname) &&
          url.pathname.replace(/\/$/, "") === expected.pathname
        );
      } catch {
        return false;
      }
    });
    // Only a component bound to this exact status can supply its DOM metrics.
    // Select the smallest such content boundary before looking for a read label;
    // a missing label must never widen the search to the page or another post.
    const postText = String(status?.text_raw ?? status?.text ?? "")
      .replace(/<[^>]*>/g, "")
      .replace(/\s+/g, "");
    const boundaries = permalink ? [...targetRoots].filter((root) => {
      if (
        root === document.body ||
        root.hasAttribute("data-v-app") ||
        !root.contains(permalink) ||
        !postText ||
        !(root.textContent ?? "").replace(/\s+/g, "").includes(postText)
      ) return false;
      const links = [...root.querySelectorAll<HTMLAnchorElement>("a[href]")];
      const hasAuthor = links.some((link) => {
        const url = new URL(link.href);
        return ["weibo.com", "www.weibo.com"].includes(url.hostname) &&
          url.pathname.replace(/\/$/, "") === `/u/${input.uid}`;
      });
      const hasOtherPost = links.some((link) => {
        const url = new URL(link.href);
        return ["weibo.com", "www.weibo.com"].includes(url.hostname) &&
          /^\/\d+\/[a-zA-Z0-9]+\/?$/.test(url.pathname) &&
          url.pathname.replace(/\/$/, "") !== expected.pathname;
      });
      return hasAuthor && !hasOtherPost &&
        ![...otherPostRoots].some((other) => root.contains(other));
    }) : [];
    const scoped = boundaries.reduce<HTMLElement | null>(
      (smallest, root) => !smallest || smallest.contains(root) ? root : smallest,
      null,
    );
    if (status) {
      let reads: string | undefined;
      if (scoped) {
        const labels = scoped.querySelectorAll<HTMLElement>("span,div");
        for (const label of labels) {
          if (!label.getClientRects().length || label.childElementCount > 3)
            continue;
          for (const raw of [
            label.innerText,
            label.getAttribute("aria-label"),
            label.getAttribute("title"),
          ]) {
            const text = raw?.replace(/[\u200b-\u200d\ufeff]/g, "").trim();
            const match = text?.match(
              /^([\d,.]+(?:万|亿)?\+?)\s*阅读\s*[\ue000-\uf8ff]*$/,
            );
            if (match) {
              reads = match[1];
              break;
            }
          }
          if (reads !== undefined) break;
        }
      }
      const metrics = {
        reads: metric(reads ?? status?.reads_count),
        reposts: metric(status?.reposts_count),
        comments: metric(status?.comments_count),
        likes: metric(status?.attitudes_count),
        linkClicks: metric(null),
      };
      if (Object.values(metrics).some((item) => item.display !== null))
        partial = { uid: input.uid, url: input.url, metrics };
      if (metrics.reads.display !== null) return partial!;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (partial) return partial;
  throw Error(
    "暂未读取到这条微博的统计。请检查微博是否仍可访问，完成安全验证后重试；历史数据已保留。",
  );
}

export const weiboStatisticsScript = (uid: string, url: string) =>
  `(() => { const __name = (fn) => fn; return (${weiboStatisticsPage.toString()})(${JSON.stringify({ uid, url })}); })()`;
