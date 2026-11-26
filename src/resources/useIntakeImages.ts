import { useEffect, useMemo, useRef, useState } from "react";
import { useAttachmentDraft } from "../hooks/useAttachmentDraft";
import { useAppActions } from "../state";
import type { Resource } from "../../shared/types";
import {
  resourceImageIdPattern,
  resourceImageLimit,
  resourceImageMaxBytes,
  resourceImageMimeTypes,
  type ResourceImageInput,
} from "../../shared/resource-images";

function parseImageDraft(
  stored: string | null | undefined,
): ResourceImageInput[] | undefined {
  if (stored === undefined) return undefined;
  if (stored === null) return [];
  // Existing intake drafts stored the cover directly as a data URL.
  if (stored.startsWith("data:image/")) return [{ data: stored }];
  try {
    const value: unknown = JSON.parse(stored);
    if (
      Array.isArray(value) &&
      value.length <= resourceImageLimit &&
      value.every(
        (item) =>
          item &&
          ((typeof item.id === "string" &&
            resourceImageIdPattern.test(item.id)) ||
            (typeof item.data === "string" &&
              item.data.startsWith("data:image/"))),
      )
    )
      return value;
  } catch {
    // A damaged local draft must not replace the saved images.
  }
  return undefined;
}

function readImage(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reader.onabort = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function useIntakeImages(key: string, resource?: Resource) {
  const draft = useAttachmentDraft(key, "图片资源");
  const { notify } = useAppActions();
  const [reading, setReading] = useState(false);
  const pending = useRef<symbol | null>(null);
  useEffect(
    () => () => {
      pending.current = null;
    },
    [],
  );
  const edited = useMemo(() => parseImageDraft(draft.value), [draft.value]);
  const savedIds =
    resource?.imageIds ?? (resource?.coverId ? [resource.coverId] : []);
  const items = edited ?? savedIds.map((id) => ({ id }));
  const update = (next: ResourceImageInput[]) =>
    draft.update(JSON.stringify(next));

  const add = async (files: File[]) => {
    if (draft.loading || pending.current || !files.length) return;
    const available = resourceImageLimit - items.length;
    const accepted = files.filter(
      (file) =>
        resourceImageMimeTypes.includes(file.type) &&
        file.size > 0 &&
        file.size <= resourceImageMaxBytes,
    );
    if (accepted.length !== files.length)
      notify("请选择8MB以内的JPG、PNG或WebP图片。", "warning");
    if (accepted.length > available)
      notify("一份资源最多添加3张图片。", "warning");
    const selected = accepted.slice(0, available);
    if (!selected.length) return;
    const request = Symbol();
    pending.current = request;
    setReading(true);
    try {
      const added = await Promise.all(selected.map(readImage));
      if (pending.current === request)
        update([...items, ...added.map((data) => ({ data }))]);
    } catch {
      if (pending.current === request)
        notify("图片读取失败，请重新选择。", "error");
    } finally {
      if (pending.current === request) {
        pending.current = null;
        setReading(false);
      }
    }
  };

  return {
    items,
    input: edited?.length || savedIds.length ? edited : undefined,
    loading: draft.loading || reading,
    error: draft.error,
    add,
    remove: (index: number) => update(items.filter((_, i) => i !== index)),
    setCover: (index: number) =>
      update([items[index], ...items.filter((_, i) => i !== index)]),
    reset: () => {
      pending.current = null;
      setReading(false);
      draft.update(null);
    },
    clear: draft.clear,
  };
}
