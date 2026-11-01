import { useEffect, useRef, useState } from "react";
import { Panel, Notice, LoadingState } from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { Dialog } from "../ui/Dialog";
import { renderPhotoCard } from "./render";
import { loadPhotoFonts } from "./canvas";
import type { PhotoForm } from "../../shared/photo-posts";

export function PhotoPreview({
  form,
  drive,
  cover,
  coverRequired,
  coverLoading,
  coverError,
  onRetryCover,
  onRender,
}: {
  form: PhotoForm;
  drive: string;
  cover: string | null | undefined;
  coverRequired: boolean;
  coverLoading: boolean;
  coverError: string;
  onRetryCover(): void;
  onRender(images: string[], error: string): void;
}) {
  const canvases = useRef<(HTMLCanvasElement | null)[]>([]);
  const [error, setError] = useState("");
  const [large, setLarge] = useState<{ title: string; url: string } | null>(
    null,
  );
  useEffect(() => {
    let cancelled = false;
    onRender([], "");
    if (coverRequired && !cover) {
      setError("");
      return;
    }
    const draw = async () => {
      try {
        await loadPhotoFonts();
        let image: HTMLImageElement | null = null;
        if (cover && coverRequired) {
          image = new Image();
          image.src = cover;
          try {
            await image.decode();
          } catch {
            throw Error(
              "资源原封面无法解码，请重新设置资源封面，或切换为大字构图。",
            );
          }
        }
        if (cancelled) return;
        const problems: string[] = [];
        const images = canvases.current.map((canvas, index) => {
          if (!canvas) throw Error("图片尚未准备完成");
          problems.push(...renderPhotoCard(canvas, index, form, drive, image));
          return canvas.toDataURL("image/png");
        });
        const message = [...new Set(problems)].join("；");
        setError(message);
        onRender(images, message);
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : "图片绘制失败";
        setError(message);
        onRender([], message);
      }
    };
    const timer = setTimeout(() => void draw(), 140);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [form, drive, cover, coverRequired, onRender]);
  return (
    <Panel title="三张图预览" extra={<small>1080 × 1440 · 点击看原图</small>}>
      {coverRequired && !cover ? (
        coverError ? (
          <QueryError
            title="暂时无法读取资源原封面"
            error={coverError}
            loading={coverLoading}
            onRetry={onRetryCover}
          >
            也可切换为大字构图。
          </QueryError>
        ) : (
          <LoadingState compact label="正在读取资源原封面…" />
        )
      ) : (
        <div className="photo-post-previews">
          {["资源封面", "资源详情", "获取方式"].map((label, index) => (
            <figure key={label}>
              <button
                className="photo-post-preview-open"
                aria-label={`查看${label}大图`}
                onClick={() => {
                  const canvas = canvases.current[index];
                  if (canvas)
                    setLarge({
                      title: label,
                      url: canvas.toDataURL("image/png"),
                    });
                }}
              >
                <canvas
                  ref={(node) => {
                    canvases.current[index] = node;
                  }}
                  role="img"
                  aria-label={label}
                />
              </button>
              <figcaption>{label}</figcaption>
            </figure>
          ))}
        </div>
      )}
      {error ? <Notice warning>{error}</Notice> : null}
      {large ? (
        <Dialog
          title={large.title}
          onClose={() => setLarge(null)}
          className="photo-post-image-dialog"
        >
          <img src={large.url} alt={large.title} />
        </Dialog>
      ) : null}
    </Panel>
  );
}
