import { mkdtemp, rm } from "node:fs/promises";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AppService, type AppPorts } from "../core/service";
import type { Account, RemoteFile, ShareInput } from "../shared/types";
import type { DriveProvider, OwnShare } from "../core/providers/provider";
import type { SecretCodec } from "../core/secrets";
export const file: RemoteFile = {
  id: "source-file",
  name: "自主练习清单.pdf",
  parentId: "0",
  isDirectory: false,
  size: 120,
};
export const removeV5 =
  "DROP TABLE split_run_items; DROP TABLE split_items; DROP TABLE split_runs; DROP TABLE transfer_batch_items; DROP TABLE transfer_batches; DROP INDEX jobs_kind_target; ALTER TABLE jobs DROP COLUMN kind; ALTER TABLE jobs DROP COLUMN target_id; ALTER TABLE jobs DROP COLUMN batch_id;";
export class TestProvider implements DriveProvider {
  readonly id = "quark" as const;
  uid = "owner-1";
  transfers = 0;
  shares = 0;
  actual: RemoteFile[] = [];
  failTransfer = false;
  failShare = false;
  ownUrl = "https://pan.quark.cn/s/own123";
  ownValid = true;
  async identity(_a: Account) {
    return { uid: this.uid, nickname: "测试账号" };
  }
  async inspect(_a: Account, source: ShareInput, parentId = "0", page = 1) {
    return {
      shareKey: source.shareKey,
      title: "自主练习",
      files: [file],
      parentId,
      page,
      hasMore: false,
    };
  }
  async list() {
    return this.actual;
  }
  async ensureFolder() {
    return "target-folder";
  }
  async transfer() {
    this.transfers++;
    this.actual = [{ ...file, id: "own-file", parentId: "target-folder" }];
    if (this.failTransfer) throw new Error("连接中断");
    return { taskId: "task-1" };
  }
  async poll() {
    return true;
  }
  async createShare(): Promise<OwnShare> {
    this.shares++;
    if (this.failShare) throw new Error("分享响应中断");
    return {
      id: "own-share",
      url: this.ownUrl,
      code: "test",
      ownerUid: this.uid,
    };
  }
  async findOwnShare() {
    return this.shares
      ? { id: "own-share", url: this.ownUrl, code: "test", ownerUid: this.uid }
      : null;
  }
  async verifyShare() {
    return this.ownValid;
  }
  async recoverOwnShare() {
    return {
      id: "own-share",
      url: this.ownUrl,
      code: "test",
      ownerUid: this.uid,
    };
  }
}
export async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "panxu-test-")),
    provider = new TestProvider(),
    key = randomBytes(32);
  const codec: SecretCodec = {
    available: () => true,
    async encrypt(text) {
      const iv = randomBytes(12),
        c = createCipheriv("aes-256-gcm", key, iv);
      return (() => {
        const encrypted = Buffer.concat([c.update(text), c.final()]);
        return Buffer.concat([iv, c.getAuthTag(), encrypted]).toString(
          "base64",
        );
      })();
    },
    async decrypt(value) {
      const b = Buffer.from(value, "base64"),
        c = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
      c.setAuthTag(b.subarray(12, 28));
      return Buffer.concat([c.update(b.subarray(28)), c.final()]).toString();
    },
  };
  const ports: AppPorts = {
    login: async () => {},
    clearSession: async () => {},
    closeAccountWindow: async () => {},
    chooseDirectory: async () => null,
    readText: async () => null,
    activateDataPath: async () => {},
    normalizeCover: async (b) => b,
    openPath: async () => {},
    openAccountPage: async () => {},
    openExternal: async () => {},
    copyText: async () => {},
    saveFile: async () => null,
  };
  const app = new AppService(
    dir,
    codec,
    { quark: provider, baidu: provider },
    ports,
    () => {},
  );
  // The real queue is exercised explicitly in tests, avoiding background races.
  app.queue.pump = async () => {};
  const account = (await app.invoke("account.add", {
    provider: "quark",
    alias: "夸克本人",
  })) as Account;
  await app.invoke("account.check", { id: account.id });
  const add = async (enqueue = true, override: Record<string, unknown> = {}) =>
    app.invoke("resource.save", {
      title: "AI办公练习清单",
      sourceText: "https://pan.quark.cn/s/source123",
      category: "效率办公",
      tags: ["AI"],
      summary: "独立制作的办公练习材料",
      accountId: account.id,
      directory: "/盘序资源",
      rightsConfirmed: true,
      selectedFiles: [file],
      enqueue,
      ...override,
    }) as Promise<{ resourceId: string; copyId: string; jobId: string }>;
  return {
    app,
    dir,
    provider,
    account,
    add,
    ports,
    codec,
    async cleanup() {
      app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
