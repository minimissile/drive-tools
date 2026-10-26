import { ArrowLeft, ChevronRight } from "lucide-react";
import { useAppNavigation } from "../state";
import { pageTitle, sidebarPage, workbenchEntries } from "../navigation";
import { operationEntries } from "../zhidao/navigation";
import { Button } from "../ui/primitives";
import { Select } from "../ui/Select";
import "./navigation.css";

const items = workbenchEntries.map((entry) => ({
  value: entry.page,
  label: operationEntries.some((operation) => operation.page === entry.page)
    ? `百度知道 · ${entry.title}`
    : entry.title,
}));

/** One return path and tool switcher for every operational page. */
export function WorkbenchNavigation() {
  const { page, navigate, edit } = useAppNavigation();
  const secondary = sidebarPage(page) === "workbench" && page !== "workbench";
  return (
    <nav className="workspace-breadcrumb" aria-label="当前位置">
      <span>我的工作空间</span>
      <ChevronRight size={13} aria-hidden="true" />
      {secondary ? (
        <>
          <Button
            quiet
            size="compact"
            aria-label="返回工作台"
            onClick={() => navigate("workbench")}
          >
            <ArrowLeft size={13} aria-hidden="true" />
            工作台
          </Button>
          <ChevronRight size={13} aria-hidden="true" />
          <Select
            className="workbench-tool-select"
            aria-label="切换工作台工具"
            aria-current="page"
            value={page === "bulk" ? "batch" : page}
            items={items}
            onValueChange={(value) => {
              const target = workbenchEntries.find(
                (entry) => entry.page === value,
              );
              if (!target || target.page === page) return;
              if (target.page === "intake") edit(null);
              else navigate(target.page);
            }}
          />
        </>
      ) : (
        <strong aria-current="page">{pageTitle(page)}</strong>
      )}
    </nav>
  );
}
