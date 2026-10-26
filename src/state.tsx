import { TaskFocusProvider } from "./tasks/TaskFocus";
import { stableContext } from "./lib/stable-context";
import type { IpcMethod, IpcArguments, IpcValue } from "../shared/ipc";
import { ipc } from "./api/client";
import {
  FeedbackProvider,
  useFeedbackActions,
  useAppActivity,
  useAppToast,
} from "./state/feedback";
import { useSnapshot } from "./state/useSnapshot";
import {
  shouldRefreshSnapshot,
  type Command,
  type CommandArguments,
} from "./api/client";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type {
  AppSnapshot,
  Resource,
  ResourceCopy,
  Draft,
} from "../shared/types";
export type Page =
  | "workbench"
  | "zhidao-mine"
  | "zhidao-collect"
  | "zhidao-qa"
  | "zhidao-templates"
  | "zhidao-publish"
  | "zhidao-accounts"
  | "drive-files"
  | "resource-answers"
  | "resource-export"
  | "library"
  | "accounts"
  | "website-accounts"
  | "browser-environments"
  | "intake"
  | "tasks"
  | "traffic"
  | "share-statistics"
  | "studio"
  | "publish"
  | "csdn-studio"
  | "csdn-publish"
  | "csdn-workflow"
  | "weibo-marketing"
  | "settings"
  | "bulk"
  | "batch"
  | "split"
  | "search";
// Batch operations keep their own durable plans; navigation stores no credentials.
export interface SearchFocus {
  topicId?: string;
  poolId?: string;
  copyId?: string;
  splitItemId?: string;
}
interface Store {
  settingsSection: SettingsSection;
  openSettings(section: SettingsSection): void;
  searchFocus: SearchFocus | null;
  openSearch(focus?: SearchFocus): void;
  openDraft(draft: Draft, destination?: "studio" | "publish"): void;
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
  command: Command;
  refresh(): Promise<void>;
  busy: number;
  toast: ReturnType<typeof useAppToast>;
  notify: ReturnType<typeof useFeedbackActions>["notify"];
}
type DataStore = Pick<Store, "data">;
type SelectionStore = Pick<
  Store,
  | "resource"
  | "copy"
  | "selectedResourceId"
  | "selectedCopyId"
  | "activeAccounts"
  | "setActiveAccount"
  | "select"
>;
type NavigationStore = Pick<
  Store,
  | "settingsSection"
  | "openSettings"
  | "page"
  | "navigate"
  | "searchFocus"
  | "openSearch"
  | "openDraft"
  | "editResourceId"
  | "editCopyId"
  | "edit"
>;
type ActionStore = Pick<Store, "command" | "refresh" | "notify">;
const DataContext = stableContext<DataStore | null>("AppData", null);
const SelectionContext = stableContext<SelectionStore | null>(
  "AppSelection",
  null,
);
const NavigationContext = stableContext<NavigationStore | null>(
  "AppNavigation",
  null,
);
const ActionContext = stableContext<ActionStore | null>("AppActions", null);
function useRequired<T>(context: import("react").Context<T | null>): T {
  const value = useContext(context);
  if (!value) throw new Error("AppProvider missing");
  return value;
}
export const useAppData = () => useRequired(DataContext);
export const useAppSelection = () => useRequired(SelectionContext);
export const useAppNavigation = () => useRequired(NavigationContext);
export const useAppActions = () => useRequired(ActionContext);
export { useAppActivity } from "./state/feedback";
// Compatibility entry point. New components subscribe only to the state they use.
export function useApp(): Store {
  return {
    ...useAppData(),
    ...useAppSelection(),
    ...useAppNavigation(),
    ...useAppActions(),
    ...useAppActivity(),
    toast: useAppToast(),
  };
}
const pages: Page[] = [
  "workbench",
  "zhidao-mine",
  "zhidao-collect",
  "zhidao-qa",
  "zhidao-templates",
  "zhidao-publish",
  "zhidao-accounts",
  "drive-files",
  "resource-answers",
  "resource-export",
  "library",
  "accounts",
  "website-accounts",
  "browser-environments",
  "intake",
  "tasks",
  "traffic",
  "share-statistics",
  "studio",
  "publish",
  "csdn-studio",
  "csdn-publish",
  "csdn-workflow",
  "weibo-marketing",
  "settings",
  "bulk",
  "batch",
  "split",
  "search",
];
export type SettingsSection =
  "ai" | "traffic" | "notes" | "browser" | "bindings" | "maintenance";
const WorkspaceStatus = stableContext("WorkspaceStatus", {
  loading: true,
  error: "",
});
export const useWorkspaceStatus = () => useContext(WorkspaceStatus);
function savedUi(): {
  page?: Page;
  editResourceId?: string | null;
  editCopyId?: string | null;
  resourceId?: string;
  copyId?: string;
  activeAccounts?: Record<string, string>;
} {
  try {
    const data = JSON.parse(localStorage.getItem("panxu-ui-v1") ?? "{}");
    return {
      page: pages.includes(data.page) ? data.page : "workbench",
      editResourceId:
        typeof data.editResourceId === "string" ? data.editResourceId : null,
      editCopyId: typeof data.editCopyId === "string" ? data.editCopyId : null,
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
  return (
    <FeedbackProvider>
      <TaskFocusProvider>
        <WorkspaceProvider>{children}</WorkspaceProvider>
      </TaskFocusProvider>
    </FeedbackProvider>
  );
}
function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [saved] = useState(savedUi);
  const { notify, clearToast, begin, end } = useFeedbackActions();
  const [searchFocus, setSearchFocus] = useState<SearchFocus | null>(null);
  const [extraResource, setExtraResource] = useState<Resource | null>(null),
    [page, setPage] = useState<Page>(saved.page ?? "workbench"),
    [selectedResourceId, setResourceId] = useState(saved.resourceId ?? ""),
    [selectedCopyId, setCopyId] = useState(saved.copyId ?? ""),
    [activeAccounts, setActiveAccounts] = useState<Record<string, string>>(
      saved.activeAccounts ?? {},
    ),
    [editResourceId, setEditResourceId] = useState<string | null>(
      saved.editResourceId ?? null,
    ),
    [editCopyId, setEditCopyId] = useState<string | null>(
      saved.editCopyId ?? null,
    );
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("ai");
  const openSettings = useCallback((section: SettingsSection) => {
    setSettingsSection(section);
    setPage("settings");
  }, []);
  const {
    data,
    refresh,
    error: snapshotError,
    loading: snapshotLoading,
  } = useSnapshot(selectedResourceId);
  useEffect(() => {
    try {
      localStorage.setItem(
        "panxu-ui-v1",
        JSON.stringify({
          page,
          resourceId: selectedResourceId,
          copyId: selectedCopyId,
          activeAccounts,
          editResourceId,
          editCopyId,
        }),
      );
    } catch {
      /* A preference write must not crash the workspace. */
    }
  }, [
    page,
    selectedResourceId,
    selectedCopyId,
    activeAccounts,
    editResourceId,
    editCopyId,
  ]);
  const command = useCallback(
    async <M extends IpcMethod>(
      method: M,
      ...[args, success, throwErrors = false]: CommandArguments<M>
    ): Promise<IpcValue<M> | undefined> => {
      begin();
      clearToast();
      try {
        const result = await ipc(method, ...([args] as IpcArguments<M>));
        let refreshed = true;
        if (shouldRefreshSnapshot(method)) {
          try {
            await refresh();
          } catch {
            refreshed = false;
            notify(
              "操作已完成，但本地视图暂未刷新。请使用页面的重试读取，避免重复提交。",
              "warning",
            );
          }
        }
        if (success && refreshed)
          notify(
            typeof success === "string" ? success : success.text,
            typeof success === "string" ? "success" : success.tone,
          );
        return result;
      } catch (error) {
        notify(error instanceof Error ? error.message : "操作失败", "error");
        if (throwErrors) throw error;
        return undefined;
      } finally {
        end();
      }
    },
    [refresh, notify, begin, end, clearToast],
  );
  useEffect(() => {
    if (
      !data ||
      !selectedResourceId ||
      data.resources.some((r) => r.id === selectedResourceId)
    )
      return;
    let active = true;
    void ipc("resource.get", { id: selectedResourceId })
      .then((r) => {
        if (active) setExtraResource(r);
      })
      .catch((error) => {
        if (active) {
          notify(error.message, "error");
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
  const select = useCallback((resourceId: string, copyId?: string) => {
    setResourceId(resourceId);
    setCopyId(copyId ?? "");
  }, []);
  const edit = useCallback(
    (resourceId: string | null, copyId?: string) => {
      setEditResourceId(resourceId);
      setEditCopyId(copyId ?? null);
      if (resourceId) {
        setResourceId(resourceId);
        setCopyId(copyId === "new" ? "" : (copyId ?? ""));
      }
      if (resourceId && !data?.resources.some((r) => r.id === resourceId)) {
        void ipc("resource.get", { id: resourceId })
          .then((r) => {
            setExtraResource(r);
            setPage("intake");
          })
          .catch((error) => notify(error.message, "error"));
      } else setPage("intake");
    },
    [data?.resources, notify],
  );
  const openSearch = useCallback((focus: SearchFocus = {}) => {
    setSearchFocus(focus);
    setPage("search");
  }, []);
  const openDraft = useCallback(
    (draft: Draft, destination: "studio" | "publish" = "studio") => {
      select(draft.resourceId, draft.copyId);
      localStorage.setItem(
        "panxu-studio-selection-v1",
        JSON.stringify({
          id: draft.id,
          platform: draft.platform,
          copyId: draft.copyId,
          resourceId: draft.resourceId,
        }),
      );
      localStorage.setItem("panxu-publish-draft", draft.id);
      setPage(destination);
    },
    [select],
  );
  const setActiveAccount = useCallback(
    (provider: string, id: string) =>
      setActiveAccounts((a) => ({ ...a, [provider]: id })),
    [],
  );
  const dataValue = useMemo(() => ({ data }), [data]);
  const selectionValue = useMemo(
    () => ({
      resource,
      copy,
      selectedResourceId: selectedResourceId || resource?.id || "",
      selectedCopyId: copy?.id ?? "",
      activeAccounts,
      setActiveAccount,
      select,
    }),
    [
      resource,
      copy,
      selectedResourceId,
      activeAccounts,
      setActiveAccount,
      select,
    ],
  );
  const navigationValue = useMemo(
    () => ({
      page,
      settingsSection,
      openSettings,
      navigate: setPage,
      searchFocus,
      openSearch,
      openDraft,
      editResourceId,
      editCopyId,
      edit,
    }),
    [
      page,
      settingsSection,
      openSettings,
      searchFocus,
      openSearch,
      openDraft,
      editResourceId,
      editCopyId,
      edit,
    ],
  );
  const actionValue = useMemo(
    () => ({ command, refresh, notify }),
    [command, refresh, notify],
  );
  return (
    <WorkspaceStatus.Provider
      value={{ loading: snapshotLoading, error: snapshotError }}
    >
      <ActionContext.Provider value={actionValue}>
        <NavigationContext.Provider value={navigationValue}>
          <DataContext.Provider value={dataValue}>
            <SelectionContext.Provider value={selectionValue}>
              {children}
            </SelectionContext.Provider>
          </DataContext.Provider>
        </NavigationContext.Provider>
      </ActionContext.Provider>
    </WorkspaceStatus.Provider>
  );
}
