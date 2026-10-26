import { Toast } from "../ui/Toast";
import { ToastLayerProvider } from "../ui/ToastLayer";
import { stableContext } from "../lib/stable-context";
import type { FeedbackMessage, Notify } from "../lib/feedback";
import {
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

type ToastEntry = (FeedbackMessage & { id: number }) | null;
interface FeedbackActions {
  notify: Notify;
  clearToast(): void;
  begin(): void;
  end(): void;
}
const Actions = stableContext<FeedbackActions | null>("FeedbackActions", null);
const Activity = stableContext("AppActivity", 0);
const ToastState = stableContext<ToastEntry>("AppToast", null);

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastEntry>(null);
  const [busy, setBusy] = useState(0);
  const nextId = useRef(0);
  const notify = useCallback<Notify>((text, tone) => {
    setToast({ id: ++nextId.current, text, tone });
  }, []);
  const actions = useMemo(
    () => ({
      notify,
      clearToast: () => setToast(null),
      begin: () => setBusy((n) => n + 1),
      end: () => setBusy((n) => Math.max(0, n - 1)),
    }),
    [notify],
  );
  return (
    <ToastLayerProvider>
      <Actions.Provider value={actions}>
        <Activity.Provider value={busy}>
          <ToastState.Provider value={toast}>{children}</ToastState.Provider>
        </Activity.Provider>
      </Actions.Provider>
    </ToastLayerProvider>
  );
}

export function useFeedbackActions() {
  const value = useContext(Actions);
  if (!value) throw new Error("FeedbackProvider missing");
  return value;
}
export const useAppActivity = () => ({ busy: useContext(Activity) });
export const useAppToast = () => useContext(ToastState);

// This small subscriber keeps toast changes out of the page and data contexts.
export function ToastMessage() {
  const toast = useAppToast();
  const { clearToast } = useFeedbackActions();
  return toast ? (
    <Toast key={toast.id} {...toast} onDismiss={clearToast} />
  ) : null;
}
