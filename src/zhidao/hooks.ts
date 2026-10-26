import { useTaskFocus } from "../tasks/TaskFocus";
import { useEffect, useRef, useState } from "react";
import { useAppActions, useAppData } from "../state";
import { ipc } from "../api/client";
import { useIpcQuery } from "../api/useIpcQuery";
import { useLocalDraft } from "../hooks/useLocalDraft";
import type { IpcArgs, IpcMethod, IpcValue } from "../../shared/ipc";
import type { OperationKind } from "../../shared/zhidao";

export function useOperationAction() {
  const { notify } = useAppActions();
  const [pending, setPending] = useState("");
  const mounted = useRef(false);
  const lock = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = async <M extends IpcMethod>(
    method: M,
    args: IpcArgs<M>,
    onSuccess?: (value: IpcValue<M>) => void,
    message?: string,
    onFailure?: (error: Error) => void,
  ) => {
    if (!mounted.current || lock.current) return;
    lock.current = true;
    setPending(method);
    let result: IpcValue<M>;
    try {
      result = await ipc(
        method,
        ...([args] as import("../../shared/ipc").IpcArguments<M>),
      );
    } catch (cause) {
      const error =
        cause instanceof Error ? cause : new Error("操作未完成，请重试。");
      if (mounted.current) {
        if (onFailure) onFailure(error);
        else notify(error.message, "error");
      }
      return;
    } finally {
      lock.current = false;
      if (mounted.current) setPending("");
    }
    if (mounted.current) {
      try {
        onSuccess?.(result);
        if (message) notify(message, "success");
      } catch {
        notify("操作已完成，界面刷新失败，请重新打开记录。", "warning");
      }
    }
    return result;
  };
  return { pending, run };
}
export function useOperation(kind: OperationKind) {
  const { data } = useAppData();
  const draft = useLocalDraft(
    `panxu-operation-focus:${data!.dataPath}:${kind}`,
    { id: "" },
    (raw) => {
      const v = raw as { id?: unknown };
      return { id: typeof v?.id === "string" ? v.id : "" };
    },
  );
  const { focus, consume } = useTaskFocus();
  const [focusRunId, setFocusRunId] = useState("");
  useEffect(() => {
    if (focus?.kind !== kind) return;
    draft.update({ id: focus.id });
    setFocusRunId(focus.id);
    setPage(1);
    setRevision((value) => value + 1);
    consume();
  }, [focus, kind, draft.update, consume]);
  const [page, setPage] = useState(1),
    [historyPage, setHistoryPage] = useState(1),
    [revision, setRevision] = useState(0);
  const history = useIpcQuery(
    "zhidao.runs",
    { kind, page: historyPage },
    { revision, refreshInterval: 2500, keepPrevious: true },
  );
  const detail = useIpcQuery(
    "zhidao.run",
    { id: draft.value.id, page },
    {
      enabled: !!draft.value.id,
      revision,
      refreshInterval: 2000,
      keepPrevious: true,
    },
  );
  const pick = (value: { id: string }) => {
    draft.update({ id: value.id });
    setPage(1);
    setRevision((n) => n + 1);
  };
  const refresh = () => {
    setRevision((n) => n + 1);
  };
  return {
    kind,
    focusRunId,
    clearFocus: () => setFocusRunId(""),
    id: draft.value.id,
    pick,
    history,
    detail: {
      ...detail,
      data: detail.data?.run.id === draft.value.id ? detail.data : null,
    },
    page,
    setPage,
    historyPage,
    setHistoryPage,
    refresh,
    running: detail.data?.run.status === "running",
  };
}
export type OperationModel = ReturnType<typeof useOperation>;
