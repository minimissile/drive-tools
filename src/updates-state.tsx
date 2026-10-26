import { useIpcQuery } from "./api/useIpcQuery";
import { useContext, useEffect, useState, type ReactNode } from "react";
import type { UpdateState } from "../shared/updates";
import { stableContext } from "./lib/stable-context";

const UpdateReadContext = stableContext("UpdateRead", {
  loading: true,
  error: "",
  reload: () => {},
});
export const useUpdateRead = () => useContext(UpdateReadContext);

const UpdatesContext = stableContext<UpdateState | null>("Updates", null);
export const useUpdates = () => useContext(UpdatesContext);

// Progress events update only the update controls, without refreshing or
// rerendering resource lists, drafts or the business snapshot.
export function UpdatesProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<UpdateState | null>(null);
  const read = useIpcQuery("updater.state", undefined, {
    enabled: !!window.panxu,
  });
  useEffect(() => {
    if (!window.panxu) return;
    let active = true;
    const receive = (next: UpdateState) => {
      if (active)
        setState((old) => (!old || next.revision >= old.revision ? next : old));
    };
    const unsubscribe = window.panxu.onUpdateChanged(receive);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  const current =
    !state || (read.data && read.data.revision > state.revision)
      ? read.data
      : state;
  return (
    <UpdateReadContext
      value={{ loading: read.loading, error: read.error, reload: read.reload }}
    >
      <UpdatesContext.Provider value={current}>
        {children}
      </UpdatesContext.Provider>
    </UpdateReadContext>
  );
}
