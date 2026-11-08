import { z } from "zod";
import type { Page, SearchFocus, SettingsSection } from "../state";

const historyLimit = 40;
export interface NavigationRoute {
  page: Page;
  resourceId: string;
  copyId: string;
  editResourceId: string | null;
  editCopyId: string | null;
  settingsSection: SettingsSection;
  searchFocus: SearchFocus | null;
}
export interface NavigationHistory {
  current: NavigationRoute;
  past: NavigationRoute[];
  workspace: string | null;
}
type NavigationAction =
  | { type: "navigate" | "update"; patch: Partial<NavigationRoute> }
  | { type: "back" }
  | { type: "workspace"; path: string };

function sameRoute(left: NavigationRoute, right: NavigationRoute) {
  return (
    left.page === right.page &&
    left.resourceId === right.resourceId &&
    left.copyId === right.copyId &&
    left.editResourceId === right.editResourceId &&
    left.editCopyId === right.editCopyId &&
    left.settingsSection === right.settingsSection &&
    left.searchFocus?.topicId === right.searchFocus?.topicId &&
    left.searchFocus?.poolId === right.searchFocus?.poolId &&
    left.searchFocus?.copyId === right.searchFocus?.copyId &&
    left.searchFocus?.splitItemId === right.searchFocus?.splitItemId
  );
}

export function navigationHistory(
  state: NavigationHistory,
  action: NavigationAction,
): NavigationHistory {
  if (action.type === "workspace") {
    return state.workspace === action.path
      ? state
      : { ...state, workspace: action.path, past: [] };
  }
  if (action.type === "back") {
    const previous = state.past.at(-1);
    return previous
      ? { ...state, current: previous, past: state.past.slice(0, -1) }
      : state;
  }
  const current = { ...state.current, ...action.patch };
  if (sameRoute(current, state.current)) return state;
  return {
    ...state,
    current,
    past:
      action.type === "update"
        ? state.past
        : [...state.past, state.current].slice(-historyLimit),
  };
}

/** Only local route identifiers are persisted, scoped by the caller's window storage. */
export function parseNavigationHistory(
  value: unknown,
  pages: readonly Page[],
): NavigationHistory | undefined {
  const identifier = z.string().max(400);
  const route = z.object({
    page: z.custom<Page>(
      (value) => typeof value === "string" && pages.includes(value as Page),
    ),
    resourceId: identifier,
    copyId: identifier,
    editResourceId: identifier.nullable(),
    editCopyId: identifier.nullable(),
    settingsSection: z.enum([
      "sources",
      "resource-links",
      "ai",
      "traffic",
      "costs",
      "notes",
      "browser",
      "bindings",
      "maintenance",
    ]),
    searchFocus: z
      .object({
        topicId: identifier.optional(),
        poolId: identifier.optional(),
        copyId: identifier.optional(),
        splitItemId: identifier.optional(),
      })
      .nullable(),
  });
  const result = z
    .object({
      current: route,
      past: z.array(route).max(historyLimit),
      workspace: z.string().max(4000).nullable(),
    })
    .safeParse(value);
  return result.success ? result.data : undefined;
}
