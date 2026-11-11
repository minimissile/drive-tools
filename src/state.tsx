import { windowStorage } from "./storage/window-storage";
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
  navigationHistory,
  parseNavigationHistory,
  type NavigationHistory,
} from "./state/navigation-history";
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
  useReducer,
  useRef,
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
  | "intelligent-operations"
  | "photo-posts"
  | "distribution"
  | "workbench"
  | "baidu-discovery"
  | "zhidao-mine"
  | "zhidao-collect"
  | "zhidao-qa"
  | "zhidao-page-discovery"
  | "zhidao-templates"
  | "zhidao-publish"
  | "zhidao-accounts"
  | "drive-files"
  | "resource-answers"
  | "resource-export"
  | "resource-catalog"
  | "library"
  | "accounts"
  | "website-accounts"
  | "smzdm-accounts"
  | "smzdm-workflow"
  | "wechat-workflow"
  | "wechat-discovery"
  | "wechat-accounts"
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
  | "bilibili-content"
  | "bilibili-accounts"
  | "pipix-sources"
  | "zhihu-operations"
  | "tieba-autocare"
  | "tieba-publishing"
  | "tieba-analysis"
  | "settings"
  | "system-logs"
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
  goBack(): void;
  previousPage: Page | null;
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
  | "goBack"
  | "previousPage"
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
  "intelligent-operations",
  "photo-posts",
  "distribution",
  "workbench",
  "baidu-discovery",
  "zhidao-mine",
  "zhidao-collect",
  "zhidao-qa",
  "zhidao-page-discovery",
  "zhidao-templates",
  "zhidao-publish",
  "zhidao-accounts",
  "drive-files",
  "resource-answers",
  "resource-export",
  "resource-catalog",
  "library",
  "accounts",
  "website-accounts",
  "smzdm-accounts",
  "smzdm-workflow",
  "wechat-workflow",
  "wechat-discovery",
  "wechat-accounts",
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
  "bilibili-content",
  "bilibili-accounts",
  "zhihu-operations",
  "tieba-autocare",
  "tieba-publishing",
  "tieba-analysis",
  "settings",
  "system-logs",
  "bulk",
  "batch",
  "split",
  "search",
];
export type SettingsSection =
  | "sources"
  | "resource-links"
  | "ai"
  | "traffic"
  | "costs"
  | "notes"
  | "browser"
  | "bindings"
  | "maintenance";
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
  navigation?: NavigationHistory;
} {
  try {
    const raw = windowStorage.getItem("panxu-ui-v1");
    if (raw == null) return {};
    const data = JSON.parse(raw);
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
      navigation: parseNavigationHistory(data.navigation, pages),
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
  const [saved] = useState(() => {
    const saved = savedUi();
    const initial = window.panxu?.initialPage;
    return !saved.page && initial && pages.includes(initial as Page)
      ? { ...saved, page: initial as Page }
      : saved;
  });
  const { notify, clearToast, begin, end } = useFeedbackActions();
  const [navigation, dispatchNavigation] = useReducer(
    navigationHistory,
    saved.navigation ?? {
      current: {
        page: saved.page ?? "workbench",
        resourceId: saved.resourceId ?? "",
        copyId: saved.copyId ?? "",
        editResourceId: saved.editResourceId ?? null,
        editCopyId: saved.editCopyId ?? null,
        settingsSection: "ai",
        searchFocus: null,
      },
      past: [],
      workspace: null,
    },
  );
  const {
    page,
    resourceId: selectedResourceId,
    copyId: selectedCopyId,
    editResourceId,
    editCopyId,
    settingsSection,
    searchFocus,
  } = navigation.current;
  const navigationRequest = useRef(0);
  const navigate = useCallback((page: Page) => {
    navigationRequest.current++;
    dispatchNavigation({ type: "navigate", patch: { page } });
  }, []);
  const [extraResource, setExtraResource] = useState<Resource | null>(null),
    [activeAccounts, setActiveAccounts] = useState<Record<string, string>>(
      saved.activeAccounts ?? {},
    );
  const openSettings = useCallback((section: SettingsSection) => {
    navigationRequest.current++;
    dispatchNavigation({
      type: "navigate",
      patch: { page: "settings", settingsSection: section },
    });
  }, []);
  const {
    data,
    refresh,
    error: snapshotError,
    loading: snapshotLoading,
  } = useSnapshot(selectedResourceId);
  const workspacePath = data?.dataPath;
  const previousPage =
    navigation.workspace === workspacePath
      ? (navigation.past.at(-1)?.page ?? null)
      : null;
  const goBack = useCallback(() => {
    if (!workspacePath || navigation.workspace !== workspacePath) return;
    navigationRequest.current++;
    dispatchNavigation({ type: "back" });
  }, [workspacePath, navigation.workspace]);
  useEffect(() => {
    if (!workspacePath) return;
    navigationRequest.current++;
    dispatchNavigation({ type: "workspace", path: workspacePath });
  }, [workspacePath]);
  useEffect(() => {
    if (!workspacePath || navigation.workspace !== workspacePath) return;
    try {
      windowStorage.setItem(
        "panxu-ui-v1",
        JSON.stringify({
          page,
          resourceId: selectedResourceId,
          copyId: selectedCopyId,
          activeAccounts,
          editResourceId,
          editCopyId,
          navigation,
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
    workspacePath,
    navigation,
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
          dispatchNavigation({
            type: "update",
            patch: { resourceId: data.resources[0]?.id ?? "", copyId: "" },
          });
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
    navigationRequest.current++;
    dispatchNavigation({
      type: "update",
      patch: { resourceId, copyId: copyId ?? "" },
    });
  }, []);
  const edit = useCallback(
    (resourceId: string | null, copyId?: string) => {
      const request = ++navigationRequest.current;
      const patch = {
        page: "intake" as const,
        editResourceId: resourceId,
        editCopyId: copyId ?? null,
        ...(resourceId
          ? { resourceId, copyId: copyId === "new" ? "" : (copyId ?? "") }
          : {}),
      };
      if (resourceId && !data?.resources.some((r) => r.id === resourceId)) {
        void ipc("resource.get", { id: resourceId })
          .then((r) => {
            if (request !== navigationRequest.current) return;
            setExtraResource(r);
            dispatchNavigation({ type: "navigate", patch });
          })
          .catch((error) => {
            if (request === navigationRequest.current)
              notify(error.message, "error");
          });
      } else dispatchNavigation({ type: "navigate", patch });
    },
    [data?.resources, notify],
  );
  const openSearch = useCallback((focus: SearchFocus = {}) => {
    navigationRequest.current++;
    dispatchNavigation({
      type: "navigate",
      patch: { page: "search", searchFocus: focus },
    });
  }, []);
  const openDraft = useCallback(
    (draft: Draft, destination: "studio" | "publish" = "studio") => {
      navigationRequest.current++;
      windowStorage.setItem(
        "panxu-studio-selection-v1",
        JSON.stringify({
          id: draft.id,
          platform: draft.platform,
          copyId: draft.copyId,
          resourceId: draft.resourceId,
        }),
      );
      windowStorage.setItem("panxu-publish-draft", draft.id);
      dispatchNavigation({
        type: "navigate",
        patch: {
          page: destination,
          resourceId: draft.resourceId,
          copyId: draft.copyId,
        },
      });
    },
    [],
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
      navigate,
      goBack,
      previousPage,
      searchFocus,
      openSearch,
      openDraft,
      editResourceId,
      editCopyId,
      edit,
    }),
    [
      page,
      navigate,
      goBack,
      previousPage,
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
