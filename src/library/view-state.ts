export interface LibraryView {
  query: string;
  category: string;
  accountId: string;
  page: number;
}
const defaults: LibraryView = {
  query: "",
  category: "all",
  accountId: "all",
  page: 1,
};
const key = (workspace: string) => `panxu-library-view-v1:${workspace}`;
export function readLibraryView(
  storage: Pick<Storage, "getItem">,
  workspace: string,
): LibraryView {
  try {
    const raw = JSON.parse(storage.getItem(key(workspace)) ?? "null");
    if (!raw || typeof raw !== "object") return { ...defaults };
    const text = (value: unknown, max: number, fallback: string) =>
      typeof value === "string" && value.length <= max ? value : fallback;
    return {
      query: text(raw.query, 200, ""),
      category: text(raw.category, 200, "all"),
      accountId: text(raw.accountId, 100, "all"),
      page:
        Number.isSafeInteger(raw.page) && raw.page > 0 && raw.page <= 100000
          ? raw.page
          : 1,
    };
  } catch {
    return { ...defaults };
  }
}
export function saveLibraryView(
  storage: Pick<Storage, "setItem">,
  workspace: string,
  view: LibraryView,
) {
  try {
    storage.setItem(key(workspace), JSON.stringify(view));
  } catch {
    /* A blocked local preference store must not interrupt resource work. */
  }
}
