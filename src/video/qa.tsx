/** Dedicated UI fixture: the child frame's transport is in memory only. */
import { createRoot, type Root } from "react-dom/client";
import { videoProjectSchema } from "../../shared/video";
import type { VideoJob, VideoSource } from "../../shared/video-jobs";
import type { MusicLibraryState } from "../../shared/music";
import { writeAttachment } from "../storage/draft-attachments";
import { windowStorage } from "../storage/window-storage";
import { LocalVideoMaker } from "./LocalVideoPanel";
import "../styles.css";

const params = new URLSearchParams(location.search);
const run = params.get("run") || "manual";
if (window.parent === window && params.get("frame") !== "1") {
  const frame = document.createElement("iframe");
  frame.title = "本地视频制作内存模拟页面";
  frame.src = `${location.pathname}?frame=1&run=${encodeURIComponent(run)}`;
  frame.style.cssText = "border:0;width:100%;height:100vh;display:block";
  document.body.style.margin = "0";
  document.getElementById("root")!.replaceWith(frame);
} else {
  const changed = new Set<() => void>();
  const jobs: VideoJob[] = [];
  const events: string[] = [];
  let failNext = false;
  let readError = false;
  let available = true;
  let currentSourceId = "fixture";
  let musicFailAudio = false;
  let musicWaitAudio = false;
  let releaseMusicAudio: (() => void) | undefined;
  let musicRequests = 0;
  const music: MusicLibraryState = {
    configured: true,
    enabled: false,
    intervalDays: 7,
    updatedAt: null,
    lastAttemptAt: null,
    nextUpdateAt: null,
    updating: false,
    error: null,
    tracks: [],
  };
  const musicTracks = () => [
    {
      id: "7136850194742315016",
      title: "轻快钢琴与午后微风",
      author: "内存模拟配乐",
      rank: 1,
      audioCached: false,
    },
    {
      id: "7136850194742315017",
      title: "适合目录展示的轻音乐（长标题与作者名称排版示例）",
      author: "内存模拟配乐",
      rank: 2,
      audioCached: false,
    },
  ];
  const canvas = document.createElement("canvas");
  canvas.width = 540;
  canvas.height = 720;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#f6f8fc";
  context.fillRect(0, 0, 540, 720);
  context.fillStyle = "#2e61d5";
  context.fillRect(40, 55, 58, 7);
  context.fillStyle = "#1d2b42";
  context.font = "bold 32px sans-serif";
  context.fillText("英语课堂练习", 40, 140);
  context.font = "22px sans-serif";
  context.fillText("本地视频界面验收素材", 40, 195);
  context.fillText("阅读 · 口语 · 课堂活动", 40, 250);
  const image = canvas.toDataURL("image/png");
  const source: VideoSource = {
    title: "小学英语课堂练习资料",
    subtitle: "按课堂场景整理的阅读、口语与练习材料，先核对内容再使用。",
    entries: Array.from({ length: 12 }, (_, index) => ({
      name:
        index === 4
          ? "六年级英语课堂阅读理解与口语实践活动配套资料（含活动说明和课后练习示例）.pdf"
          : `第${index + 1}单元 · 英语课堂练习材料`,
      kind: index === 4 ? "file" : "folder",
    })),
    slides: [],
  };
  const emit = () => changed.forEach((callback) => callback());
  const invoke = async (method: string, args?: unknown): Promise<unknown> => {
    if (method === "music.library") return structuredClone(music);
    if (method === "music.configure") {
      music.enabled = (args as { enabled: boolean }).enabled;
      if (music.enabled && !music.updatedAt) {
        musicRequests++;
        music.updatedAt = music.lastAttemptAt = new Date().toISOString();
        music.nextUpdateAt = new Date(Date.now() + 7 * 86400000).toISOString();
        music.tracks = musicTracks();
      }
      events.push(`music:configure:${music.enabled}`);
      emit();
      return structuredClone(music);
    }
    if (method === "music.update") {
      events.push("music:update");
      if ((args as { retry?: boolean }).retry && music.error) {
        musicRequests++;
        music.error = null;
      }
      emit();
      return structuredClone(music);
    }
    if (method === "music.audio") {
      const { id } = args as { id: string; retry?: boolean };
      const track = music.tracks.find((item) => item.id === id)!;
      events.push(`music:audio:${id}:${!!(args as { retry?: boolean }).retry}`);
      if (!track.audioCached) musicRequests++;
      if (musicFailAudio) {
        musicFailAudio = false;
        throw new Error("模拟配乐下载未完成，请手动重试。");
      }
      if (musicWaitAudio) {
        musicWaitAudio = false;
        await new Promise<void>((resolve) => {
          releaseMusicAudio = resolve;
        });
      }
      track.audioCached = true;
      emit();
      return {
        name: `${track.title}.wav`,
        src: "data:audio/wav;base64,UklGRg==",
      };
    }
    if (method === "video.runtime")
      return {
        available,
        browserExecutable: available ? "/fixture/chrome" : null,
        message: available
          ? "本地环境可用"
          : "未找到本地浏览器，请准备浏览器后重新检查。",
      };
    if (method === "video.jobs") {
      if (readError) throw new Error("模拟任务记录读取失败，已有成片仍保留。");
      return structuredClone(jobs);
    }
    if (method === "video.create") {
      const input = args as { sourceId: string; project: unknown };
      const { slides, audio, ...project } = videoProjectSchema.parse(
        input.project,
      );
      const time = new Date().toISOString();
      const job: VideoJob = {
        id: `video-fixture-${jobs.length + 1}`,
        sourceId: input.sourceId,
        project: { ...project, slideCount: slides.length, hasAudio: !!audio },
        status: failNext ? "failed" : "rendering",
        progress: failNext ? 0 : 0.36,
        createdAt: time,
        updatedAt: time,
        ...(failNext ? { error: "模拟渲染失败，素材与设置已保留。" } : {}),
      };
      failNext = false;
      jobs.unshift(job);
      events.push("create");
      emit();
      return structuredClone(job);
    }
    if (method === "video.cancel") {
      const job = jobs.find((item) => item.id === (args as { id: string }).id)!;
      job.status = "cancelled";
      events.push("cancel");
      emit();
      return structuredClone(job);
    }
    if (method === "video.export") {
      events.push(`export:${(args as { kind: string }).kind}`);
      return "/fixture/exported-video";
    }
    if (method === "video.importImages")
      return [{ src: image, caption: "第一单元 · 阅读与练习" }];
    if (method === "video.importAudio")
      return { src: "data:audio/wav;base64,UklGRg==", name: "本地配乐.wav" };
    throw new Error(`界面模拟不允许此操作：${method}`);
  };
  window.panxu = {
    windowId: `local-video-qa:${run}`,
    invoke: async <T,>(method: string, args?: unknown) =>
      (await invoke(method, args)) as T,
    onChanged: (callback) => {
      changed.add(callback);
      return () => {
        changed.delete(callback);
      };
    },
    onUpdateChanged: () => () => {},
  };
  Object.assign(window, {
    __localVideoQa: {
      events,
      failNext() {
        failNext = true;
      },
      failRead(next: boolean) {
        readError = next;
        emit();
      },
      runtime(next: boolean) {
        available = next;
        emit();
      },
      musicRequests: () => musicRequests,
      musicError() {
        music.error = "模拟本周音乐榜更新失败，上次榜单仍可使用。";
        emit();
      },
      failMusicAudio() {
        musicFailAudio = true;
      },
      waitMusicAudio() {
        musicWaitAudio = true;
      },
      releaseMusicAudio() {
        releaseMusicAudio?.();
      },
      switchSource() {
        currentSourceId = "fixture-next";
        render();
      },
      complete(assets?: { videoUrl?: string; coverUrl?: string }) {
        const job = jobs[0];
        job.status = "completed";
        job.progress = 1;
        job.coverUrl =
          assets?.coverUrl ??
          "/test-results/local-video/service-1080-cover.png";
        job.videoUrl =
          assets?.videoUrl ??
          "/test-results/local-video/service-1080-video.mp4";
        emit();
      },
      async cleanup() {
        for (const sourceId of ["fixture", "fixture-next"]) {
          const key = `panxu-local-video-v1:memory:local-video-qa:${run}:${sourceId}`;
          windowStorage.removeItem(key);
          windowStorage.removeItem(`${key}:selection`);
          await writeAttachment(`${key}:assets`, undefined);
        }
      },
    },
  });
  const container = document.getElementById("root")! as HTMLElement & {
    __localVideoRoot?: Root;
    __localVideoRevision?: number;
  };
  const root = (container.__localVideoRoot ??= createRoot(container));
  const revision = import.meta.hot
    ? (container.__localVideoRevision =
        (container.__localVideoRevision ?? 0) + 1)
    : 0;
  const render = () =>
    root.render(
      <main style={{ maxWidth: 1100, margin: "0 auto", padding: 24 }}>
        <header className="page-heading">
          <div>
            <h1>本地视频制作</h1>
            <p>专用内存模拟 · 仅验收当前源码界面，不调用业务后端或付费接口</p>
          </div>
        </header>
        <section className="panel">
          <LocalVideoMaker
            key={revision}
            sourceId={currentSourceId}
            draftScope={`memory:local-video-qa:${run}`}
            source={source}
            onFeedback={(message) => {
              document.getElementById("video-qa-feedback")!.textContent =
                message;
            }}
          />
        </section>
        <output id="video-qa-feedback" aria-live="polite" />
      </main>,
    );
  render();
}
