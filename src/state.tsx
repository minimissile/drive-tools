import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { AppSnapshot, Resource, ResourceCopy } from "../shared/types";
export type Page =
  | "library"
  | "accounts"
  | "intake"
  | "tasks"
  | "traffic"
  | "studio"
  | "publish"
  | "settings"
  | "bulk"
  | "batch"
  | "split";
// Batch operations keep their own durable plans; navigation stores no credentials.
interface Store {
  data: AppSnapshot | null;
  page: Page;
  navigate(page: Page): void;
  selectedResourceId: string;
  selectedCopyId: string;
  select(resourceId: string, copyId?: string): void;
  resource: Resource | undefined;
  copy: ResourceCopy | undefined;
  activeAccounts: Record<string, string>;
  setActiveAccount(provider: string, id: string): void;
  editResourceId: string | null;
  editCopyId: string | null;
  edit(resourceId: string | null, copyId?: string): void;
  command<T = unknown>(
    method: string,
    args?: unknown,
    success?: string,
  ): Promise<T | undefined>;
  refresh(): Promise<void>;
  busy: number;
  toast: { text: string; error: boolean } | null;
  notify(text: string, error?: boolean): void;
}
const Context = createContext<Store | null>(null);
export function useApp() {
  const ctx = useContext(Context);
  if (!ctx) throw new Error("AppProvider missing");
  return ctx;
}
const pages: Page[] = [
  "library",
  "accounts",
  "intake",
  "tasks",
  "traffic",
  "studio",
  "publish",
  "settings",
  "bulk",
  "batch",
  "split",
];
function savedUi(): {
  page?: Page;
  resourceId?: string;
  copyId?: string;
  activeAccounts?: Record<string, string>;
} {
  try {
    const data = JSON.parse(localStorage.getItem("panxu-ui-v1") ?? "{}");
    return {
      page: pages.includes(data.page) ? data.page : "library",
      resourceId: typeof data.resourceId === "string" ? data.resourceId : "",
      copyId: typeof data.copyId === "string" ? data.copyId : "",
      activeAccounts:
        data.activeAccounts && typeof data.activeAccounts === "object"
          ? data.activeAccounts
          : {},
    };
  } catch {
    return {};
  }
}
export function AppProvider({ children }: { children: ReactNode }) {
  const saved = useRef(savedUi());
  const [data, setData] = useState<AppSnapshot | null>(null),
    [extraResource, setExtraResource] = useState<Resource | null>(null),
    [page, setPage] = useState<Page>(saved.current.page ?? "library"),
    [selectedResourceId, setResourceId] = useState(
      saved.current.resourceId ?? "",
    ),
    [selectedCopyId, setCopyId] = useState(saved.current.copyId ?? ""),
    [activeAccounts, setActiveAccounts] = useState<Record<string, string>>(
      saved.current.activeAccounts ?? {},
    ),
    [editResourceId, setEditResourceId] = useState<string | null>(null),
    [editCopyId, setEditCopyId] = useState<string | null>(null),
    [busy, setBusy] = useState(0),
    [toast, setToast] = useState<Store["toast"]>(null);
  const notify = useCallback(
    (text: string, error = false) => setToast({ text, error }),
    [],
  );
  const refresh = useCallback(async () => {
    if (!window.panxu) return;
    const snapshot = await window.panxu.invoke<AppSnapshot>("snapshot", {
      resourceId: selectedResourceId || undefined,
    });
    setData(snapshot);
  }, [selectedResourceId]);
  useEffect(() => {
    void refresh().catch((e) => notify(e.message, true));
    return window.panxu?.onChanged(() => {
      void refresh().catch((e) => notify(e.message, true));
    });
  }, [refresh, notify]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toast.error ? 12_000 : 6500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    localStorage.setItem(
      "panxu-ui-v1",
      JSON.stringify({
        page,
        resourceId: selectedResourceId,
        copyId: selectedCopyId,
        activeAccounts,
      }),
    );
  }, [page, selectedResourceId, selectedCopyId, activeAccounts]);
  const command = useCallback(
    async <T,>(
      method: string,
      args?: unknown,
      success?: string,
    ): Promise<T | undefined> => {
      setBusy((n) => n + 1);
      setToast(null);
      try {
        const result = await window.panxu.invoke<T>(method, args);
        await refresh();
        if (success) notify(success);
        return result;
      } catch (error) {
        notify(error instanceof Error ? error.message : "操作失败", true);
        return undefined;
      } finally {
        setBusy((n) => n - 1);
      }
    },
    [refresh, notify],
  );
  useEffect(() => {
    if (
      !data ||
      !selectedResourceId ||
      data.resources.some((r) => r.id === selectedResourceId)
    )
      return;
    let active = true;
    void window.panxu
      .invoke<Resource>("resource.get", { id: selectedResourceId })
      .then((r) => {
        if (active) setExtraResource(r);
      })
      .catch((error) => {
        if (active) {
          notify(error.message, true);
          setResourceId(data.resources[0]?.id ?? "");
          setExtraResource(null);
        }
      });
    return () => {
      active = false;
    };
  }, [data, selectedResourceId, notify]);
  const resource = selectedResourceId
    ? (data?.resources.find((r) => r.id === selectedResourceId) ??
      (extraResource?.id === selectedResourceId ? extraResource : undefined))
    : data?.resources[0];
  const copy =
    resource?.copies.find((c) => c.id === selectedCopyId) ??
    resource?.copies[0];
  const select = (resourceId: string, copyId?: string) => {
    setResourceId(resourceId);
    setCopyId(copyId ?? "");
  };
  const edit = (resourceId: string | null, copyId?: string) => {
    setEditResourceId(resourceId);
    setEditCopyId(copyId ?? null);
    if (resourceId) {
      setResourceId(resourceId);
      setCopyId(copyId === "new" ? "" : (copyId ?? ""));
    }
    if (resourceId && !data?.resources.some((r) => r.id === resourceId)) {
      void window.panxu
        .invoke<Resource>("resource.get", { id: resourceId })
        .then((r) => {
          setExtraResource(r);
          setPage("intake");
        })
        .catch((error) => notify(error.message, true));
    } else setPage("intake");
  };
  return (
    <Context.Provider
      value={{
        data,
        page,
        navigate: setPage,
        selectedResourceId: selectedResourceId || resource?.id || "",
        selectedCopyId: copy?.id ?? "",
        select,
        resource,
        copy,
        activeAccounts,
        setActiveAccount: (provider, id) =>
          setActiveAccounts((a) => ({ ...a, [provider]: id })),
        editResourceId,
        editCopyId,
        edit,
        command,
        refresh,
        busy,
        toast,
        notify,
      }}
    >
      {children}
    </Context.Provider>
  );
}
