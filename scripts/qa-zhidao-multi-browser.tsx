/** Renderer-only fixture; the real parent backend is used for one local snapshot read only. */
import { createRoot } from "react-dom/client";
import { AppProvider, useAppData } from "../src/state";
import Answers from "../src/zhidao/Answers";
import type { OperationRun, ZhidaoAccount } from "../shared/zhidao";
import { windowStorage } from "../src/storage/window-storage";
import { answerLanguageSample } from "../src/zhidao/answer-language-samples";
import { zhidaoAnswerLanguage } from "../shared/zhidao-answer-language";
import {
  isTodayAnswerRun,
  answerProgressDay,
} from "../shared/zhidao-answer-progress";
import "../src/styles.css";

const params = new URLSearchParams(location.search);
const runId = params.get("run")!;
if (params.get("frame") !== "1") {
  const frame = document.createElement("iframe");
  frame.title = "多账号答题模拟页面";
  const frameUrl = new URL(location.href);
  frameUrl.searchParams.set("frame", "1");
  frame.src = frameUrl.href;
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
      answers: {},
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
    answers: Record<string, string>;
    accounts: ZhidaoAccount[];
  };
  const changed = new Set<() => void>();
  const emit = () => setTimeout(() => changed.forEach((fn) => fn()), 0);
  const invoke = async (method: string, args: any) => {
    if (method === "snapshot") return state.snapshot;
    if (method === "zhidao.accounts") return state.accounts;
    if (method === "zhidao.answer.sessions")
      return state.runs.filter(
        (run) =>
          run.config.mode === "auto" &&
          (run.status === "running" || isTodayAnswerRun(run)),
      );
    if (method === "zhidao.runs") {
      const items = state.runs.filter(
        (run) => args.kind !== "answer" || isTodayAnswerRun(run),
      );
      const page = Math.min(
        args.page ?? 1,
        Math.max(1, Math.ceil(items.length / 20)),
      );
      return {
        items: items.slice((page - 1) * 20, page * 20),
        total: items.length,
      };
    }
    if (method === "zhidao.run")
      return {
        run: state.runs.find((r) => r.id === args.id),
        items: state.answers[args.id]
          ? [
              {
                id: `item-${args.id}`,
                question: state.runs.find((r) => r.id === args.id)!.config
                  .question,
                answer: state.answers[args.id],
                status: "ready",
              },
            ]
          : [],
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
    if (
      method === "zhidao.start" &&
      args.kind === "answer" &&
      args.input.mode === "manual"
    ) {
      state.calls.push(args);
      const run: OperationRun = {
        id: `manual-${state.calls.length}`,
        kind: "answer",
        title: "手动回答",
        config: args.input,
        status: "completed",
        total: 1,
        done: 1,
        message: "已生成回答",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      state.answers[run.id] = answerLanguageSample(
        zhidaoAnswerLanguage.parse(args.input.language ?? "mandarin"),
        "第一人称共鸣",
      );
      state.runs.push(run);
      emit();
      return run;
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
  if (params.get("progress") === "1" && !state.runs.length) {
    const today = answerProgressDay().start;
    const yesterday = new Date(Date.parse(today) - 1).toISOString();
    const config = {
      mode: "manual",
      question: "如何沟通自己的感受？",
      style: "清晰实用",
      language: "mandarin",
    };
    state.runs = [
      { id: "today-manual", title: "今日回答", createdAt: today },
      { id: "yesterday-manual", title: "昨日回答", createdAt: yesterday },
    ].map((run) => ({
      ...run,
      kind: "answer",
      config,
      status: "completed",
      total: 1,
      done: 1,
      message: "回答已完成",
      updatedAt: run.createdAt,
    }));
    state.answers["today-manual"] = "先梳理感受，再选择平静的时候沟通。";
    state.answers["yesterday-manual"] =
      "昨日生成的回答不应重新显示在今日进度中。";
    windowStorage.setItem(
      `panxu-operation-focus:${state.snapshot.dataPath}:answer`,
      JSON.stringify({ id: "yesterday-manual" }),
    );
  }
  Object.assign(window, {
    __qaSetRuns: (runs: OperationRun[]) => {
      state.runs = runs;
      emit();
    },
  });
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
