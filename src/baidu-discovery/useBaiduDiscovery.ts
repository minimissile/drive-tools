import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import type {
  DiscoveryInput,
  DiscoveryRun,
} from "../../shared/baidu-discovery";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useFeedbackActions } from "../state/feedback";
import { useTaskFocus } from "../tasks/TaskFocus";
import { useLocalDraft } from "../hooks/useLocalDraft";

export function useBaiduDiscovery(workspace: string) {
  const history = useIpcQuery("baiduDiscovery.list", undefined, {
    keepPrevious: true,
    refreshInterval: 2500,
  });
  const selection = useLocalDraft(
    `panxu-baidu-discovery-task:${workspace}`,
    { id: "" },
    (value) => z.object({ id: z.string() }).parse(value),
  );
  const picked = selection.value.id;
  const navigationVersion = useRef(0);
  const setPicked = useCallback(
    (id: string) => selection.update({ id }),
    [selection.update],
  );
  const { focus, consume } = useTaskFocus();
  useEffect(() => {
    if (focus?.kind === "baidu-discovery") {
      navigationVersion.current++;
      setPicked(focus.id);
      consume();
    }
  }, [focus, consume, setPicked]);
  const [accepted, setAccepted] = useState<DiscoveryRun | null>(null);
  const id = picked || history.data?.[0]?.id || "";
  const detail = useIpcQuery(
    "baiduDiscovery.get",
    { id },
    { enabled: !!id, refreshInterval: 1500 },
  );
  const serverRun = detail.data?.id === id ? detail.data : null;
  const acceptedRun = accepted?.id === id ? accepted : null;
  const run =
    acceptedRun && (!serverRun || acceptedRun.updatedAt > serverRun.updatedAt)
      ? acceptedRun
      : serverRun;
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const { notify } = useFeedbackActions();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const perform = async (
    name: string,
    action: () => Promise<DiscoveryRun | void>,
  ) => {
    if (inFlight.current) return;
    inFlight.current = true;
    const version = navigationVersion.current;
    setPending(name);
    setError("");
    try {
      const next = await action();
      if (!mounted.current) return;
      if (next) {
        setAccepted(next);
        if (version === navigationVersion.current) setPicked(next.id);
      }
      history.reload();
      detail.reload();
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error ? cause.message : "操作未完成，请重试。",
        );
    } finally {
      inFlight.current = false;
      if (mounted.current) setPending("");
    }
  };
  return {
    history,
    detail,
    run,
    id,
    pending,
    error: error || selection.error,
    running:
      run?.status === "running" ||
      history.data?.some((item) => item.status === "running") ||
      false,
    pick: (next: string) => {
      navigationVersion.current++;
      setPicked(next);
      setError("");
    },
    start: (input: DiscoveryInput) =>
      perform("start", () => ipc("baiduDiscovery.start", input)),
    control: (kind: "pause" | "resume" | "skip") =>
      perform(kind, () => ipc(`baiduDiscovery.${kind}`, { id })),
    expand: (words: string[]) =>
      perform("expand", () => ipc("baiduDiscovery.expand", { id, words })),
    open: () =>
      perform("open", () =>
        ipc("baiduDiscovery.open", { id: id || undefined }),
      ),
    closeBrowser: () =>
      perform("closeBrowser", () => ipc("baiduDiscovery.closeBrowser")),
    export: (format: "csv" | "txt", words?: string[]) =>
      perform("export", async () => {
        const path = await ipc("baiduDiscovery.export", { id, format, words });
        if (path && mounted.current) notify("去重关键词已导出。", "success");
      }),
  };
}
export type DiscoveryModel = ReturnType<typeof useBaiduDiscovery>;
