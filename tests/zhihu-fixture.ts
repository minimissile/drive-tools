import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../core/database";
import { SecretStore } from "../core/secrets";
import { BrowserEnvironments } from "../core/browser-environments";
import { BrowserEnvironmentQueue } from "../core/browser-environment-queue";
import { WebsiteAccounts } from "../core/website-accounts";
import { ZhihuOperations } from "../core/zhihu/service";
import type { AppPorts } from "../core/ports";
import type { ZhihuPayload } from "../shared/zhihu";
export async function zhihuFixture(existing?: { db: Database; dir: string }) {
  const dir = existing?.dir ?? (await mkdtemp(join(tmpdir(), "panxu-zhihu-")));
  const db = existing?.db ?? new Database(join(dir, "panxu.db"));
  const identities = new Map<string, string>();
  let time = Date.now(),
    submissions = 0,
    unknown = false,
    before: (() => Promise<void>) | undefined;
  const ports = {
    browserEnvironments: {
      prepare: async () => {},
      assertIdle: async () => {},
      checkNetwork: async () => "203.0.113.10",
    },
    websiteSessions: {
      isOpen: () => false,
      login: async () => {},
      clear: async () => {},
      invalidate: async () => {},
      status: async (a: { id: string }) => ({
        hasSession: true,
        uid: identities.get(a.id) ?? null,
        windowOpen: false,
        error: null,
      }),
      verify: async (a: { id: string }) => ({
        hasSession: true,
        uid: identities.get(a.id) ?? null,
        windowOpen: false,
        error: null,
      }),
    },
    zhihu: {
      progress: async () => ({
        creator: true,
        level: 2,
        checkedAt: new Date(time).toISOString(),
        source: "official" as const,
        note: "模拟官方页面",
      }),
      publish: async (
        _a: unknown,
        payload: ZhihuPayload,
        checkpoint: () => Promise<void>,
      ) => {
        await before?.();
        await checkpoint();
        submissions++;
        if (unknown) throw Error("模拟发布后断线，请核对结果");
        return {
          url:
            payload.content.kind === "article"
              ? `https://zhuanlan.zhihu.com/p/${10000 + submissions}`
              : `https://www.zhihu.com/question/${payload.task.questionId}/answer/${10000 + submissions}`,
        };
      },
    },
  } as unknown as AppPorts;
  const secrets = new SecretStore(db, {
    available: () => true,
    encrypt: async (v) => v,
    decrypt: async (v) => v,
  });
  const environments = new BrowserEnvironments(
    db,
    secrets,
    ports,
    dir,
    () => {},
  );
  environments.setExternalNetworkChecker(async () => "203.0.113.10");
  const queue = new BrowserEnvironmentQueue(db, environments, () => {});
  const accounts = new WebsiteAccounts(
    db,
    ports,
    () => {},
    environments,
    queue,
  );
  const service = new ZhihuOperations({
    db,
    accounts,
    environments,
    queue,
    ports,
    dataPath: dir,
    changed: () => {},
    clock: () => time,
  });
  const addAccount = async (alias = "知乎测试账号") => {
    const env = await environments.save({
      name: `${alias}比特环境`,
      engine: "bitbrowser",
      profileId: `profile-${identities.size}`,
    });
    const a = accounts.add("zhihu", alias, env.id);
    identities.set(a.id, `identity-${identities.size}`);
    await accounts.verify(a.id);
    await environments.checkNetwork(env.id);
    await service.checkProgress(a.id);
    return accounts.get(a.id);
  };
  const content = (override: Record<string, unknown> = {}) => {
    const c = service.saveContent({
      kind: "article",
      purpose: "warming",
      title: "独立创作的生活随笔",
      body: "把今天观察到的生活细节认真记录下来，留给未来的自己。",
      aiAssisted: false,
      ...override,
    });
    return service.review(c.id, c.version);
  };
  return {
    dir,
    db,
    ports,
    environments,
    queue,
    accounts,
    service,
    identities,
    addAccount,
    content,
    get time() {
      return time;
    },
    advance: (ms: number) => {
      time += ms;
    },
    get submissions() {
      return submissions;
    },
    setUnknown: (v: boolean) => {
      unknown = v;
    },
    before: (v: () => Promise<void>) => {
      before = v;
    },
    close: async () => {
      service.close();
      queue.close();
      if (!existing) {
        db.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
