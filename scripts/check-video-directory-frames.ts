/** Real frame regression. Uses its own headless Chrome, never the shared app. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bundle } from "@remotion/bundler";
import {
  openBrowser,
  renderStill,
  selectComposition,
} from "@remotion/renderer";
import {
  getLocalVideoRuntime,
  localVideoBinariesDirectory,
} from "../core/video-renderer/runtime";
import { videoProjectSchema, type VideoProject } from "../shared/video";

interface FrameMetrics {
  frame: number;
  root: { width: number; height: number };
  viewport: {
    x: number;
    y: number;
    width: number;
    height: number;
    bottom: number;
  };
  title: {
    x: number;
    y: number;
    width: number;
    height: number;
    bottom: number;
    right: number;
  };
  titleLines: number[];
  visible: { index: number; height: number; visibleHeight: number }[];
}
const root = resolve(import.meta.dirname, "..");
const working = await mkdtemp(join(tmpdir(), "panxu-directory-frame-work-"));
const evidence = await mkdtemp(join(tmpdir(), "panxu-directory-frames-"));
const runtime = await getLocalVideoRuntime();
assert.ok(runtime.available && runtime.browserExecutable, runtime.message);
const source = process.argv[2]
  ? JSON.parse(await readFile(resolve(process.argv[2]), "utf8"))
  : {
      resource: "性格测试MBTI九型人格DISC霍兰德职业生涯规划测评教程素材集自测",
      sourceEntries: Array.from({ length: 25 }, (_, index) => ({
        name: `测评资料分类/第${index + 1}项：性格与职业规划资料及说明文档.pdf`,
        kind: "file",
      })),
    };
const project = videoProjectSchema.parse({
  title: source.project?.title ?? source.resource,
  entries: source.project?.entries ?? source.sourceEntries,
  template: "directory-scroll",
  subtitle: "",
  durationSeconds: 12,
  aspectRatio: "16:9",
});
assert.ok(project.entries.length > 6, "请提供足够条目，以实际验证目录滚动。");

// Probe belongs to this temporary test bundle, not the production composition.
// Waiting two animation frames allows the production layout observer to settle.
const entry = join(working, "index.tsx");
await writeFile(
  entry,
  `
import React, {useLayoutEffect} from 'react';
import {Composition,registerRoot,useCurrentFrame,delayRender,continueRender} from 'remotion';
import {VideoComposition} from ${JSON.stringify(join(root, "video-templates/VideoComposition"))};
const fallback=${JSON.stringify(project)};
function Probe(){
 const frame=useCurrentFrame();
 useLayoutEffect(()=>{
  let active=true, released=false, animation=0;
  const handle=delayRender('检查目录可见条目');
  const release=()=>{if(!released){released=true;continueRender(handle);}};
  document.fonts.ready.then(()=>{
   if(!active)return;
   animation=requestAnimationFrame(()=>{animation=requestAnimationFrame(()=>{
    if(!active)return;
    const root=document.querySelector('[data-video-frame]');
    const viewport=document.querySelector('[data-video-directory-viewport]');
    const title=document.querySelector('[data-video-title]');
    const v=viewport.getBoundingClientRect();
    const textRange=document.createRange();textRange.selectNodeContents(title);
    const visible=Array.from(document.querySelectorAll('[data-video-entry]')).map(node=>{
     const r=node.getBoundingClientRect();
     return {index:Number(node.dataset.videoEntry),height:r.height,visibleHeight:Math.max(0,Math.min(r.bottom,v.bottom)-Math.max(r.top,v.top))};
    }).filter(item=>item.visibleHeight>20);
    console.log('DIRECTORY_FRAME_METRICS '+JSON.stringify({frame,root:root.getBoundingClientRect().toJSON(),viewport:v.toJSON(),title:title.getBoundingClientRect().toJSON(),titleLines:Array.from(textRange.getClientRects()).filter(r=>r.width>0).map(r=>r.width),visible}));
    release();
   });});
  });
  return()=>{active=false;cancelAnimationFrame(animation);release();};
 },[frame]);
 return null;
}
function Frame({project}){return <><VideoComposition project={project}/><Probe/></>}
registerRoot(()=> <Composition id="DirectoryRegression" component={Frame} fps={30} width={1920} height={1080} durationInFrames={360} defaultProps={{project:fallback}} calculateMetadata={({props})=>({width:props.project.aspectRatio==='9:16'?1080:1920,height:props.project.aspectRatio==='9:16'?1920:1080})}/>);
`,
);
const serveUrl = await bundle({
  entryPoint: entry,
  outDir: join(working, "bundle"),
  webpackOverride: (configuration) => ({
    ...configuration,
    resolve: {
      ...configuration.resolve,
      modules: [
        join(root, "node_modules"),
        ...(configuration.resolve?.modules ?? []),
      ],
    },
  }),
});
const binaries = localVideoBinariesDirectory();
// The compositor's reduced FFmpeg build does not include the rawvideo muxer.
// Pixel inspection uses the normal free FFmpeg CLI, independently of encoding.
const ffmpeg = process.env.PANXU_FFMPEG_PATH || "ffmpeg";
const browser = await openBrowser("chrome", {
  browserExecutable: runtime.browserExecutable!,
  logLevel: "error",
});
const results: {
  aspectRatio: string;
  frame: number;
  visibleEntries: number[];
  darkPixels: number;
}[] = [];
try {
  for (const aspectRatio of ["16:9", "9:16"] as const) {
    const input: VideoProject = { ...project, aspectRatio };
    const metrics = new Map<number, FrameMetrics>();
    const common = {
      serveUrl,
      inputProps: { project: input },
      puppeteerInstance: browser,
      browserExecutable: runtime.browserExecutable,
      logLevel: "error" as const,
      binariesDirectory: binaries,
      onBrowserLog: ({ text }: { text: string }) => {
        if (!text.startsWith("DIRECTORY_FRAME_METRICS ")) return;
        const value: FrameMetrics = JSON.parse(
          text.slice("DIRECTORY_FRAME_METRICS ".length),
        );
        metrics.set(value.frame, value);
      },
    };
    const composition = await selectComposition({
      ...common,
      id: "DirectoryRegression",
    });
    const width = aspectRatio === "16:9" ? 1920 : 1080;
    const height = aspectRatio === "16:9" ? 1080 : 1920;
    for (const frame of [0, 180, 330]) {
      const file = join(
        evidence,
        `${aspectRatio.replace(":", "-")}-${frame}.png`,
      );
      await renderStill({
        ...common,
        composition,
        frame,
        imageFormat: "png",
        output: file,
      });
      const state = metrics.get(frame);
      assert.ok(state, `未取得${aspectRatio}第${frame}帧布局`);
      assert.equal(Math.round(state.root.width), width);
      assert.equal(Math.round(state.root.height), height);
      assert.ok(state.viewport.width > 100 && state.viewport.height > 200);
      assert.ok(state.viewport.y >= 0 && state.viewport.bottom <= height - 30);
      assert.ok(
        state.title.x >= 0 && state.title.y >= 0 && state.title.right <= width,
      );
      assert.ok(state.title.bottom <= state.viewport.y);
      assert.ok(
        Math.min(...state.titleLines) >= Math.max(...state.titleLines) * 0.35,
        "长标题不应留下极短孤行",
      );
      assert.ok(
        state.visible.length > 0,
        `${aspectRatio}第${frame}帧不能是空白目录`,
      );
      if (frame === 0) assert.equal(state.visible[0].index, 0);
      if (frame === 180)
        assert.ok(state.visible[0].index > 0, "中段应已滚动到后续条目");
      if (frame === 330) {
        const last = state.visible.find(
          (item) => item.index === input.entries.length - 1,
        );
        assert.ok(
          last && last.visibleHeight >= last.height - 2,
          "末段须完整展示最后一项",
        );
      }
      const crop = [
        Math.floor(state.viewport.width) - 16,
        Math.floor(state.viewport.height) - 16,
        Math.ceil(state.viewport.x) + 8,
        Math.ceil(state.viewport.y) + 8,
      ];
      const pixels = execFileSync(
        ffmpeg,
        [
          "-v",
          "error",
          "-i",
          file,
          "-vf",
          `crop=${crop.join(":")}`,
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgb24",
          "pipe:1",
        ],
        { maxBuffer: 16 * 1024 * 1024 },
      );
      let darkPixels = 0;
      for (let at = 0; at < pixels.length; at += 3)
        if (pixels[at] < 120 && pixels[at + 1] < 140 && pixels[at + 2] < 180)
          darkPixels++;
      assert.ok(
        darkPixels > 1500,
        `${aspectRatio}第${frame}帧的实际截图应包含目录文字`,
      );
      results.push({
        aspectRatio,
        frame,
        visibleEntries: state.visible.map((item) => item.index),
        darkPixels,
      });
    }
  }
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify({ passed: true, results }, null, 2),
  );
  console.log(JSON.stringify({ passed: true, results, evidence }, null, 2));
} finally {
  await browser.close({ silent: true });
  await rm(working, { recursive: true, force: true });
}
