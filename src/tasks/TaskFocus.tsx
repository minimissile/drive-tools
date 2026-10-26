import {
  useContext,
  useState,
  useMemo,
  useCallback,
  type ReactNode,
} from "react";
import type { OperationKind } from "../../shared/zhidao";
import { stableContext } from "../lib/stable-context";
export interface TaskFocus {
  id: string;
  kind: OperationKind | "job";
}
const Context = stableContext<{
  focus: TaskFocus | null;
  request(focus: TaskFocus): void;
  consume(): void;
} | null>("TaskFocus", null);
export function TaskFocusProvider({ children }: { children: ReactNode }) {
  const [focus, setFocus] = useState<TaskFocus | null>(null);
  const consume = useCallback(() => setFocus(null), []);
  const value = useMemo(
    () => ({ focus, request: setFocus, consume }),
    [focus, consume],
  );
  return <Context value={value}>{children}</Context>;
}
export function useTaskFocus() {
  const value = useContext(Context);
  if (!value) throw new Error("TaskFocusProvider missing");
  return value;
}
