import type { BrowserContext, CDPSession, Frame, Page } from "playwright-core";
import { AppError } from "./errors";

export type ManagedPageRole = "interactive" | "temporary";
export interface ManagedPageRecord {
  key: string;
  role: ManagedPageRole;
  touched?: boolean;
  documentId?: string;
  documentUrl?: string;
  expectedUrl?: string;
  navigationStatus?: number;
  protectionFailure?: string;
}
export class BrowserPageLedger {
  records = new Map<string, ManagedPageRecord>();
  pending = new Map<string, Promise<Page>>();
}
const ledgers = new WeakMap<BrowserContext, BrowserPageLedger>();
const pageRecords = new WeakMap<Page, ManagedPageRecord>();
const lifecycleTimeoutMs = 2500;

/** Bookkeeping must not indefinitely hold an account's business operation. */
export async function pageLifecycleStep<T>(
  stage: string,
  action: () => Promise<T>,
  timeoutMs = lifecycleTimeoutMs,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new AppError(
                "BROWSER_PAGE_LIFECYCLE_TIMEOUT",
                `浏览器页面保护登记未完成（${stage}），该页面将保留。`,
                false,
                { stage },
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function retainPage(record: ManagedPageRecord, stage: string) {
  record.role = "interactive";
  record.touched = true;
  record.protectionFailure = stage;
}
type PageGuardSnapshot = {
  touched: boolean;
  documentId: string;
  url: string;
  binding: string;
};
const controlledUrl = (value: string) => {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
};
function observeDocument(record: ManagedPageRecord, guard: PageGuardSnapshot) {
  const url = controlledUrl(guard.url);
  if (!url || !guard.documentId) {
    retainPage(record, "document-unknown");
    return;
  }
  if (guard.touched) record.touched = true;
  if (
    record.documentId &&
    (record.documentId !== guard.documentId || record.documentUrl !== url)
  ) {
    if (!record.touched && record.expectedUrl === url)
      record.expectedUrl = undefined;
    else retainPage(record, "document-changed");
  }
  record.documentId = guard.documentId;
  record.documentUrl = url;
}

/** Declare only a navigation this business reader is about to perform. Never
 * restore disposal permission after human input, unknown navigation or failure. */
export function expectTemporaryPageNavigation(page: Page, url: string) {
  const record = pageRecords.get(page);
  if (!record || record.role !== "temporary" || record.touched) return;
  const normalized = controlledUrl(url);
  if (!normalized) {
    retainPage(record, "navigation-target");
    return;
  }
  record.expectedUrl = normalized;
}
export function attachPageLedger(
  context: BrowserContext,
  ledger: BrowserPageLedger,
) {
  ledgers.set(context, ledger);
}
export function pageLedger(context: BrowserContext) {
  let ledger = ledgers.get(context);
  if (!ledger) {
    ledger = new BrowserPageLedger();
    ledgers.set(context, ledger);
  }
  return ledger;
}
export async function pageTarget(
  context: BrowserContext,
  page: Page,
  timeoutMs = lifecycleTimeoutMs,
) {
  const session = await pageLifecycleStep(
    "target-attach",
    () => context.newCDPSession(page),
    timeoutMs,
  );
  try {
    return (
      await pageLifecycleStep(
        "target-read",
        () => session.send("Target.getTargetInfo"),
        timeoutMs,
      )
    ).targetInfo.targetId;
  } finally {
    await pageLifecycleStep(
      "target-detach",
      () => session.detach(),
      timeoutMs,
    ).catch(() => {});
  }
}
function watchHumanInput(bindingName: string) {
  const state = window as unknown as {
    __panxuPageGuard?: PageGuardSnapshot;
  };
  if (state.__panxuPageGuard)
    return { ...state.__panxuPageGuard, url: location.href };
  const guard: PageGuardSnapshot = (state.__panxuPageGuard = {
    touched: false,
    documentId: `${Date.now()}:${Math.random()}`,
    url: location.href,
    binding: bindingName,
  });
  const notify = (kind: "ready" | "touch") => {
    try {
      const send = (
        window as unknown as Record<string, (payload: string) => unknown>
      )[bindingName];
      void Promise.resolve(
        send?.(
          JSON.stringify({
            kind,
            documentId: guard.documentId,
            url: location.href,
          }),
        ),
      ).catch(() => {});
    } catch {
      /* The disconnected reader keeps its local touched guard. */
    }
  };
  for (const event of [
    "pointerdown",
    "click",
    "input",
    "change",
    "keydown",
    "paste",
    "drop",
  ])
    document.addEventListener(
      event,
      (e) => {
        if (e.isTrusted) {
          guard.touched = true;
          notify("touch");
        }
      },
      true,
    );
  notify("ready");
  return guard;
}
export async function recordManagedPage(
  context: BrowserContext,
  page: Page,
  record: ManagedPageRecord,
  options: { timeoutMs?: number } = {},
) {
  // An interactive page is never downgraded to disposable, even if another flow reuses it.
  const ledger = pageLedger(context);
  let next = record;
  let stage = "target";
  pageRecords.set(page, next);
  try {
    const id = await pageTarget(context, page, options.timeoutMs);
    const old = ledger.records.get(id);
    next = old ?? record;
    if (record.role === "interactive") {
      next.role = "interactive";
      if (record.key) next.key = record.key;
    }
    ledger.records.set(id, next);
    pageRecords.set(page, next);
    // Interactive pages are always retained; no input binding is needed. In
    // particular, Playwright's exposeFunction first initializes the whole context.
    if (next.role === "interactive") return;
    const binding = `__panxuProtect_${id.replace(/[^a-z0-9]/gi, "")}`;
    let session: CDPSession | undefined;
    let scriptId: string | undefined;
    let disposed = false;
    const contexts = new Map<number, string>();
    let mainFrameId = "";
    const onContext = (event: {
      context: { id: number; auxData?: { frameId?: string } };
    }) => contexts.set(event.context.id, event.context.auxData?.frameId ?? "");
    const onDestroyed = (event: { executionContextId: number }) =>
      contexts.delete(event.executionContextId);
    const onBinding = (event: {
      name: string;
      payload: string;
      executionContextId: number;
    }) => {
      if (event.name !== binding || event.payload.length > 8192) return;
      try {
        const value = JSON.parse(event.payload);
        if (value.kind === "touch") next.touched = true;
        else if (
          value.kind === "ready" &&
          contexts.get(event.executionContextId) === mainFrameId
        )
          observeDocument(next, { ...value, binding, touched: false });
      } catch {
        retainPage(next, "input-message");
      }
    };
    // Unknown/OOPIF frame input must never be lost by detaching or navigating
    // that frame before cleanup. Retain the page instead of observing the session.
    const onFrame = (frame: Frame) => {
      if (frame !== page.mainFrame()) retainPage(next, "frame-untracked");
    };
    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      page.off("frameattached", onFrame);
      page.off("close", cleanup);
      if (session) {
        session.off("Runtime.executionContextCreated", onContext);
        session.off("Runtime.executionContextDestroyed", onDestroyed);
        session.off("Runtime.bindingCalled", onBinding);
        session.off("close", cleanup);
      }
    };
    try {
      stage = "input-attach";
      session = await pageLifecycleStep(
        stage,
        () => context.newCDPSession(page),
        options.timeoutMs,
      );
      session.on("Runtime.executionContextCreated", onContext);
      session.on("Runtime.executionContextDestroyed", onDestroyed);
      session.on("Runtime.bindingCalled", onBinding);
      session.on("close", cleanup);
      page.on("frameattached", onFrame);
      page.on("close", cleanup);
      if (page.frames().some((frame) => frame !== page.mainFrame()))
        retainPage(next, "frame-untracked");
      stage = "input-page";
      await pageLifecycleStep(
        stage,
        () => session!.send("Page.enable"),
        options.timeoutMs,
      );
      stage = "input-frame";
      mainFrameId = (
        await pageLifecycleStep(
          stage,
          () => session!.send("Page.getFrameTree"),
          options.timeoutMs,
        )
      ).frameTree.frame.id;
      stage = "input-context";
      await pageLifecycleStep(
        stage,
        () => session!.send("Runtime.enable"),
        options.timeoutMs,
      );
      stage = "input-binding";
      await pageLifecycleStep(
        stage,
        () => session!.send("Runtime.addBinding", { name: binding }),
        options.timeoutMs,
      );
      const source = `(() => { const __name = fn => fn; return (${watchHumanInput.toString()})(${JSON.stringify(binding)}); })()`;
      stage = "input-init";
      scriptId = (
        await pageLifecycleStep(
          stage,
          () =>
            session!.send("Page.addScriptToEvaluateOnNewDocument", { source }),
          options.timeoutMs,
        )
      ).identifier;
      stage = "input-observe";
      const observed = await pageLifecycleStep(
        stage,
        () =>
          session!.send("Runtime.evaluate", {
            expression: source,
            returnByValue: true,
          }),
        options.timeoutMs,
      );
      if (
        observed.exceptionDetails ||
        observed.result.value?.binding !== binding
      )
        throw new AppError(
          "BROWSER_PAGE_GUARD_UNKNOWN",
          "未能确认页面输入保护，已保留此页。",
        );
      observeDocument(next, observed.result.value as PageGuardSnapshot);
    } catch (error) {
      cleanup();
      if (session) {
        if (scriptId)
          await pageLifecycleStep(
            "input-remove-script",
            () =>
              session!.send("Page.removeScriptToEvaluateOnNewDocument", {
                identifier: scriptId!,
              }),
            options.timeoutMs,
          ).catch(() => {});
        await pageLifecycleStep(
          "input-remove-binding",
          () => session!.send("Runtime.removeBinding", { name: binding }),
          options.timeoutMs,
        ).catch(() => {});
        await pageLifecycleStep(
          "input-detach",
          () => session!.detach(),
          options.timeoutMs,
        ).catch(() => {});
      }
      throw error;
    }
  } catch (error) {
    // Failure is irreversible for this ledger record. A late resolving binding
    // may only mark it touched; it must never become disposable again.
    retainPage(
      next,
      error instanceof AppError && typeof error.details?.stage === "string"
        ? error.details.stage
        : stage,
    );
    throw error;
  }
}
export async function disposablePage(page: Page, record?: ManagedPageRecord) {
  const state = record ?? pageRecords.get(page);
  if (state?.role !== "temporary" || state.touched || page.isClosed())
    return false;
  // A failed read, cross-origin frame, editor or user interaction retains the page.
  try {
    const guard = await pageLifecycleStep("disposal-document", () =>
      page.evaluate(() => {
        const guard = (
          window as unknown as { __panxuPageGuard?: PageGuardSnapshot }
        ).__panxuPageGuard;
        return guard ? { ...guard, url: location.href } : null;
      }),
    );
    if (!guard) {
      retainPage(state, "disposal-document");
      return false;
    }
    observeDocument(state, guard);
    if (state.role !== "temporary" || state.touched) return false;
    for (const frame of page.frames()) {
      if (
        !(await pageLifecycleStep("disposal-input", () =>
          frame.evaluate(() => {
            const guard = (
              window as unknown as {
                __panxuPageGuard?: { touched: boolean; documentId: string };
              }
            ).__panxuPageGuard;
            if (!guard || guard.touched) return false;
            return ![
              ...document.querySelectorAll(
                "textarea,input,[contenteditable=true]",
              ),
            ].some((el) => {
              if (el instanceof HTMLTextAreaElement) return !!el.value;
              if (el instanceof HTMLInputElement)
                return el.type === "file"
                  ? !!el.files?.length
                  : el.value !== el.defaultValue;
              return !!el.textContent?.trim();
            });
          }),
        ))
      )
        return false;
    }
    return true;
  } catch {
    retainPage(state, "disposal-read");
    return false;
  }
}
export async function createTemporaryPage(
  context: BrowserContext,
  expectedUrl?: string,
) {
  const page = await context.newPage();
  try {
    await recordManagedPage(context, page, {
      key: "",
      role: "temporary",
      ...(expectedUrl
        ? { expectedUrl: controlledUrl(expectedUrl) ?? undefined }
        : {}),
    });
  } catch {
    // Unknown protection means retain, never close. The requested reader can
    // still run; its release path has no permission to dispose this page.
  }
  return page;
}
async function closeDisposablePage(
  page: Page,
  record: ManagedPageRecord,
  timeoutMs?: number,
) {
  if (record.role !== "temporary" || record.touched) return false;
  // Revoke disposal permission before sending the command so concurrent or
  // later cleanup never retries it. A timed-out close cannot be cancelled;
  // its eventual outcome is unknown, rather than proof the tab stayed open.
  retainPage(record, "close-in-flight");
  try {
    await pageLifecycleStep("temporary-close", () => page.close(), timeoutMs);
    return true;
  } catch {
    record.protectionFailure = "close-unknown";
    return false;
  }
}
export async function releaseTemporaryPage(
  page: Page,
  options: { timeoutMs?: number } = {},
) {
  const record = pageRecords.get(page);
  if (!record) return;
  try {
    if (page.context().pages().length > 1 && (await disposablePage(page))) {
      const context = page.context();
      const id = await pageTarget(context, page, options.timeoutMs);
      if (await closeDisposablePage(page, record, options.timeoutMs))
        pageLedger(context).records.delete(id);
    }
  } catch {
    // Failure before a close was sent retains the page and business result.
    retainPage(record, "release-unknown");
  }
}
export async function inspectManagedPages(
  context: BrowserContext,
  clean = false,
  options: { timeoutMs?: number } = {},
) {
  const ledger = pageLedger(context);
  let temporary = 0,
    protectedCount = 0,
    closed = 0;
  for (const page of context.pages()) {
    if (page.isClosed()) continue;
    const id = await pageTarget(context, page, options.timeoutMs);
    const record = ledger.records.get(id);
    if (await disposablePage(page, record)) {
      temporary++;
      if (clean && context.pages().length > 1) {
        const managed = record ?? pageRecords.get(page);
        if (
          managed &&
          (await closeDisposablePage(page, managed, options.timeoutMs))
        ) {
          ledger.records.delete(id);
          closed++;
        } else {
          temporary--;
          protectedCount++;
        }
      }
    } else protectedCount++;
  }
  return { temporary, protected: protectedCount, closed };
}

export async function freezePageLedger(
  context: BrowserContext,
  options: { timeoutMs?: number } = {},
) {
  const ledger = pageLedger(context);
  if (!ledger.records.size) return;
  for (const page of context.pages()) {
    if (page.isClosed()) continue;
    // A reconnect may expose arbitrary existing tabs. Only read pages that this
    // connection actually registered; unknown pages are retained by default.
    const record = pageRecords.get(page);
    if (!record || record.role !== "temporary") continue;
    try {
      const guard = await pageLifecycleStep(
        "freeze-read",
        () =>
          page.evaluate(() => {
            const guard = (
              window as unknown as { __panxuPageGuard?: PageGuardSnapshot }
            ).__panxuPageGuard;
            return guard ? { ...guard, url: location.href } : null;
          }),
        options.timeoutMs,
      );
      if (!guard) {
        retainPage(record, "freeze-read");
        continue;
      }
      observeDocument(record, guard);
    } catch {
      retainPage(record, "freeze-read");
    }
  }
}
