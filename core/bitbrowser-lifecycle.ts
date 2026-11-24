import {
  chromium,
  type BrowserContext,
  type CDPSession,
} from "playwright-core";
import { randomUUID } from "node:crypto";
import {
  attachPageLedger,
  BrowserPageLedger,
  inspectManagedPages,
  pageLifecycleStep,
} from "./browser-page-lifecycle";

/** Ownership lasts only for this application process and this exact CDP endpoint. */
export class BitBrowserLifecycle {
  readonly token = `--panxu-window-owner=${randomUUID()}`;
  private sessions = new Map<
    string,
    {
      endpoint: string;
      owned: boolean;
      retained: boolean;
      lastUsed: number;
      ledger: BrowserPageLedger;
    }
  >();
  private active = new Map<string, number>();
  private retained = new Set<string>();
  key(connector: string, id: string) {
    return JSON.stringify([connector, id]);
  }
  keep(key: string) {
    this.retained.add(key);
    const s = this.sessions.get(key);
    if (s) s.retained = true;
  }
  forget(key: string) {
    this.sessions.delete(key);
    this.retained.delete(key);
  }
  begin(key: string) {
    this.active.set(key, (this.active.get(key) ?? 0) + 1);
  }
  end(key: string) {
    const count = (this.active.get(key) ?? 1) - 1;
    if (count) this.active.set(key, count);
    else this.active.delete(key);
    const session = this.sessions.get(key);
    if (session) session.lastUsed = Date.now();
  }
  async attach(
    key: string,
    endpoint: string,
    context: BrowserContext,
    attest?: () => Promise<boolean>,
    options: { timeoutMs?: number } = {},
  ) {
    let session = this.sessions.get(key);
    if (!session || session.endpoint !== endpoint) {
      let cdp: CDPSession | undefined;
      let owned = false;
      try {
        cdp = await pageLifecycleStep(
          "owner-attach",
          () => context.browser()!.newBrowserCDPSession(),
          options.timeoutMs,
        );
        owned = (
          await pageLifecycleStep(
            "owner-command",
            () => cdp!.send("Browser.getBrowserCommandLine"),
            options.timeoutMs,
          )
        ).arguments.includes(this.token);
      } catch {
        owned = attest
          ? await pageLifecycleStep("owner-process", attest, options.timeoutMs).catch(() => false)
          : false;
      } finally {
        if (cdp)
          await pageLifecycleStep("owner-detach", () => cdp!.detach(), options.timeoutMs).catch(() => {});
      }
      session = {
        endpoint,
        owned,
        retained: this.retained.has(key),
        lastUsed: Date.now(),
        ledger: new BrowserPageLedger(),
      };
      this.sessions.set(key, session);
      attachPageLedger(context, session.ledger);
      // Process ownership is not page ownership. Existing tabs, including an
      // empty about:blank, may belong to the user. Only createTemporaryPage can
      // grant disposal permission to a page this connection actually created.
    }
    attachPageLedger(context, session.ledger);
  }
  touch(key: string) {
    const session = this.sessions.get(key);
    if (session) session.lastUsed = Date.now();
  }
  candidates() {
    return [...this.sessions.keys()];
  }
  info(key: string) {
    const s = this.sessions.get(key);
    return {
      owner:
        s?.owned && !s.retained ? ("panxu" as const) : ("retained" as const),
      lastUsed: s?.lastUsed ?? null,
      busy: !!this.active.get(key),
    };
  }
  async inspect(key: string, clean = false) {
    const session = this.sessions.get(key);
    if (!session)
      return { temporary: 0, protected: 0, closed: 0, connected: false };
    if (this.active.get(key))
      throw new Error("窗口有进行中的操作，请稍后重试。");
    // Never call /browser/open for inspection, cleanup or idle expiry.
    const browser = await chromium.connectOverCDP(session.endpoint, {
      timeout: 5000,
      noDefaults: true,
    });
    try {
      const context = browser.contexts()[0];
      if (!context) throw new Error("窗口已关闭，请刷新窗口列表。");
      attachPageLedger(context, session.ledger);
      return {
        ...(await inspectManagedPages(context, clean)),
        connected: true,
      };
    } finally {
      await browser.close();
    }
  }
}
