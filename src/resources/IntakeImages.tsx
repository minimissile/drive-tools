import { useRef } from "react";
import { ImagePlus, Upload, X } from "lucide-react";
import { useIpcQuery } from "../api/useIpcQuery";
import { Button, LoadingState, Panel } from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import {
  resourceImageLimit,
  resourceImageMimeTypes,
  type ResourceImageInput,
} from "../../shared/resource-images";

function ImagePreview({
  image,
  index,
}: {
  image: ResourceImageInput;
  index: number;
}) {
  const saved = useIpcQuery(
    "cover.get",
    { id: "id" in image ? image.id : "" },
    {
      enabled: "id" in image,
    },
  );
  const src = "data" in image ? image.data : saved.data;
  return (
    <div className="intake-image-preview">
      {src ? (
        <img
          src={src}
          alt={
            index === 0
              ? "data" in image
                ? "待保存封面"
                : "资源封面"
              : `图片 ${index + 1}`
          }
        />
      ) : saved.error ? (
        <QueryError
          error={saved.error}
          loading={saved.loading}
          onRetry={saved.reload}
        />
      ) : (
        <LoadingState label="正在读取图片…" />
      )}
    </div>
  );
}

export function IntakeImages({
  items,
  loading,
  disabled,
  onAdd,
  onRemove,
  onCover,
}: {
  items: ResourceImageInput[];
  loading: boolean;
  disabled: boolean;
  onAdd(files: File[]): void;
  onRemove(index: number): void;
  onCover(index: number): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <Panel
      title="图片资源"
      aria-label="图片资源"
      className="intake-images-panel"
      extra={
        <small aria-live="polite">
          {items.length} / {resourceImageLimit} 张
        </small>
      }
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        if (!disabled) onAdd(Array.from(event.dataTransfer.files));
      }}
    >
      {items.length ? (
        <ul className="intake-image-list">
          {items.map((image, index) => (
            <li key={`${index}:${"id" in image ? image.id : "new"}`}>
              <ImagePreview image={image} index={index} />
              <div className="intake-image-actions">
                {index === 0 ? (
                  <span className="tag">封面</span>
                ) : (
                  <Button
                    size="compact"
                    quiet
                    disabled={disabled}
                    onClick={() => onCover(index)}
                    aria-label={`将图片 ${index + 1} 设为封面`}
                  >
                    设为封面
                  </Button>
                )}
                <Button
                  size="compact"
                  quiet
                  disabled={disabled}
                  aria-label={`移除图片 ${index + 1}`}
                  title="移除图片"
                  onClick={() => onRemove(index)}
                >
                  <X size={15} />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : loading ? (
        <LoadingState label="正在读取图片…" />
      ) : (
        <div className="cover-drop intake-image-drop">
          <ImagePlus size={25} aria-hidden="true" />
          <strong>粘贴或拖入图片</strong>
          <small>第一张图片用作封面</small>
        </div>
      )}
      <div className="intake-image-upload">
        <Button
          disabled={disabled || items.length >= resourceImageLimit}
          onClick={() => input.current?.click()}
        >
          <Upload size={14} />
          {loading ? "正在读取…" : "选择图片"}
        </Button>
        <small>JPG / PNG / WebP，每张最大 8MB</small>
      </div>
      <input
        ref={input}
        type="file"
        accept={resourceImageMimeTypes.join(",")}
        multiple
        hidden
        onChange={(event) => {
          onAdd(Array.from(event.currentTarget.files ?? []));
          event.currentTarget.value = "";
        }}
      />
    </Panel>
  );
}
