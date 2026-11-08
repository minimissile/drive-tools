import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  AbsoluteFill,
  Audio,
  Img,
  continueRender,
  delayRender,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type { VideoProject } from "../shared/video";

const palette = {
  background: "#f5f7fb",
  paper: "#ffffff",
  ink: "#17253e",
  muted: "#52637e",
  blue: "#2d60c8",
  line: "#dce3ef",
};
const fontFamily =
  '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';

function FileIcon({ folder }: { folder: boolean }) {
  return (
    <svg
      width="58"
      height="58"
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
    >
      {folder ? (
        <>
          <path
            d="M4 12a4 4 0 0 1 4-4h12l5 6h15a4 4 0 0 1 4 4v20a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V12Z"
            fill="#dce9ff"
          />
          <path
            d="M4 19h40v19a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V19Z"
            fill="#3975d7"
          />
        </>
      ) : (
        <>
          <path
            d="M12 5h17l9 9v26a3 3 0 0 1-3 3H12a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3Z"
            stroke="#58749c"
            strokeWidth="3"
          />
          <path
            d="M29 5v10h9M16 25h15M16 32h12"
            stroke="#58749c"
            strokeWidth="3"
            strokeLinecap="round"
          />
        </>
      )}
    </svg>
  );
}

function VideoFrame({
  project,
  children,
}: {
  project: VideoProject;
  children: ReactNode;
}) {
  const { width, height, durationInFrames } = useVideoConfig();
  const frame = useCurrentFrame();
  const wide = width > 1200;
  const padding = wide ? 68 : 64;
  return (
    <AbsoluteFill
      data-video-frame
      style={{
        width,
        height,
        boxSizing: "border-box",
        background: palette.background,
        color: palette.ink,
        fontFamily,
        padding,
        display: "flex",
        flexDirection: "column",
        gap: 32,
      }}
    >
      <header style={{ flexShrink: 0 }}>
        <h1
          data-video-title
          style={{
            margin: 0,
            fontSize: project.title.length > 70 ? 48 : wide ? 60 : 68,
            lineHeight: 1.3,
            fontWeight: 700,
            overflowWrap: "anywhere",
            textWrap: "balance",
          }}
        >
          {project.title}
        </h1>
        {project.subtitle ? (
          <p
            style={{
              margin: "20px 0 0",
              color: palette.muted,
              fontSize: project.subtitle.length > 180 ? 25 : 32,
              lineHeight: 1.55,
              overflowWrap: "anywhere",
            }}
          >
            {project.subtitle}
          </p>
        ) : null}
      </header>
      <main
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          background: palette.paper,
          border: `2px solid ${palette.line}`,
          borderRadius: 18,
          overflow: "hidden",
        }}
      >
        {children}
      </main>
      <footer
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 24,
          color: palette.muted,
          fontSize: 26,
        }}
      >
        <span>
          {project.template === "directory-scroll" ? "目录展示" : "内容预览"}
        </span>
        <div
          style={{
            height: 5,
            flex: 1,
            background: palette.line,
            borderRadius: 3,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              background: palette.blue,
              width: `${Math.min(100, (frame / Math.max(1, durationInFrames - 1)) * 100)}%`,
            }}
          />
        </div>
      </footer>
      {project.audio ? (
        <Audio
          src={project.audio.src}
          volume={(audioFrame) =>
            project.audio!.volume *
            interpolate(
              audioFrame,
              [0, 15, durationInFrames - 20, durationInFrames - 1],
              [0, 1, 1, 0],
              { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
            )
          }
          loop
          loopVolumeCurveBehavior="extend"
        />
      ) : null}
    </AbsoluteFill>
  );
}

function Directory({ project }: { project: VideoProject }) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const viewport = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [travel, setTravel] = useState(0);
  const [handle] = useState(() => delayRender("测量实际目录排版"));
  useLayoutEffect(() => {
    let active = true;
    let fontsReady = false;
    let released = false;
    const measure = () => {
      const window = viewport.current;
      const content = list.current;
      // Remotion initially mounts compositions before their wrapper is sized.
      // Zero-width text can wrap into tens of thousands of pixels, which is not
      // the final scroll range. Only release the frame after a usable layout.
      if (
        !active ||
        !fontsReady ||
        !window?.clientWidth ||
        !window.clientHeight ||
        !content?.offsetWidth
      )
        return;
      setTravel(Math.max(0, content.offsetHeight - window.clientHeight));
      if (!released) {
        released = true;
        continueRender(handle);
      }
    };
    const observer = new ResizeObserver(measure);
    if (viewport.current) observer.observe(viewport.current);
    if (list.current) observer.observe(list.current);
    void document.fonts.ready.then(() => {
      fontsReady = true;
      measure();
    });
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [handle]);
  const scroll = interpolate(
    frame,
    [30, Math.max(31, durationInFrames - 30)],
    [0, travel],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 20,
          padding: "30px 36px",
          borderBottom: `2px solid ${palette.line}`,
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 34, fontWeight: 650 }}>资料目录</span>
        <span style={{ color: palette.muted, fontSize: 27 }}>
          {project.entries.length} 项
        </span>
      </div>
      <div
        ref={viewport}
        data-video-directory-viewport
        style={{ flex: 1, minHeight: 0, overflow: "hidden", padding: "0 36px" }}
      >
        <div
          ref={list}
          data-video-directory-list
          style={{ transform: `translateY(-${scroll}px)`, paddingBottom: 10 }}
        >
          {project.entries.map((entry, index) => (
            <div
              key={index}
              data-video-entry={index}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 24,
                padding: "30px 0",
                minHeight: 126,
                borderBottom:
                  index === project.entries.length - 1
                    ? undefined
                    : `2px solid ${palette.line}`,
              }}
            >
              <div style={{ flexShrink: 0, paddingTop: 5 }}>
                <FileIcon folder={entry.kind === "folder"} />
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div
                  style={{
                    fontSize: 32,
                    lineHeight: 1.5,
                    fontWeight: 550,
                    overflowWrap: "anywhere",
                  }}
                >
                  {entry.name}
                </div>
                <div
                  style={{ color: palette.muted, fontSize: 23, marginTop: 7 }}
                >
                  {entry.kind === "folder" ? "文件夹" : "文件"}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function Slideshow({ project }: { project: VideoProject }) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const framesPerSlide = durationInFrames / project.slides.length;
  const index = Math.min(
    project.slides.length - 1,
    Math.floor(frame / framesPerSlide),
  );
  const slide = project.slides[index];
  const progress = (frame - index * framesPerSlide) / framesPerSlide;
  return (
    <>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "hidden",
          padding: 30,
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <Img
          src={slide.src}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "contain",
            transform: `scale(${1 + progress * 0.025})`,
          }}
        />
      </div>
      <div
        style={{
          padding: "26px 36px",
          borderTop: `2px solid ${palette.line}`,
          flexShrink: 0,
          display: "flex",
          alignItems: "flex-start",
          gap: 24,
        }}
      >
        <p
          style={{
            margin: 0,
            flex: 1,
            fontSize: 29,
            lineHeight: 1.5,
            overflowWrap: "anywhere",
          }}
        >
          {slide.caption || "资料内容预览"}
        </p>
        <span
          style={{
            color: palette.muted,
            fontSize: 26,
            whiteSpace: "nowrap",
            lineHeight: 1.7,
          }}
        >
          {index + 1} / {project.slides.length}
        </span>
      </div>
    </>
  );
}

export function VideoComposition({ project }: { project: VideoProject }) {
  return (
    <VideoFrame project={project}>
      {project.template === "directory-scroll" ? (
        <Directory project={project} />
      ) : (
        <Slideshow project={project} />
      )}
    </VideoFrame>
  );
}
