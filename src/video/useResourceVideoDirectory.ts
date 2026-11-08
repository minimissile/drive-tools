import { useEffect, useRef, useState } from "react";
import { ipc } from "../api/client";
import { readAttachment, writeAttachment } from "../storage/draft-attachments";
import { windowStorage } from "../storage/window-storage";
import {
  readVideoDirectorySnapshot,
  loadVideoDirectorySnapshot,
  videoDirectorySnapshotKey,
  type VideoDirectorySnapshot,
  type VideoDirectoryTarget,
} from "./resource-video-source";

function savedSelection(key: string) {
  try {
    return windowStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}
interface DirectoryState {
  key: string;
  snapshot: VideoDirectorySnapshot | null;
  restoring: boolean;
  reading: boolean;
  error: string;
  warning: string;
}

/** Resource-only adapter. Network reads happen exclusively from its explicit action. */
export function useResourceVideoDirectory(
  scope: string,
  copyId: string,
  targets: VideoDirectoryTarget[],
) {
  const selectionKey = `panxu-video-directory-selection:${scope}:${copyId}`;
  const [selectedId, setSelectedId] = useState(() =>
    savedSelection(selectionKey),
  );
  const target = targets.find((item) => item.id === selectedId) ?? targets[0];
  const key = target ? videoDirectorySnapshotKey(scope, copyId, target) : "";
  const activeKey = useRef(key);
  activeKey.current = key;
  const sequence = useRef(0);
  const readingKey = useRef<string | null>(null);
  const [state, setState] = useState<DirectoryState>({
    key,
    snapshot: null,
    restoring: !!key,
    reading: false,
    error: "",
    warning: "",
  });
  useEffect(() => {
    const request = ++sequence.current;
    let active = true;
    setState({
      key,
      snapshot: null,
      restoring: !!key,
      reading: false,
      error: "",
      warning: "",
    });
    if (target)
      void readAttachment(key)
        .then((raw) => {
          const snapshot = readVideoDirectorySnapshot(raw, target);
          if (
            active &&
            activeKey.current === key &&
            sequence.current === request
          )
            setState({
              key,
              snapshot,
              restoring: false,
              reading: false,
              error: "",
              warning: "",
            });
        })
        .catch((cause) => {
          if (
            active &&
            activeKey.current === key &&
            sequence.current === request
          )
            setState({
              key,
              snapshot: null,
              restoring: false,
              reading: false,
              error:
                cause instanceof Error
                  ? cause.message
                  : "目录暂存未能恢复，请重新读取。原记录已保留。",
              warning: "",
            });
        });
    return () => {
      active = false;
      sequence.current++;
    };
  }, [key]);
  const read = async () => {
    if (!target || readingKey.current === key) return;
    readingKey.current = key;
    const request = ++sequence.current;
    const current = () =>
      activeKey.current === key && sequence.current === request;
    setState((old) => ({
      key,
      snapshot: old.key === key ? old.snapshot : null,
      restoring: false,
      reading: true,
      error: "",
      warning: "",
    }));
    try {
      const snapshot = await loadVideoDirectorySnapshot(
        target,
        (accountId, path) => {
          if (!current()) throw new Error("目录读取已停止。");
          return ipc("drive.directory", { accountId, path });
        },
      );
      if (!current()) return;
      setState({
        key,
        snapshot,
        restoring: false,
        reading: false,
        error: "",
        warning: "",
      });
      try {
        await writeAttachment(key, JSON.stringify(snapshot));
      } catch {
        if (current())
          setState((old) => ({
            ...old,
            warning: "目录快照暂存失败，当前页面仍可使用；离开后请重新读取。",
          }));
      }
    } catch (cause) {
      if (current())
        setState((old) => ({
          ...old,
          reading: false,
          error:
            cause instanceof Error
              ? cause.message
              : "文件夹内容读取失败，请重试。",
        }));
    } finally {
      if (readingKey.current === key) readingKey.current = null;
    }
  };
  const choose = (id: string) => {
    sequence.current++;
    setSelectedId(id);
    try {
      windowStorage.setItem(selectionKey, id);
    } catch {
      /* Snapshot remains separately recoverable. */
    }
  };
  const reset = async () => {
    const request = ++sequence.current;
    setState({
      key,
      snapshot: null,
      restoring: false,
      reading: false,
      error: "",
      warning: "",
    });
    try {
      await writeAttachment(key, null);
    } catch {
      if (activeKey.current === key && sequence.current === request)
        setState((old) => ({
          ...old,
          warning: "目录选择暂存失败，当前已使用资源清单。",
        }));
    }
  };
  const value =
    state.key === key
      ? state
      : {
          ...state,
          snapshot: null,
          restoring: !!key,
          reading: false,
          error: "",
          warning: "",
        };
  return { target, ...value, read, choose, reset };
}
