import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppService } from "../core/service";
import { readXlsx } from "../core/table-files";
import { TestProvider } from "./helpers";
import type { IpcArgs, IpcMethod, IpcValue } from "../shared/ipc";

/** No real network, model generation, transfer or publication is allowed. */
export async function publishingFixture() {
  const dir = await mkdtemp(join(tmpdir(), "panxu-publish-data-"));
  const events: {
    type: string;
    accountId?: string;
    path?: string;
    taskName?: string;
    rows?: string[][];
    page?: number;
  }[] = [];
  const state = {
    rights: {
      hasPermission: "1" as boolean | string,
      isBanned: 0,
      quota: 5000,
      usedQuota: 0,
    },
    mode: "success" as "success" | "unknown" | "missing-id" | "reject",
    identity: "qa-publisher",
    envelope: 0,
    failTasks: false,
    taskStatus: 0,
    successCount: 0,
    failCount: 0,
    uploadGate: null as Promise<void> | null,
  };
  const accepted: { id: string; taskName: string; count: number }[] = [];
  const provider = new TestProvider();
  const service = new AppService(
    dir,
    {
      available: () => true,
      encrypt: async (v) => Buffer.from(v).toString("base64"),
      decrypt: async (v) => Buffer.from(v, "base64").toString(),
    },
    Object.fromEntries(
      ["quark", "baidu", "uc", "xunlei", "guangya", "pikpak"].map((key) => [
        key,
        provider,
      ]),
    ) as any,
    {
      login: async () => {},
      clearSession: async () => {},
      closeAccountWindow: async () => {},
      chooseDirectory: async () => null,
      readText: async () => null,
      activateDataPath: async () => {},
      normalizeCover: async (bytes) => bytes,
      openPath: async () => {},
      openAccountPage: async () => {},
      copyText: async () => {},
      openExternal: async () => {
        throw Error("隔离测试禁止打开外部浏览器");
      },
      saveFile: async () => null,
      zhidaoSession: {
        login: async (accountId, page) => {
          events.push({ type: "open", accountId, path: page });
        },
        clear: async () => {},
        close: async () => {},
        setCookie: async () => {},
        request: async (accountId, raw, init = {}) => {
          const url = new URL(raw);
          assert.equal(url.origin, "https://zhidao.baidu.com");
          events.push({ type: "request", accountId, path: url.pathname });
          let value: unknown;
          if (url.pathname === "/api/logininfo")
            value = {
              isLogin: 1,
              uid: state.identity,
              userName: "发布模拟答主",
              stoken: "fixture-only",
            };
          else if (url.pathname === "/qa/api/bulkqa/userinfo")
            value = {
              code: state.envelope,
              data: { uid: state.identity, ...state.rights },
            };
          else if (url.pathname === "/qa/api/bulkqa/upload") {
            assert.equal(init.method, "POST");
            const form = init.body as FormData;
            const file = form.get("file") as File;
            const taskName = String(form.get("taskName"));
            assert.ok(taskName.trim().length > 0 && taskName.length <= 15);
            assert.ok(file.name.endsWith(".xlsx"));
            const rows = readXlsx(Buffer.from(await file.arrayBuffer()));
            assert.deepEqual(rows[0], ["qid", "问题标题", "回答内容"]);
            assert.ok(rows.length > 1);
            events.push({ type: "upload", accountId, taskName, rows });
            if (state.uploadGate) await state.uploadGate;
            if (state.mode === "reject")
              value = { code: 403, msg: "模拟：今日额度不足" };
            else {
              const task = {
                id: String(10000000000000000000n + BigInt(accepted.length)),
                taskName,
                count: rows.length - 1,
              };
              accepted.push(task);
              state.rights.usedQuota += task.count;
              if (state.mode === "unknown") throw Error("模拟上传后响应丢失");
              value = {
                code: state.envelope,
                data: state.mode === "missing-id" ? {} : { id: task.id },
              };
            }
          } else if (url.pathname === "/qa/api/bulkqa/tasks") {
            if (state.failTasks) throw Error("模拟平台审核记录读取失败");
            const page = Number(url.searchParams.get("page"));
            events.push({ type: "tasks", page });
            value = {
              code: state.envelope,
              data: {
                list:
                  page === 1
                    ? accepted.map((task) => ({
                        id: task.id,
                        taskName: task.taskName,
                        status: state.taskStatus,
                        usedTotal: task.count,
                        successCount: state.successCount,
                        failCount: state.failCount,
                      }))
                    : [],
                total: accepted.length,
              },
            };
          } else throw Error(`隔离测试禁止未声明请求：${url.pathname}`);
          return { status: 200, body: JSON.stringify(value) };
        },
      },
    },
    () => {},
  );
  service.queue.pump = async () => {};
  service.ai.resourceExport = async () => {
    throw Error("发布测试禁止调用AI");
  };
  const invoke = <M extends IpcMethod>(method: M, args: IpcArgs<M>) =>
    service.invoke(method, args) as Promise<IpcValue<M>>;
  const account = await invoke("zhidao.account.add", {
    alias: "发布流程验收（本机模拟）",
  });
  await service.invoke("zhidao.account.check", { id: account.id });
  let sequence = 0;
  function seed(count = 1, reviewed = true) {
    const run = service.zhidao.store.create(
      "answer",
      "本机模拟问答",
      { mode: "manual" },
      count,
    );
    const items = Array.from({ length: count }, () => {
      const index = ++sequence;
      return service.zhidao.store.put(run.id, String(index), {
        name: `资料整理 ${index}`,
        question: `如何整理第${index}份学习资料？`,
        answer: `<p>我的建议是先按主题建立目录，再检查第${index}份资料的版本与完整性。</p>`,
        reviewed,
        status: "ready",
      });
    });
    service.zhidao.store.state(run.id, "completed", "隔离样例", count);
    return items;
  }
  return {
    invoke,
    service,
    dir,
    account,
    events,
    state,
    accepted,
    seed,
    async cleanup() {
      service.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
