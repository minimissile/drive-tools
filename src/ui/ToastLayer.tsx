import {
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { stableContext } from "../lib/stable-context";

type Layer = {
  host: HTMLElement | null;
  register(host: HTMLElement): () => void;
};
const ToastLayerContext = stableContext<Layer | null>("ToastLayer", null);

/** Toasts live above the workspace, or inside the active dialog's focus boundary. */
export function ToastLayerProvider({ children }: { children: ReactNode }) {
  const [hosts, setHosts] = useState<HTMLElement[]>([]);
  const register = useCallback((host: HTMLElement) => {
    setHosts((previous) => [...previous, host]);
    return () =>
      setHosts((previous) => previous.filter((node) => node !== host));
  }, []);
  const value = useMemo(
    () => ({ host: hosts.at(-1) ?? null, register }),
    [hosts, register],
  );
  return <ToastLayerContext value={value}>{children}</ToastLayerContext>;
}

export function useToastHost(ref: RefObject<HTMLElement | null>) {
  const register = useContext(ToastLayerContext)?.register;
  return useCallback(
    (host: HTMLElement | null) => {
      ref.current = host;
      if (!host) return;
      const unregister = register?.(host);
      return () => {
        ref.current = null;
        unregister?.();
      };
    },
    [ref, register],
  );
}

export function ToastPortal({ children }: { children: ReactNode }) {
  const layer = useContext(ToastLayerContext);
  return createPortal(children, layer?.host ?? document.body);
}
