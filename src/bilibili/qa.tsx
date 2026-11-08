/** Dedicated child-frame transport. Does not reach business IPC or website sessions. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { BilibiliDraft, BilibiliPreview } from "../../shared/bilibili";
import { bilibiliDraftInput, bilibiliEditorUrl } from "../../shared/bilibili";
import type { Resource } from "../../shared/types";
import type { WebsiteAccountView } from "../../shared/website-accounts";
import type { VideoJob } from "../../shared/video-jobs";
import { BilibiliEditor } from "./editor";
import { windowStorage } from "../storage/window-storage";
import "../styles.css";
import "./workspace.css";

const params = new URLSearchParams(location.search),
  run = params.get("run") || "manual";
if (params.get("frame") !== "1") {
  const frame = document.createElement("iframe");
  frame.title = "B站稿件内存模拟页面";
  frame.src = `${location.pathname}?frame=1&run=${encodeURIComponent(run)}`;
  frame.style.cssText = "border:0;width:100%;height:100vh;display:block";
  document.body.style.margin = "0";
  document.getElementById("root")!.replaceWith(frame);
} else {
  const listeners = new Set<() => void>();
  const drafts = new Map<string, BilibiliDraft>();
  const events: string[] = [];
  let waitPrepare = false,
    release: (() => void) | undefined,
    failSave = false;
  const account: WebsiteAccountView = {
    id: "web_bili_fixture",
    provider: "bilibili",
    alias: "B站账号",
    nickname: "内存模拟账号",
    uid: "12345678",
    status: "connected",
    createdAt: "2026-11-08T00:00:00Z",
    updatedAt: "2026-11-08T00:00:00Z",
    windowOpen: false,
    message: "专用内存模拟账号，不代表真实登录",
  };
  const resource = {
    id: "resource-bili-qa",
    title: "性格测试MBTI九型人格DISC霍兰德职业生涯规划测评教程素材集自测",
    copies: [{ id: "copy-bili-qa" }],
  } as Resource;
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 360;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#f6f8fc";
  context.fillRect(0, 0, 640, 360);
  context.fillStyle = "#1d2b42";
  context.font = "bold 30px sans-serif";
  context.fillText("测评资料目录 · 内存模拟封面", 36, 90);
  const coverUrl = canvas.toDataURL("image/png");
  const video: VideoJob = {
    id: "video_bili_fixture",
    sourceId: "copy-bili-qa",
    status: "completed",
    progress: 1,
    project: {
      template: "directory-scroll",
      title: "测评资料目录",
      subtitle: "",
      entries: [{ name: "MBTI资料", kind: "folder" }],
      aspectRatio: "16:9",
      durationSeconds: 12,
      slideCount: 0,
      hasAudio: false,
    },
    createdAt: "2026-11-08T00:00:00Z",
    updatedAt: "2026-11-08T00:00:00Z",
    videoUrl: "/test-results/local-video/service-1080-video.mp4",
    coverUrl,
  };
  const invoke = async (method: string, args: any) => {
    events.push(method);
    if (method === "video.jobs") return [video];
    if (method === "bilibili.save") {
      if (failSave) {
        failSave = false;
        throw new Error("稿件已在其它窗口更新，当前文字保留。");
      }
      const input = bilibiliDraftInput.parse(args),
        old = input.id ? drafts.get(input.id) : undefined;
      const draft: BilibiliDraft = {
        ...input,
        id: input.id || "bili_fixture",
        revision: (old?.revision ?? 0) + 1,
        stage: "draft",
        createdAt: old?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        message: "已保存本地稿件",
      };
      drafts.set(draft.id, draft);
      return draft;
    }
    const draft = drafts.get(args?.id);
    if (method === "bilibili.preview" && draft)
      return {
        draft,
        accountLabel: account.nickname!,
        editorUrl: bilibiliEditorUrl(draft.kind),
        video: null,
        imageUrl: draft.videoJobId === video.id ? coverUrl : null,
        issues: draft.text
          ? []
          : [{ level: "error", message: "请填写正文或简介。" }],
      } satisfies BilibiliPreview;
    if (method === "bilibili.prepare" && draft) {
      if (waitPrepare) {
        waitPrepare = false;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      const next: BilibiliDraft = {
        ...draft,
        stage: "attention",
        message: "已部分填写",
        preparation: {
          status: "partial",
          editorUrl: bilibiliEditorUrl(draft.kind),
          filledFields: ["标题", "正文"],
          mediaSelected: false,
          imageSelected: false,
          message: "标题和正文已填入；分类、封面与标签需要在官网核对。",
          preparedAt: new Date().toISOString(),
        },
      };
      drafts.set(next.id, next);
      return next;
    }
    if (method === "bilibili.recordReceipt" && draft) {
      const next: BilibiliDraft = {
        ...draft,
        receipt: {
          url: args.url,
          status: "unverified",
          recordedAt: new Date().toISOString(),
        },
      };
      drafts.set(next.id, next);
      return next;
    }
    if (method === "bilibili.export") return "/memory-only/article.txt";
    throw new Error(`内存模拟不允许业务请求：${method}`);
  };
  window.panxu = {
    windowId: `bilibili-qa:${run}`,
    invoke: async <T,>(method: string, args?: unknown) =>
      (await invoke(method, args)) as T,
    onChanged: (callback) => {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
    onDevSessionsChanged: () => () => {},
    onUpdateChanged: () => () => {},
  };
  let switchAccount = () => {},
    remount = () => {};
  Object.assign(window, {
    __bilibiliQa: {
      events: () => [...events],
      latestSaved: () => [...drafts.values()].at(-1),
      failSave: () => {
        failSave = true;
      },
      waitPrepare: () => {
        waitPrepare = true;
      },
      release: () => release?.(),
      switchAccount: () => switchAccount(),
      remount: () => remount(),
      cleanup: () => windowStorage.clear(),
    },
  });
  function Harness() {
    const [accountId, setAccountId] = useState(account.id),
      [saved, setSaved] = useState<BilibiliDraft | null>(null),
      [preview, setPreview] = useState<BilibiliPreview | null>(null),
      [generation, setGeneration] = useState(0);
    switchAccount = () => {
      setAccountId("web_bili_other");
      setSaved(null);
      setPreview(null);
    };
    remount = () => setGeneration((value) => value + 1);
    return (
      <main style={{ maxWidth: 1080, margin: "24px auto", padding: "0 24px" }}>
        <h1 style={{ fontSize: 20 }}>B站稿件编辑</h1>
        <p style={{ color: "var(--muted)", fontSize: 12 }}>
          专用内存模拟 · 不操作真实账号，不上传或发布
        </p>
        <section className="panel bilibili-editor-region">
          <BilibiliEditor
            key={`${accountId}:${generation}`}
            scope={`fixture:${run}`}
            account={{ ...account, id: accountId }}
            accountId={accountId}
            copyId="copy-bili-qa"
            resource={resource}
            currentCopyId="copy-bili-qa"
            saved={saved}
            seed={null}
            initialPreview={preview}
            editorKey="fixture"
            showVideoMaker={false}
            onAssociate={() => {}}
            onSaved={(next, checked) => {
              setSaved(next);
              if (checked) setPreview(checked);
            }}
          />
        </section>
      </main>
    );
  }
  createRoot(document.getElementById("root")!).render(<Harness />);
}
