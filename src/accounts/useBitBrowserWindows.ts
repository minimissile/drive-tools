import { useMemo, useState } from "react";
import { useIpcQuery } from "../api/useIpcQuery";
import type { BrowserEnvironmentView } from "../../shared/browser-environments";

export function useBitBrowserWindows(
  connector: string,
  environments: BrowserEnvironmentView[] | null,
) {
  const query = useIpcQuery("bit.profiles", undefined, {
    enabled: !!connector,
    revision: connector,
    keepPrevious: true,
  });
  const [search, setSearch] = useState("");
  const [running, setRunning] = useState("all");
  const [registered, setRegistered] = useState("all");
  const [group, setGroup] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const snapshot = query.data?.connectorKey === connector ? query.data : null;
  const environmentMap = useMemo(
    () =>
      new Map(
        (environments ?? [])
          .filter((env) => env.engine === "bitbrowser")
          .map((env) => [env.profileId, env]),
      ),
    [environments],
  );
  const groups = useMemo(() => {
    const values = new Map<string, string>();
    for (const profile of snapshot?.windows ?? [])
      if (profile.groupId)
        values.set(
          profile.groupId,
          profile.groupName || `分组 ${profile.groupId}`,
        );
    return [...values].sort((a, b) => a[1].localeCompare(b[1], "zh-CN"));
  }, [snapshot]);
  const filtered = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase();
    return (snapshot?.windows ?? []).filter((profile) => {
      const env = environmentMap.get(profile.id);
      if (running === "running" && profile.running !== true) return false;
      if (running === "closed" && profile.running !== false) return false;
      if (running === "unknown" && profile.running !== null) return false;
      if (registered === "yes" && !env) return false;
      if (registered === "no" && env) return false;
      if (
        group !== "all" &&
        (group === "none" ? !!profile.groupId : profile.groupId !== group)
      )
        return false;
      return (
        !keyword ||
        [
          profile.name,
          profile.id,
          profile.seq,
          profile.remark,
          profile.groupName,
          env?.name,
        ].some((value) =>
          String(value ?? "")
            .toLocaleLowerCase()
            .includes(keyword),
        )
      );
    });
  }, [snapshot, environmentMap, search, running, registered, group]);
  const currentPage = Math.min(
    page,
    Math.max(1, Math.ceil(filtered.length / pageSize)),
  );
  const change = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    setPage(1);
  };
  return {
    ...query,
    snapshot,
    environmentMap,
    groups,
    filtered,
    rows: filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    page: currentPage,
    setPage,
    pageSize,
    setPageSize: (size: number) => {
      setPageSize(size);
      setPage(1);
    },
    search,
    setSearch: change(setSearch),
    running,
    setRunning: change(setRunning),
    registered,
    setRegistered: change(setRegistered),
    group,
    setGroup: change(setGroup),
    hasFilters:
      !!search.trim() ||
      running !== "all" ||
      registered !== "all" ||
      group !== "all",
    clearFilters: () => {
      setSearch("");
      setRunning("all");
      setRegistered("all");
      setGroup("all");
      setPage(1);
    },
  };
}
