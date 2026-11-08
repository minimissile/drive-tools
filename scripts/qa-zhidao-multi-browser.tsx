/** Renderer-only fixture; the real parent backend is used for one local snapshot read only. */
import { createRoot } from "react-dom/client";
import { AppProvider, useAppData } from "../src/state";
import Answers from "../src/zhidao/Answers";
import type { OperationRun, ZhidaoAccount } from "../shared/zhidao";
import { windowStorage } from "../src/storage/window-storage";
import "../src/styles.css";

const params = new URLSearchParams(location.search);
const runId = params.get("run")!;
if (params.get("frame") !== "1") {
  const frame = document.createElement("iframe");
  frame.title = "多账号答题模拟页面";
  frame.src = `${location.pathname}?frame=1&run=${encodeURIComponent(runId)}`;
  frame.style.cssText = "width:100%;height:100vh;border:0;display:block";
  document.body.style.margin = "0";
  document.getElementById("root")!.replaceWith(frame);
} else {
  const host = window.parent as any;
  if (!host.__zhidaoFixture) {
    const snapshot = await host.panxu.invoke("snapshot");
    host.__zhidaoFixture = {
      snapshot: {
        ...snapshot,
        dataPath: `${snapshot.dataPath}#qa-multi-${runId}`,
        settings: {
          ...snapshot.settings,
          openrouterConfigured: true,
          aiModels: { ...snapshot.settings.aiModels, copy: "fixture/copy" },
        },
      },
      runs: [],
      calls: [],
      accounts: [
        {
          id: "zd_one",
          nickname: "西桥",
          alias: "百度知道 · #1",
          uid: "one",
          status: "connected",
        },
        {
          id: "zd_two",
          nickname: "南山",
          alias: "主账号",
          uid: "two",
          status: "connected",
        },
        {
          id: "zd_expired",
          nickname: "",
          alias: "备用账号",
          uid: "expired",
          status: "expired",
        },
        {
          id: "zd_long",
          nickname: "长昵称用于核对下拉框完整名称和桌面窗口排版",
          alias: "资料整理",
          uid: "long",
          status: "connected",
        },
      ].map((a) => ({
        ...a,
        checkedAt: new Date().toISOString(),
        bulkPermission: false,
        message: "请重新检查登录",
      })),
    };
  }
  const state = host.__zhidaoFixture as {
    snapshot: any;
    runs: OperationRun[];
    calls: any[];
    accounts: ZhidaoAccount[];
  };
  const changed = new Set<() => void>();
  const emit = () => setTimeout(() => changed.forEach((fn) => fn()), 0);
  const invoke = async (method: string, args: any) => {
    if (method === "snapshot") return state.snapshot;
    if (method === "zhidao.accounts") return state.accounts;
    if (method === "zhidao.answer.sessions") return state.runs;
    if (method === "zhidao.runs")
      return { items: state.runs, total: state.runs.length };
    if (method === "zhidao.run")
      return {
        run: state.runs.find((r) => r.id === args.id),
        items: [],
        total: 0,
        page: 1,
        pageSize: 25,
        answerAttention: [],
      };
    if (method === "zhidao.answer.logs")
      return {
        runId: args.id,
        items: [
          {
            id: 1,
            level: "info",
            message: args.id.includes("zd_two")
              ? "南山正在读取题目"
              : "西桥正在读取题目",
            createdAt: new Date().toISOString(),
          },
        ],
        total: 1,
        page: 1,
        pageSize: 100,
      };
    if (method === "zhidao.answer.startMany") {
      state.calls.push(args);
      const runs = args.accountIds.map((id: string, index: number) => ({
        id: `run-${id}`,
        kind: "answer",
        title: `自动回答 · ${state.accounts.find((a) => a.id === id)!.nickname}`,
        config: { ...args, mode: "auto", accountId: id },
        status: "running",
        total: args.count,
        done: index + 1,
        message: "等待提交间隔",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));
      state.runs = runs;
      emit();
      return runs;
    }
    if (method === "zhidao.pause") {
      const r = state.runs.find((r) => r.id === args.id)!;
      r.status = "paused";
      emit();
      return r;
    }
    throw new Error(`本轮界面模拟未授权方法：${method}`);
  };
  Object.assign(window, {
    panxu: {
      windowId: `${runId}-fixture`,
      initialPage: "zhidao-qa",
      invoke,
      onChanged: (fn: () => void) => {
        changed.add(fn);
        return () => changed.delete(fn);
      },
    },
  });
  if (!windowStorage.getItem(`panxu-answers:${state.snapshot.dataPath}`)) {
    windowStorage.setItem(
      `panxu-answers:${state.snapshot.dataPath}`,
      JSON.stringify({
        mode: "auto",
        question: "",
        style: "第一人称共鸣",
        accountId: "zd_one",
        count: 30,
        categories: ["emotion"],
        intervalSeconds: 30,
        instructions: "",
      }),
    );
  }
  Object.assign(window, { __qaState: () => state });
  function Ready() {
    const { data } = useAppData();
    return data ? (
      <main style={{ padding: 24 }}>
        <Answers />
      </main>
    ) : null;
  }
  createRoot(document.getElementById("root")!).render(
    <AppProvider>
      <Ready />
    </AppProvider>,
  );
}
